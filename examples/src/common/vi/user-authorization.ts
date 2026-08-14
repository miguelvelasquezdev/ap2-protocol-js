/**
 * Builds the Verifiable Intent `userAuthorization` bundle for an AP2
 * PaymentMandate: an L2 immediate user mandate (final checkout + payment
 * values) bound to the user's L1 issuer credential, serialized as
 * `JSON.stringify({ l1, l2 })` of both SD-JWTs.
 */
import {
  CheckoutMandate,
  MandateMode,
  PaymentMandate as ViPaymentMandate,
  UserMandate,
  createLayer2Immediate,
  hashAscii,
  jwtEncode,
  makeSigner,
  type SdJwt,
} from "verifiable-intent-js";
import type { CartMandate } from "../types/cart-mandate.js";
import type { PaymentMandate } from "../types/payment-mandate.js";
import { getViKeys } from "./keys.js";

/** L2 audience: the payment processor agent that verifies the bundle. */
export const PAYMENT_PROCESSOR_AUD = "http://localhost:8003";

export type PaymentMandateContents = PaymentMandate["paymentMandateContents"];

/**
 * AP2 amounts follow the W3C PaymentRequest (major units, e.g. 29.99) while
 * the VI SDK expects minor units (e.g. 2999) — convert with rounding.
 */
export function toMinorUnits(value: number): number {
  return Math.round(value * 100);
}

/** L2 nonce: the AP2 payment mandate id, stable and recomputable on both sides. */
export function l2NonceFor(contents: PaymentMandateContents): string {
  return contents.paymentMandateId;
}

export async function createUserAuthorization(args: {
  l1: SdJwt;
  cartMandate: CartMandate;
  paymentMandateContents: PaymentMandateContents;
}): Promise<string> {
  const { l1, cartMandate, paymentMandateContents } = args;
  const keys = await getViKeys();
  const now = Math.floor(Date.now() / 1000);

  const cartContents = cartMandate.contents;
  const total = paymentMandateContents.paymentDetailsTotal.amount;

  // Stand-in for the merchant's real authorization, which this sample only
  // fakes (merchantAuthorization is a placeholder JWT nobody verifies): a
  // checkout JWT signed with the merchant dev key over the cart essentials.
  const merchantSigner = await makeSigner(keys.merchant.privateKey);
  const checkoutJwt = await jwtEncode(
    { alg: "ES256", typ: "JWT", kid: "ap2-demo-merchant-key-1" },
    {
      iss: cartContents.merchantName,
      sub: "cart_checkout",
      iat: now,
      exp: now + 3600,
      cart: {
        id: cartContents.id,
        items: cartContents.paymentRequest.details.displayItems.map(
          (item) => item.label
        ),
        total: { currency: total.currency, value: total.value },
      },
    },
    merchantSigner
  );

  const mandate = new UserMandate({
    nonce: l2NonceFor(paymentMandateContents),
    aud: PAYMENT_PROCESSOR_AUD,
    iat: now,
    iss: "https://shopping-agent.ap2.example",
    exp: now + 900,
    mode: MandateMode.IMMEDIATE,
    sdHash: await hashAscii(l1.serialize()),
    promptSummary: `Purchase from ${paymentMandateContents.merchantAgent}`,
    // checkout_hash + transaction_id are auto-computed from the checkout JWT.
    checkoutMandate: new CheckoutMandate({
      vct: "mandate.checkout.1",
      checkoutJwt,
    }),
    paymentMandate: new ViPaymentMandate({
      vct: "mandate.payment.1",
      paymentInstrument: {
        type: paymentMandateContents.paymentResponse.methodName,
        id: paymentMandateContents.paymentResponse.requestId,
      },
      payee: {
        name: paymentMandateContents.merchantAgent,
        website: "https://demo-merchant.ap2.example",
      },
      currency: total.currency,
      amount: toMinorUnits(total.value),
    }),
  });

  const l2 = await createLayer2Immediate(mandate, keys.user.privateKey);
  return JSON.stringify({ l1: l1.serialize(), l2: l2.serialize() });
}
