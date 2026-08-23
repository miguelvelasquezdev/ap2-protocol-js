/**
 * The AP2 mandate layer of this sample — the part worth reading if you want to
 * understand AP2.
 *
 * WHAT AP2 GIVES YOU: a cryptographic answer to "did a human actually authorize
 * this exact purchase, and is this agent allowed to make it?" — verifiable by a
 * merchant or PSP who does not trust the agent at all.
 *
 * THE TWO MANDATES
 *   1. OPEN payment mandate  (`mandate.payment.open.1`)
 *      The user's authorization, signed by their WALLET. It is key-bound to the
 *      shopping agent via `cnf`, so only that agent can spend against it, and it
 *      carries CONSTRAINTS that bound what may be spent (amount, payee, which
 *      checkout it belongs to).
 *   2. CLOSED payment mandate (`mandate.payment.1`)
 *      The actual purchase, signed by the AGENT on top of the open mandate
 *      (an SD-JWT key-binding hop). It states the real amount, payee and
 *      instrument, and is addressed to one verifier (`aud`) with a fresh
 *      `nonce` — that pair is the replay defense.
 *
 * The two are joined with `~~` into ONE presentation string. The payment
 * processor verifies the whole chain plus the constraints in a single call
 * (`verifyPaymentMandate`) and fails closed on either.
 *
 * WHY IT'S SAFE EVEN THOUGH THE AGENT IS AN LLM: the agent can say anything,
 * but it cannot forge the wallet's signature, cannot widen the constraints the
 * wallet signed, and cannot replay a mandate to a different verifier. The spec
 * assumes every agent is a potential attacker; verification is what makes that
 * assumption survivable.
 */
import {
  VCT,
  computeSha256B64url,
  createMandate,
  presentMandate,
  type Jwk,
} from "ap2-protocol-js";
import { AP2_VERIFIER, verifyViaGateway, verifyViaSdk } from "./verifier.js";
import type { CartMandate } from "../types/cart-mandate.js";
import type { PaymentMandate } from "../types/payment-mandate.js";
import { getAp2Keys } from "./keys.js";
import { jwtEncode, makeSigner } from "./jwt.js";

/** The verifier this presentation is addressed to (AP2 `aud`). */
export const PAYMENT_PROCESSOR_AUD = "http://localhost:8003";

/** Identity the wallet issues under, and the payee website used in the demo. */
export const WALLET_ISS = "https://wallet.ap2.example";
export const MERCHANT_WEBSITE = "https://demo-merchant.ap2.example";

export type PaymentMandateContents = PaymentMandate["paymentMandateContents"];

/**
 * AP2 amounts are integers in the currency's MINOR unit (cents), while the W3C
 * PaymentRequest shape used by the surrounding sample uses major units (29.99).
 */
export function toMinorUnits(value: number): number {
  return Math.round(value * 100);
}

/** The replay nonce: the AP2 payment mandate id — stable and recomputable by
 * both the signer and the verifier, and unique per purchase. */
export function nonceFor(contents: PaymentMandateContents): string {
  return contents.paymentMandateId;
}

/**
 * The merchant's signed checkout: a plain ES256 JWT over the cart essentials.
 * Its hash is what binds the mandate chain to THIS cart — the verifier
 * recomputes that hash rather than trusting any id in the token.
 */
async function buildCheckoutJwt(
  cartMandate: CartMandate,
  contents: PaymentMandateContents,
  merchantPrivateKey: Jwk,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const cart = cartMandate.contents;
  const total = contents.paymentDetailsTotal.amount;
  const signer = await makeSigner(merchantPrivateKey);
  return jwtEncode(
    { alg: "ES256", typ: "JWT", kid: "ap2-demo-merchant-1" },
    {
      iss: cart.merchantName,
      sub: "cart_checkout",
      iat: now,
      exp: now + 3600,
      cart: {
        id: cart.id,
        items: cart.paymentRequest.details.displayItems.map((i) => i.label),
        total: { currency: total.currency, value: total.value },
      },
    },
    signer,
  );
}

/**
 * Build the AP2 presentation for one approved purchase: mint the open mandate
 * (the user's authorization + constraints), then present the closed mandate
 * (the purchase) on top of it. Returns the `~~`-joined chain, which the sample
 * carries in the AP2 PaymentMandate's `userAuthorization` field.
 *
 * In production the OPEN mandate is minted by the user's wallet on their device
 * (that is what makes the key user-held); here both keys are demo keys on one
 * machine, so this proves the protocol, not key custody.
 */
