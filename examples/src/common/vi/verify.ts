/**
 * Verifies the Verifiable Intent `userAuthorization` bundle on an incoming
 * AP2 PaymentMandate: L1→L2 SD-JWT chain verification plus a cross-check of
 * the disclosed L2 payment amount/currency against the mandate contents.
 */
import { decodeSdJwt, verifyChain, type SdJwt } from "@verifiable-intent/core";
import { getViKeys } from "./keys.js";
import {
  PAYMENT_PROCESSOR_AUD,
  l2NonceFor,
  toMinorUnits,
  type PaymentMandateContents,
} from "./user-authorization.js";

export interface ViVerificationResult {
  valid: boolean;
  errors: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Find the disclosed L2 payment mandate (vct "mandate.payment.1"). */
function disclosedPaymentMandate(l2: SdJwt): Record<string, unknown> | null {
  for (const values of l2.disclosureValues) {
    const value = Array.isArray(values) ? values[values.length - 1] : null;
    if (isObject(value) && value.vct === "mandate.payment.1") return value;
  }
  return null;
}

export async function verifyUserAuthorization(
  userAuthorization: string | undefined,
  paymentMandateContents: PaymentMandateContents,
  expectedAud: string = PAYMENT_PROCESSOR_AUD
): Promise<ViVerificationResult> {
  if (!userAuthorization) {
    return { valid: false, errors: ["missing userAuthorization"] };
  }

  let bundle: { l1?: unknown; l2?: unknown };
  try {
    bundle = JSON.parse(userAuthorization) as { l1?: unknown; l2?: unknown };
  } catch {
    return { valid: false, errors: ["userAuthorization is not a JSON bundle"] };
  }
  if (typeof bundle.l1 !== "string" || typeof bundle.l2 !== "string") {
    return {
      valid: false,
      errors: ["userAuthorization bundle must contain l1 and l2 SD-JWT strings"],
    };
  }

  let l1: SdJwt;
  let l2: SdJwt;
  try {
    l1 = decodeSdJwt(bundle.l1);
    l2 = decodeSdJwt(bundle.l2);
  } catch (err) {
    return {
      valid: false,
      errors: [`failed to decode SD-JWT bundle: ${(err as Error).message}`],
    };
  }

  const keys = await getViKeys();
  const chain = await verifyChain(l1, l2, {
    issuerPublicJwk: keys.issuer.publicKey,
    l1Serialized: bundle.l1,
    expectedL2Aud: expectedAud,
    expectedL2Nonce: l2NonceFor(paymentMandateContents),
  });

  const errors = [...chain.errors];

  // Cross-check the disclosed L2 payment values against the AP2 mandate.
  const paymentMandate = disclosedPaymentMandate(l2);
  const expected = paymentMandateContents.paymentDetailsTotal.amount;
  const disclosed = paymentMandate?.payment_amount;
  if (!isObject(disclosed)) {
    errors.push("no disclosed payment mandate amount in L2");
  } else if (
    disclosed.currency !== expected.currency ||
    disclosed.amount !== toMinorUnits(expected.value)
  ) {
    errors.push(
      `disclosed payment amount ${String(disclosed.amount)} ${String(
        disclosed.currency
      )} does not match mandate ${toMinorUnits(expected.value)} ${expected.currency}`
    );
  }

  return { valid: chain.valid && errors.length === 0, errors };
}
