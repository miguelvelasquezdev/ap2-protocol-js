import { describe, expect, it } from "vitest";
import {
  createUserAuthorization,
  verifyUserAuthorization,
  PAYMENT_PROCESSOR_AUD,
} from "../../common/ap2/mandates.js";
import type { CartMandate } from "../../common/types/cart-mandate.js";
import type { PaymentMandate } from "../../common/types/payment-mandate.js";

/**
 * The AP2 mandate flow this sample demonstrates, exercised without the LLM: the
 * happy path plus the attacks a merchant/PSP actually has to survive. If you are
 * evaluating AP2, these assertions are the point — each one is a thing an agent
 * CANNOT do, no matter what the model says.
 */
const MERCHANT = "Tennis Warehouse";

const cartMandate = {
  contents: {
    id: "cart_123",
    merchantName: MERCHANT,
    paymentRequest: {
      details: {
        id: "order_123",
        displayItems: [{ label: "Wilson Pro Staff 97", amount: { currency: "USD", value: 249.99 } }],
        total: { label: "Total", amount: { currency: "USD", value: 249.99 } },
      },
      methodData: [{ supportedMethods: "CARD" }],
    },
  },
} as unknown as CartMandate;

function contentsFor(value: number, merchant = MERCHANT) {
  return {
    paymentMandateId: "pm_test_1",
    paymentDetailsId: "order_123",
    paymentDetailsTotal: { label: "Total", amount: { currency: "USD", value } },
    paymentResponse: { requestId: "order_123", methodName: "CARD", details: { token: "tok" } },
    merchantAgent: merchant,
    timestamp: new Date().toISOString(),
  } as unknown as PaymentMandate["paymentMandateContents"];
}

describe("AP2 mandate chain (ap2-protocol-js)", () => {
  it("verifies a genuine authorization and reports what was authorized", async () => {
    const contents = contentsFor(249.99);
    const auth = await createUserAuthorization({ cartMandate, paymentMandateContents: contents });
    const result = await verifyUserAuthorization(auth, contents);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    // Amounts are minor units: 249.99 USD -> 24999.
    expect(result.authorized).toMatchObject({ amountMinor: 24999, currency: "USD", payee: MERCHANT });
  });

  it("REJECTS a charge for more than the user authorized", async () => {
    const signed = contentsFor(249.99);
    const auth = await createUserAuthorization({ cartMandate, paymentMandateContents: signed });
    // The PSP is asked to process a bigger amount than the mandate covers.
    const inflated = { ...contentsFor(999.99), paymentMandateId: signed.paymentMandateId };
    const result = await verifyUserAuthorization(auth, inflated);
    expect(result.valid).toBe(false);
  });

  it("REJECTS a mandate replayed to a different verifier (aud)", async () => {
    const contents = contentsFor(249.99);
    const auth = await createUserAuthorization({ cartMandate, paymentMandateContents: contents });
    const result = await verifyUserAuthorization(auth, contents, "http://evil.example");
    expect(result.valid).toBe(false);
  });

  it("REJECTS a mandate replayed for a different purchase (nonce)", async () => {
    const contents = contentsFor(249.99);
    const auth = await createUserAuthorization({ cartMandate, paymentMandateContents: contents });
    const otherPurchase = { ...contents, paymentMandateId: "pm_test_2" };
    const result = await verifyUserAuthorization(auth, otherPurchase);
    expect(result.valid).toBe(false);
  });

  it("REJECTS a tampered presentation", async () => {
    const contents = contentsFor(249.99);
    const auth = await createUserAuthorization({ cartMandate, paymentMandateContents: contents });
    const bundle = JSON.parse(auth) as { mandate: string; checkoutJwt: string };
    // Flip a byte in the signed chain.
    const tampered = JSON.stringify({
      ...bundle,
      mandate: bundle.mandate.slice(0, -3) + (bundle.mandate.endsWith("A") ? "BBB" : "AAA"),
    });
    const result = await verifyUserAuthorization(tampered, contents);
    expect(result.valid).toBe(false);
  });

  it("REJECTS a mandate pointed at a different checkout", async () => {
    const contents = contentsFor(249.99);
    const auth = await createUserAuthorization({ cartMandate, paymentMandateContents: contents });
    const bundle = JSON.parse(auth) as { mandate: string; checkoutJwt: string };
    // Swap in another cart's checkout JWT: the recomputed hash no longer matches
    // the payment.reference constraint the wallet signed.
    const otherAuth = await createUserAuthorization({
      cartMandate: {
        ...cartMandate,
        contents: { ...cartMandate.contents, id: "cart_999" },
      } as CartMandate,
      paymentMandateContents: contents,
    });
    const otherCheckout = (JSON.parse(otherAuth) as { checkoutJwt: string }).checkoutJwt;
    const result = await verifyUserAuthorization(
      JSON.stringify({ ...bundle, checkoutJwt: otherCheckout }),
      contents,
    );
    expect(result.valid).toBe(false);
  });

  it("REJECTS a missing authorization (fail closed)", async () => {
    expect((await verifyUserAuthorization(undefined, contentsFor(1))).valid).toBe(false);
    expect((await verifyUserAuthorization("not json", contentsFor(1))).valid).toBe(false);
  });

  it("is addressed to the payment processor by default", () => {
    expect(PAYMENT_PROCESSOR_AUD).toBe("http://localhost:8003");
  });
});
