import { describe, expect, it } from "vitest";
import { createMandate, presentMandate, verifyPaymentMandate } from "../src/index.ts";
import { cnf, makeKeypair, samplePaymentMandate } from "./fixtures.ts";

/**
 * The safe one-call entry point: verifyPaymentMandate fails-closed on BOTH the
 * crypto chain and the constraints, so `if (result.ok)` is a safe authorization
 * gate. These tests pin the property the README leads with — an over-budget
 * mandate is cryptographically valid yet MUST be denied.
 */
const AUD = "merchant";
const NONCE = "nonce-1";
const HASH = "checkout-hash-1";

async function signPaymentChain(amount: number) {
  const issuer = await makeKeypair("issuer");
  const agent = await makeKeypair("agent");
  const open = await createMandate({
    payload: {
      vct: "mandate.payment.open.1",
      constraints: [
        { type: "payment.reference", conditional_transaction_id: HASH },
        { type: "payment.amount_range", currency: "USD", min: 100, max: 5000 },
      ],
      cnf: cnf(agent.publicJwk),
    },
    issuerKey: issuer.privateJwk,
  });
  const chain = await presentMandate({
    holderKey: agent.privateJwk,
    mandateToken: open,
    payload: { ...samplePaymentMandate(), payment_amount: { currency: "USD", amount } },
    aud: AUD,
    nonce: NONCE,
  });
  return { chain, issuerJwk: issuer.publicJwk };
}

describe("verifyPaymentMandate (safe one-call verify)", () => {
  it("accepts a valid chain within the amount range", async () => {
    const { chain, issuerJwk } = await signPaymentChain(1000);
    const result = await verifyPaymentMandate({
      token: chain,
      resolveKey: () => issuerJwk,
      expectedAud: AUD,
      expectedNonce: NONCE,
      expectedOpenCheckoutHash: HASH,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.chain.closedMandate.payment_amount.amount).toBe(1000);
    }
  });

  it("DENIES an over-budget chain even though the crypto is valid", async () => {
    const { chain, issuerJwk } = await signPaymentChain(999999);
    const result = await verifyPaymentMandate({
      token: chain,
      resolveKey: () => issuerJwk,
      expectedAud: AUD,
      expectedNonce: NONCE,
      expectedOpenCheckoutHash: HASH,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("constraints_violated");
  });

  it("still denies on a crypto failure (wrong nonce)", async () => {
    const { chain, issuerJwk } = await signPaymentChain(1000);
    const result = await verifyPaymentMandate({
      token: chain,
      resolveKey: () => issuerJwk,
      expectedAud: AUD,
      expectedNonce: "wrong-nonce",
      expectedOpenCheckoutHash: HASH,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("nonce_mismatch");
  });
});
