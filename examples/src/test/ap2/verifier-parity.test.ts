import { describe, expect, it } from "vitest";
import { computeSha256B64url } from "ap2-protocol-js";
import { createUserAuthorization, PAYMENT_PROCESSOR_AUD, nonceFor } from "../../common/ap2/mandates.js";
import { getAp2Keys } from "../../common/ap2/keys.js";
import { verifyViaGateway, verifyViaSdk, type VerifyInput } from "../../common/ap2/verifier.js";
import type { CartMandate } from "../../common/types/cart-mandate.js";
import type { PaymentMandate } from "../../common/types/payment-mandate.js";

/**
 * PARITY: the SDK path and the agentic-checkout gateway path must reach the
 * SAME decision on every input — because the gateway's ap2 adapter performs no
 * crypto of its own, it delegates to this very SDK. If these ever diverge, one
 * of the two is wrong.
 */
const MERCHANT = "Tennis Warehouse";

const cartMandate = {
  contents: {
    id: "cart_parity",
    merchantName: MERCHANT,
    paymentRequest: {
      details: {
        id: "order_parity",
        displayItems: [{ label: "Racquet", amount: { currency: "USD", value: 249.99 } }],
        total: { label: "Total", amount: { currency: "USD", value: 249.99 } },
      },
      methodData: [{ supportedMethods: "CARD" }],
    },
  },
} as unknown as CartMandate;

const contents = {
  paymentMandateId: "pm_parity_1",
  paymentDetailsId: "order_parity",
  paymentDetailsTotal: { label: "Total", amount: { currency: "USD", value: 249.99 } },
  paymentResponse: { requestId: "order_parity", methodName: "CARD", details: { token: "tok" } },
  merchantAgent: MERCHANT,
  timestamp: new Date().toISOString(),
} as unknown as PaymentMandate["paymentMandateContents"];

async function inputFor(overrides: Partial<VerifyInput> = {}): Promise<VerifyInput> {
  const auth = await createUserAuthorization({ cartMandate, paymentMandateContents: contents });
  const bundle = JSON.parse(auth) as { mandate: string; checkoutJwt: string };
  const keys = await getAp2Keys();
  return {
    token: bundle.mandate,
    issuerKey: keys.wallet.publicKey,
    expectedAud: PAYMENT_PROCESSOR_AUD,
    expectedNonce: nonceFor(contents),
    expectedOpenCheckoutHash: await computeSha256B64url(bundle.checkoutJwt),
    ...overrides,
  };
}

/** Run both paths and assert they agree; return the shared verdict. */
async function bothAgree(input: VerifyInput): Promise<boolean> {
  const [sdk, gateway] = await Promise.all([verifyViaSdk(input), verifyViaGateway(input)]);
  expect(gateway.ok).toBe(sdk.ok);
  if (sdk.ok && gateway.ok) {
    // Same authorized amount/payee, whichever path produced it.
    expect(gateway.closedMandate.payment_amount).toEqual(sdk.closedMandate.payment_amount);
    expect(gateway.closedMandate.payee?.name).toBe(sdk.closedMandate.payee?.name);
    // Only the gateway carries the audit anchor.
    expect(gateway.recordHash).toMatch(/^[0-9a-f]+$/);
    expect(sdk.recordHash).toBeUndefined();
  }
  return sdk.ok;
}

describe("SDK and gateway verification parity", () => {
  it("both ACCEPT a genuine mandate", async () => {
    expect(await bothAgree(await inputFor())).toBe(true);
  });

  it("both REJECT a mandate replayed at another verifier", async () => {
    expect(await bothAgree(await inputFor({ expectedAud: "http://evil.example" }))).toBe(false);
  });

  it("both REJECT a mandate reused for another purchase", async () => {
    expect(await bothAgree(await inputFor({ expectedNonce: "pm_other" }))).toBe(false);
  });

  it("both REJECT a mandate pointed at another checkout", async () => {
    expect(await bothAgree(await inputFor({ expectedOpenCheckoutHash: "not-the-hash" }))).toBe(false);
  });

  it("both REJECT a tampered chain", async () => {
    const base = await inputFor();
    const tampered = { ...base, token: base.token.slice(0, -6) + "XXXXX" + base.token.slice(-1) };
    expect(await bothAgree(tampered)).toBe(false);
  });

  it("both REJECT a mandate verified against the wrong issuer key", async () => {
    const keys = await getAp2Keys();
    expect(await bothAgree(await inputFor({ issuerKey: keys.agent.publicKey }))).toBe(false);
  });
});
