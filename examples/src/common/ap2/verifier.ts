/**
 * TWO WAYS TO VERIFY THE SAME AP2 MANDATE.
 *
 * Choose with the AP2_VERIFIER environment variable:
 *
 *   AP2_VERIFIER=sdk       (default) verify by calling ap2-protocol-js directly
 *   AP2_VERIFIER=gateway             verify through agentic-checkout's ap2 adapter
 *
 * The cryptographic decision is IDENTICAL, and not by coincidence: the
 * `@agentic-checkout/ap2` adapter performs no crypto of its own — it calls the
 * very same `ap2-protocol-js` functions this file calls in the `sdk` path. A
 * mandate accepted by one path is accepted by the other; a forged one is
 * rejected by both.
 *
 * What the gateway path adds around that decision:
 *   · ONE fail-closed choke point shared with other protocols (ucp/tap/kya)
 *   · a uniform typed verdict + deny code regardless of protocol
 *   · `audit.recordHash` — a canonical hash of the verdict, the thing to persist
 *   · an input-size cap and a verify timeout, applied before/around the adapter
 *
 * Both paths return the same small shape so the caller does not care which ran.
 */
import {
  verifyPaymentMandate,
  type Jwk,
  type PaymentMandate,
} from "ap2-protocol-js";
import { verifyCredential } from "agentic-checkout";
import { ap2 } from "@agentic-checkout/ap2";

export type Ap2VerifierMode = "sdk" | "gateway";

export const AP2_VERIFIER: Ap2VerifierMode =
  process.env.AP2_VERIFIER === "gateway" ? "gateway" : "sdk";

export interface VerifyInput {
  token: string;
  issuerKey: Jwk;
  expectedAud: string;
  expectedNonce: string;
  expectedOpenCheckoutHash: string;
}

export type VerifyOutcome =
  | { ok: true; closedMandate: PaymentMandate; recordHash?: string }
  | { ok: false; error: string };

/** Path A — the SDK directly. One call, fails closed on crypto AND constraints. */
export async function verifyViaSdk(input: VerifyInput): Promise<VerifyOutcome> {
  console.log("[ap2] verifying via SDK (ap2-protocol-js)");
  const result = await verifyPaymentMandate({
    token: input.token,
    resolveKey: () => input.issuerKey,
    expectedAud: input.expectedAud,
    expectedNonce: input.expectedNonce,
    expectedOpenCheckoutHash: input.expectedOpenCheckoutHash,
  });
  if (!result.ok) {
    return { ok: false, error: `${result.error.code}: ${result.error.message}` };
  }
  return { ok: true, closedMandate: result.value.chain.closedMandate };
}

/**
 * Path B — through the agentic-checkout pipeline with the ap2 adapter. Same
 * decision, wrapped in the gateway's guarantees; the verdict carries the audit
 * anchor and a protocol-agnostic deny code.
 */
export async function verifyViaGateway(input: VerifyInput): Promise<VerifyOutcome> {
  console.log("[ap2] verifying via GATEWAY (agentic-checkout + @agentic-checkout/ap2)");
  const verdict = await verifyCredential({
    credential: JSON.stringify({ mandate: input.token }),
    verifier: ap2({
      issuerKey: input.issuerKey,
      expectedAud: input.expectedAud,
      expectedNonce: input.expectedNonce,
      expectedOpenCheckoutHash: input.expectedOpenCheckoutHash,
    }),
  });
  if (!verdict.trusted) {
    return { ok: false, error: `${verdict.reason.code}: ${verdict.reason.message}` };
  }
  // The adapter surfaces the verified mandates on the verdict's claims.
  const closed = (verdict.claims as { closedMandate?: PaymentMandate } | undefined)?.closedMandate;
  if (!closed) {
    return { ok: false, error: "gateway verdict carried no closed mandate" };
  }
  return { ok: true, closedMandate: closed, recordHash: verdict.audit.recordHash };
}
