import { describe, expect, it } from "vitest";
import {
  checkCheckoutConstraints,
  checkPaymentConstraints,
  merchantMatches,
  parsePaymentMandateChain,
  verifyPaymentMandateChain,
} from "../src/index.ts";
import type {
  OpenCheckoutMandate,
  OpenPaymentMandate,
  PaymentMandate,
} from "../src/schemas/index.ts";

const closed: PaymentMandate = {
  vct: "mandate.payment.1",
  transaction_id: "txn",
  payee: { id: "m-1", name: "Acme", website: "https://acme.test" },
  payment_amount: { currency: "USD", amount: 5000 },
  payment_instrument: { id: "pi-1", type: "CARD" },
};

function open(constraints: unknown[]): OpenPaymentMandate {
  return {
    vct: "mandate.payment.open.1",
    constraints: constraints as OpenPaymentMandate["constraints"],
    cnf: { jwk: {} },
  };
}

describe("merchantMatches", () => {
  it("prefers id equality", () => {
    expect(merchantMatches({ id: "a", name: "X" }, { id: "a", name: "Y" })).toBe(true);
    expect(merchantMatches({ id: "a", name: "X" }, { id: "b", name: "X" })).toBe(false);
  });
  it("falls back to name AND website", () => {
    expect(
      merchantMatches(
        { id: "", name: "X", website: "https://x.test" },
        { id: "", name: "X", website: "https://x.test" },
      ),
    ).toBe(true);
    expect(
      merchantMatches({ id: "", name: "X", website: "https://x.test" }, { id: "", name: "X" }),
    ).toBe(false);
  });
});

describe("amount_range", () => {
  it("passes within range", () => {
    const v = checkPaymentConstraints(
      open([
        { type: "payment.reference", conditional_transaction_id: "c" },
        { type: "payment.amount_range", currency: "USD", min: 100, max: 10000 },
      ]),
      closed,
      { openCheckoutHash: "c" },
    );
    expect(v).toEqual([]);
  });
  it("fails above max", () => {
    const v = checkPaymentConstraints(
      open([
        { type: "payment.reference", conditional_transaction_id: "c" },
        { type: "payment.amount_range", currency: "USD", min: 100, max: 1000 },
      ]),
      closed,
    );
    expect(v.some((m) => m.includes("above max"))).toBe(true);
  });
  it("fails on currency mismatch", () => {
    const v = checkPaymentConstraints(
      open([
        { type: "payment.reference", conditional_transaction_id: "c" },
        { type: "payment.amount_range", currency: "EUR", max: 10000 },
      ]),
      closed,
    );
    expect(v.some((m) => m.includes("currency"))).toBe(true);
  });
});

describe("budget (major-unit rule) and cross-constraint rule", () => {
  it("Budget.max is major units x100 (amount minor)", () => {
    // budget max 40.00 => 4000 minor; amount 5000 minor => exceeds.
    const v = checkPaymentConstraints(
      open([
        { type: "payment.reference", conditional_transaction_id: "c" },
        { type: "payment.budget", currency: "USD", max: 40 },
      ]),
      closed,
      { context: { totalAmount: 0 } },
    );
    expect(v.some((m) => m.includes("exceeds budget"))).toBe(true);
  });
  it("agent_recurrence requires amount_range AND budget", () => {
    const v = checkPaymentConstraints(
      open([
        { type: "payment.reference", conditional_transaction_id: "c" },
        { type: "payment.agent_recurrence", frequency: "DAILY", max_occurrences: 5 },
      ]),
      closed,
      { context: { totalUses: 0 } },
    );
    expect(v.some((m) => m.includes("requires an amount_range"))).toBe(true);
    expect(v.some((m) => m.includes("requires a budget"))).toBe(true);
  });
  it("agent_recurrence enforces max_occurrences only (frequency ignored)", () => {
    const v = checkPaymentConstraints(
      open([
        { type: "payment.reference", conditional_transaction_id: "c" },
        { type: "payment.amount_range", currency: "USD", max: 10000 },
        { type: "payment.budget", currency: "USD", max: 100 },
        { type: "payment.agent_recurrence", frequency: "DAILY", max_occurrences: 3 },
      ]),
      closed,
      { context: { totalUses: 3, totalAmount: 0 } },
    );
    expect(v.some((m) => m.includes("max_occurrences exceeded"))).toBe(true);
  });
});

describe("preset claims", () => {
  it("closed payee must match a preset open payee", () => {
    const o = open([{ type: "payment.reference", conditional_transaction_id: "c" }]);
    o.payee = { id: "different", name: "Other" };
    const v = checkPaymentConstraints(o, closed);
    expect(v.some((m) => m.includes("payee"))).toBe(true);
  });
});

describe("typed payment mandate chain", () => {
  it("parse rejects the wrong payload count", () => {
    const r = parsePaymentMandateChain([{}, {}, {}]);
    expect(r.ok).toBe(false);
  });
  it("verify surfaces a transaction_id mismatch", async () => {
    const chain = {
      openMandate: open([{ type: "payment.reference", conditional_transaction_id: "c" }]),
      closedMandate: closed,
    };
    const v = await verifyPaymentMandateChain(chain, { expectedTransactionId: "different" });
    expect(v.some((m) => m.includes("transaction_id"))).toBe(true);
  });
});

describe("checkout constraints", () => {
  const openCheckout: OpenCheckoutMandate = {
    vct: "mandate.checkout.open.1",
    constraints: [
      { type: "checkout.line_items", items: [] },
      { type: "checkout.allowed_merchants", allowed: [{ id: "m-1", name: "Acme" }] },
    ] as OpenCheckoutMandate["constraints"],
    cnf: { jwk: {} },
  };
  it("allowed_merchants matches the checkout merchant", () => {
    const v = checkCheckoutConstraints(openCheckout, {
      id: "c",
      merchant: { id: "m-1", name: "Acme" },
      line_items: [],
      status: "open",
      currency: "USD",
      totals: [],
      links: [],
    } as never);
    // line_items is a documented not-yet-supported violation; merchants pass.
    expect(v.some((m) => m.includes("allowed_merchants"))).toBe(false);
    expect(v.some((m) => m.includes("line_items"))).toBe(true);
  });
});
