/**
 * Receipts: verifiers sign a Receipt back after verifying a mandate.
 * Receipts are plain ES256 JWTs (not SD-JWTs). The canonical binding is
 * reference = base64url(sha256(closed mandate JWT)).
 * Note: the `hasReference` callback is REQUIRED here (the Python signature
 * marks it optional but invokes it unconditionally).
 */
import {
  computeSha256B64url,
  createJwt,
  verifyJwt,
  type Jwk,
} from "../crypto/index.ts";
import { err, ok, type Result } from "../errors.ts";
import { getClosedMandateJwt } from "../mandate/index.ts";
import {
  CheckoutReceiptSchema,
  PaymentReceiptSchema,
  type CheckoutReceipt,
  type PaymentMandate,
  type PaymentReceipt,
} from "../schemas/index.ts";

/** The receipt `reference` for a presentation: sha256 of its closed JWT. */
export function computeReceiptReference(presentationToken: string): Promise<string> {
  return computeSha256B64url(getClosedMandateJwt(presentationToken));
}

export interface CreatePaymentReceiptOptions {
  /** The verified closed Payment Mandate contents. */
  readonly paymentMandate: PaymentMandate;
  readonly reference: string;
  /**
   * Who issued (signed) this receipt — becomes its `iss`. REQUIRED: an audit
   * artifact whose issuer is empty has little probative value. Use your wallet /
   * verifier identity (e.g. the signing key's domain or a stable kid). Mirrors
   * `merchant` on the checkout receipt.
   */
  readonly issuer: string;
  /**
   * The PSP's REAL confirmation id — reused across payment_id /
   * psp_confirmation_id / network_confirmation_id. REQUIRED: previously this
   * defaulted to a random UUID, which fabricated a plausible-looking id that
   * could not be joined to the charge the receipt certifies — the one thing an
   * audit artifact must never do. If you do not yet have the PSP's id, do not
   * mint the receipt.
   */
  readonly confirmationId: string;
  readonly nowSeconds?: number;
}

export function createPaymentReceipt(options: CreatePaymentReceiptOptions): PaymentReceipt {
  const id = options.confirmationId;
  return {
    status: "Success",
    iss: options.issuer,
    iat: options.nowSeconds ?? Math.floor(Date.now() / 1000),
    reference: options.reference,
    payment_id: id,
    psp_confirmation_id: id,
    network_confirmation_id: id,
  };
}

export interface CreateCheckoutReceiptOptions {
  readonly merchant: string;
  readonly reference: string;
  readonly orderId: string;
  readonly nowSeconds?: number;
}

export function createCheckoutReceipt(options: CreateCheckoutReceiptOptions): CheckoutReceipt {
  return {
    status: "Success",
    iss: options.merchant,
    iat: options.nowSeconds ?? Math.floor(Date.now() / 1000),
    reference: options.reference,
    order_id: options.orderId,
  };
}

/** Sign a receipt as a plain ES256 JWT. */
export function signReceipt(
  receipt: PaymentReceipt | CheckoutReceipt,
  signingKey: Jwk,
): Promise<string> {
  return createJwt(
    { typ: "JWT", ...(signingKey.kid ? { kid: signingKey.kid } : {}) },
    receipt as unknown as Record<string, unknown>,
    signingKey,
  );
}

export interface VerifyReceiptOptions {
  readonly receiptJwt: string;
  readonly issuerKey: Jwk;
  /** Does this reference exist in your mandate store? REQUIRED. */
  readonly hasReference: (reference: string) => boolean | Promise<boolean>;
  readonly kind: "payment" | "checkout";
}

/** Verify a receipt JWT: signature, schema, and reference lookup. */
export async function verifyReceipt(
  options: VerifyReceiptOptions,
): Promise<Result<PaymentReceipt | CheckoutReceipt>> {
  let payload: Record<string, unknown>;
  try {
    payload = await verifyJwt(options.receiptJwt, options.issuerKey);
  } catch {
    return err("signature_invalid", "Receipt signature verification failed");
  }
  const schema = options.kind === "payment" ? PaymentReceiptSchema : CheckoutReceiptSchema;
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return err("payload_invalid", `Receipt failed schema validation: ${parsed.error.message}`);
  }
  const receipt = parsed.data;
  if (!(await options.hasReference(receipt.reference))) {
    return err("payload_invalid", "Receipt reference not found in store");
  }
  return ok(receipt);
}
