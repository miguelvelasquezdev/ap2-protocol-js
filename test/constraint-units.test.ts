import { describe, expect, it } from "vitest";
import { createMandate, presentMandate, verifyPaymentMandate } from "../src/index.ts";
import type { PaymentConstraint } from "../src/schemas/index.ts";
import { cnf, makeKeypair, samplePaymentMandate } from "./fixtures.ts";

/**
 * UNIT-CONVENTION regression guard — pins the deliberate split between the two
 * amount-bearing constraints so nobody "aligns" them and silently breaks
 * cross-implementation parity with the reference ap2.sdk:
 *
 *   - payment.amount_range → min/max are UNSCALED (minor units, == payment_amount.amount)
 *   - payment.budget       → max is a MAJOR unit, scaled ×100 before comparison
 *
 * If either assertion flips, the change diverges from the reference. See
 * SECURITY.md "Amount units".
 */
const AUD = "merchant";
const NONCE = "nonce-1";
const HASH = "checkout-hash-1";

async function verifyAmount(constraint: PaymentConstraint, amount: number, context?: { totalAmount?: number }) {
  const issuer = await makeKeypair("issuer");
  const agent = await makeKeypair("agent");
  const open = await createMandate({
    payload: {
      vct: "mandate.payment.open.1",
      constraints: [{ type: "payment.reference", conditional_transaction_id: HASH }, constraint],
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
  return verifyPaymentMandate({
    token: chain,
    resolveKey: () => issuer.publicJwk,
    expectedAud: AUD,
    expectedNonce: NONCE,
    expectedOpenCheckoutHash: HASH,
    ...(context ? { context } : {}),
  });
}

describe("constraint amount units (reference parity)", () => {
  it("amount_range: min/max are UNSCALED — {min:500,max:500} pins amount 500 exactly", async () => {
    const range: PaymentConstraint = { type: "payment.amount_range", currency: "USD", min: 500, max: 500 };
    // If this were scaled ×100, 500 would be read as below min=50000 and denied.
    expect((await verifyAmount(range, 500)).ok).toBe(true);
    expect((await verifyAmount(range, 501)).ok).toBe(false); // above max
    expect((await verifyAmount(range, 499)).ok).toBe(false); // below min
  });

  it("budget: max is a MAJOR unit — {max:5} allows a 500-minor amount, denies 501", async () => {
    const budget: PaymentConstraint = { type: "payment.budget", currency: "USD", max: 5 };
    // 5 major → 500 minor. If budget were UNSCALED, 500 > 5 would always deny.
    expect((await verifyAmount(budget, 500, { totalAmount: 0 })).ok).toBe(true);
    expect((await verifyAmount(budget, 501, { totalAmount: 0 })).ok).toBe(false);
  });
});
