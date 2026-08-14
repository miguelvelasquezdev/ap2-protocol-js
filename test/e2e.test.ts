import { describe, expect, it } from "vitest";
import {
  checkPaymentConstraints,
  computeReceiptReference,
  computeSha256B64url,
  createMandate,
  createPaymentReceipt,
  getClosedMandateJwt,
  parsePaymentMandateChain,
  parseToken,
  presentMandate,
  computeSdHash,
  signReceipt,
  verifyMandate,
  verifyPaymentMandateChain,
  verifyReceipt,
  type PublicKeyProvider,
} from "../src/index.ts";
import { cnf, counterSalts, FROZEN_NOW, makeKeypair, samplePaymentMandate } from "./fixtures.ts";

/**
 * The full human-not-present payment flow, end to end:
 *   agent issues an open payment mandate (constraints + cnf) ->
 *   holder presents the closed payment mandate ->
 *   verifier walks the chain, types it, evaluates constraints ->
 *   PSP issues a receipt bound to the closed mandate ->
 *   caller verifies the receipt against its store.
 */
describe("e2e human-not-present payment flow", () => {
  it("runs the whole lifecycle and the receipt binds to the chain", async () => {
    const issuer = await makeKeypair("agent-provider");
    const holder = await makeKeypair("agent");
    const psp = await makeKeypair("psp");

    // The agent-provider issues the open mandate. Its payment.reference pins
    // the checkout by the open checkout hash; amount_range + budget bound the
    // amount (budget.max is MAJOR units).
    const checkoutJwt = "eyJhbGciOiJFUzI1NiJ9.eyJpZCI6ImNoZWNrb3V0LTEifQ.sig";
    const openCheckoutHash = await computeSha256B64url("open-checkout-segment");
    const transactionId = await computeSha256B64url(checkoutJwt);

    const openMandate = await createMandate({
      payload: {
        vct: "mandate.payment.open.1",
        constraints: [
          { type: "payment.reference", conditional_transaction_id: openCheckoutHash },
          { type: "payment.amount_range", currency: "USD", min: 100, max: 30000 },
          { type: "payment.budget", currency: "USD", max: 500 },
        ],
        cnf: cnf(holder.publicJwk),
      },
      issuerKey: issuer.privateJwk,
      saltSource: counterSalts(),
    });

    // The holder presents the closed payment mandate.
    const chain = await presentMandate({
      holderKey: holder.privateJwk,
      mandateToken: openMandate,
      payload: samplePaymentMandate({ transaction_id: transactionId }),
      aud: "credential-provider",
      nonce: "nonce-xyz",
      saltSource: counterSalts(),
      nowSeconds: FROZEN_NOW,
    });

    // The verifier walks the chain.
    const resolveKey: PublicKeyProvider = () => issuer.publicJwk;
    const verified = await verifyMandate({
      token: chain,
      resolveKey,
      expectedAud: "credential-provider",
      expectedNonce: "nonce-xyz",
      nowSeconds: FROZEN_NOW,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok || verified.value.kind !== "chain") throw new Error("chain expected");
    expect(verified.value.payloads.length).toBe(2);

    // Type the chain and evaluate constraints against real context.
    const parsed = parsePaymentMandateChain(verified.value.payloads);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error.message);

    const violations = await verifyPaymentMandateChain(parsed.value, {
      expectedTransactionId: transactionId,
      expectedOpenCheckoutHash: openCheckoutHash,
      checkoutJwt, // recompute-don't-trust: transaction_id must == sha256(checkoutJwt)
      context: { totalAmount: 0, totalUses: 0 },
    });
    expect(violations).toEqual([]);

    // The PSP issues a receipt bound to the closed mandate.
    const reference = await computeReceiptReference(chain);
    expect(reference).toBe(await computeSha256B64url(getClosedMandateJwt(chain)));
    const receipt = createPaymentReceipt({
      paymentMandate: parsed.value.closedMandate,
      reference,
      nowSeconds: FROZEN_NOW,
    });
    const receiptJwt = await signReceipt(receipt, psp.privateJwk);

    // A store keyed by reference confirms the receipt.
    const store = new Set([reference]);
    const receiptResult = await verifyReceipt({
      receiptJwt,
      issuerKey: psp.publicJwk,
      hasReference: (r) => store.has(r),
      kind: "payment",
    });
    expect(receiptResult.ok).toBe(true);
  });

  it("rejects the chain when the amount breaches the range", async () => {
    const issuer = await makeKeypair("agent-provider");
    const holder = await makeKeypair("agent");
    const openMandate = await createMandate({
      payload: {
        vct: "mandate.payment.open.1",
        constraints: [
          { type: "payment.reference", conditional_transaction_id: "chk" },
          { type: "payment.amount_range", currency: "USD", min: 100, max: 1000 },
        ],
        cnf: cnf(holder.publicJwk),
      },
      issuerKey: issuer.privateJwk,
      saltSource: counterSalts(),
    });
    const chain = await presentMandate({
      holderKey: holder.privateJwk,
      mandateToken: openMandate,
      payload: samplePaymentMandate({ payment_amount: { currency: "USD", amount: 27999 } }),
      aud: "cp",
      nonce: "n",
      saltSource: counterSalts(),
      nowSeconds: FROZEN_NOW,
    });
    const verified = await verifyMandate({
      token: chain,
      resolveKey: () => issuer.publicJwk,
      expectedAud: "cp",
      expectedNonce: "n",
      nowSeconds: FROZEN_NOW,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok || verified.value.kind !== "chain") throw new Error("chain expected");
    const parsed = parsePaymentMandateChain(verified.value.payloads);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const violations = await verifyPaymentMandateChain(parsed.value, { expectedOpenCheckoutHash: "chk" });
    expect(violations.some((m) => m.includes("above max"))).toBe(true);
  });
});

describe("amount_range and budget boundaries", () => {
  const closed = samplePaymentMandate({ payment_amount: { currency: "USD", amount: 1000 } }) as never;
  function open(constraints: unknown[]) {
    return {
      vct: "mandate.payment.open.1",
      constraints,
      cnf: { jwk: {} },
    } as never;
  }

  it("passes exactly at min and max (inclusive)", () => {
    const v = checkPaymentConstraints(
      open([
        { type: "payment.reference", conditional_transaction_id: "c" },
        { type: "payment.amount_range", currency: "USD", min: 1000, max: 1000 },
      ]),
      closed,
      { openCheckoutHash: "c" },
    );
    expect(v).toEqual([]);
  });

  it("budget passes exactly at the limit (major x100)", () => {
    // amount 1000 minor; budget max 10.00 major => 1000 minor; equal passes.
    const v = checkPaymentConstraints(
      open([
        { type: "payment.reference", conditional_transaction_id: "c" },
        { type: "payment.budget", currency: "USD", max: 10 },
      ]),
      closed,
      { openCheckoutHash: "c", context: { totalAmount: 0 } },
    );
    expect(v).toEqual([]);
  });

  it("budget fails one minor unit over the limit", () => {
    const v = checkPaymentConstraints(
      open([
        { type: "payment.reference", conditional_transaction_id: "c" },
        { type: "payment.budget", currency: "USD", max: 10 },
      ]),
      closed,
      { openCheckoutHash: "c", context: { totalAmount: 1 } },
    );
    expect(v.some((m) => m.includes("exceeds budget"))).toBe(true);
  });
});

describe("open checkout hash derivation matches the reference convention", () => {
  it("compute_sd_hash of the open segment feeds payment.reference", async () => {
    const issuer = await makeKeypair("issuer");
    const open = await createMandate({
      payload: {
        vct: "mandate.payment.open.1",
        constraints: [{ type: "payment.reference", conditional_transaction_id: "x" }],
        cnf: { jwk: {} },
      },
      issuerKey: issuer.privateJwk,
      saltSource: counterSalts(),
    });
    const hash = await computeSdHash(parseToken(open));
    expect(hash).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