export async function createUserAuthorization(args: {
  cartMandate: CartMandate;
  paymentMandateContents: PaymentMandateContents;
}): Promise<string> {
  const { cartMandate, paymentMandateContents: contents } = args;
  const keys = await getAp2Keys();
  const total = contents.paymentDetailsTotal.amount;
  const amountMinor = toMinorUnits(total.value);

  const checkoutJwt = await buildCheckoutJwt(
    cartMandate,
    contents,
    keys.merchant.privateKey,
  );
  // Recompute-don't-trust: the binding value is the HASH of the merchant's
  // signed checkout, so it cannot be pointed at a different cart later.
  const checkoutHash = await computeSha256B64url(checkoutJwt);

  const payee = { id: contents.merchantAgent, name: contents.merchantAgent, website: MERCHANT_WEBSITE };

  // ── 1. OPEN MANDATE — what the user authorizes, and its limits. ──
  const openMandate = await createMandate({
    payload: {
      vct: VCT.openPaymentMandate,
      constraints: [
        // Pin this authorization to exactly this checkout.
        { type: "payment.reference", conditional_transaction_id: checkoutHash },
        // Pin the amount exactly (min === max). A wider mandate would set a range.
        { type: "payment.amount_range", currency: total.currency, min: amountMinor, max: amountMinor },
        // Only this merchant may be paid.
        { type: "payment.allowed_payees", allowed: [payee] },
      ],
      // Key binding: only the shopping agent's key can present against this.
      cnf: { jwk: keys.agent.publicKey },
      payee,
    },
    issuerKey: keys.wallet.privateKey,
  });

  // ── 2. CLOSED MANDATE — the actual purchase, signed by the agent. ──
  const presentation = await presentMandate({
    holderKey: keys.agent.privateKey,
    mandateToken: openMandate,
    payload: {
      vct: VCT.paymentMandate,
      transaction_id: checkoutHash,
      payee,
      payment_amount: { currency: total.currency, amount: amountMinor },
      payment_instrument: {
        id: contents.paymentResponse.requestId,
        type: contents.paymentResponse.methodName,
      },
    },
    aud: PAYMENT_PROCESSOR_AUD, // who may verify this
    nonce: nonceFor(contents), // freshness — blocks replay
  });

  // The checkout JWT travels with the chain so the verifier can recompute the
  // binding hash instead of trusting `transaction_id`.
  return JSON.stringify({ mandate: presentation, checkoutJwt });
}

export interface Ap2VerificationResult {
  valid: boolean;
  errors: string[];
  /** Present when valid: what the mandate actually authorized. */
  authorized?: { amountMinor: number; currency: string; payee: string };
}

/**
 * Verify an incoming presentation — the payment processor's gate.
 *
 * `verifyPaymentMandate` fails closed on BOTH layers at once: the SD-JWT chain
 * (wallet signature, agent key-binding, aud/nonce, expiry) AND the constraints
 * the wallet signed (amount, payee, checkout reference). `if (result.ok)` is a
 * safe authorization gate — but authentic is not the same as "authorizes THIS
 * charge", so we still cross-check the amount and payee against the order the
 * PSP is about to process.
 */
export async function verifyUserAuthorization(
  userAuthorization: string | undefined,
  contents: PaymentMandateContents,
  expectedAud: string = PAYMENT_PROCESSOR_AUD,
): Promise<Ap2VerificationResult> {
  if (!userAuthorization) {
    return { valid: false, errors: ["missing userAuthorization"] };
  }

  let bundle: { mandate?: unknown; checkoutJwt?: unknown };
  try {
    bundle = JSON.parse(userAuthorization) as typeof bundle;
  } catch {
    return { valid: false, errors: ["userAuthorization is not a JSON bundle"] };
  }
  if (typeof bundle.mandate !== "string" || typeof bundle.checkoutJwt !== "string") {
    return {
      valid: false,
      errors: ["userAuthorization must carry { mandate, checkoutJwt } strings"],
    };
  }

  try {
    const keys = await getAp2Keys();
    // Recompute the binding from the merchant's signed checkout — never trust
    // an identifier that arrived inside the token.
    const checkoutHash = await computeSha256B64url(bundle.checkoutJwt);

    const verifyOptions = {
      token: bundle.mandate,
      // The wallet's PUBLIC key. In production you resolve this from a JWKS /
      // registry keyed by the token's `kid` — never from the token itself.
      issuerKey: keys.wallet.publicKey,
      expectedAud,
      expectedNonce: nonceFor(contents),
      expectedOpenCheckoutHash: checkoutHash,
    };

    // Two ways to reach the SAME cryptographic decision — pick with
    // AP2_VERIFIER (see ./verifier.ts). The gateway path delegates to this very
    // SDK, so a mandate accepted by one is accepted by the other.
    const outcome =
      AP2_VERIFIER === "gateway"
        ? await verifyViaGateway(verifyOptions)
        : await verifyViaSdk(verifyOptions);

    if (!outcome.ok) {
      return { valid: false, errors: [outcome.error] };
    }

    // Authentic ≠ authorizes this charge: compare what the mandate SAYS with
    // what the processor is about to do.
    const closed = outcome.closedMandate;
    const errors: string[] = [];
    const expectedAmount = toMinorUnits(contents.paymentDetailsTotal.amount.value);
    const expectedCurrency = contents.paymentDetailsTotal.amount.currency;
    if (
      closed.payment_amount.amount !== expectedAmount ||
      closed.payment_amount.currency !== expectedCurrency
    ) {
      errors.push(
        `mandate authorizes ${closed.payment_amount.amount} ${closed.payment_amount.currency}, ` +
          `order is ${expectedAmount} ${expectedCurrency}`,
      );
    }
    const payeeName = closed.payee?.name ?? "";
    if (payeeName.toLowerCase() !== contents.merchantAgent.toLowerCase()) {
      errors.push(`mandate payee ${payeeName} does not match merchant ${contents.merchantAgent}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      ...(errors.length === 0
        ? {
            authorized: {
              amountMinor: closed.payment_amount.amount,
              currency: closed.payment_amount.currency,
              payee: payeeName,
            },
          }
        : {}),
    };
  } catch (err) {
    // The SDK is fail-closed and should not throw; reaching here means key
    // loading or JSON assembly failed — still a denial, never a crash.
    return { valid: false, errors: [`verification threw: ${(err as Error).message}`] };
  }
}
