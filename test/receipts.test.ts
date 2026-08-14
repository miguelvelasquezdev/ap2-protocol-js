import { describe, expect, it } from "vitest";
import {
  createCheckoutReceipt,
  createPaymentReceipt,
  signReceipt,
  verifyReceipt,
} from "../src/index.ts";
import { FROZEN_NOW, makeKeypair } from "./fixtures.ts";
import type { PaymentMandate } from "../src/schemas/index.ts";

const paymentMandate: PaymentMandate = {
  vct: "mandate.payment.1",
  transaction_id: "txn",
  payee: { id: "m", name: "Acme" },
  payment_amount: { currency: "USD", amount: 1000 },
  payment_instrument: { id: "pi", type: "CARD" },
  pisp: { legal_name: "PiCo", brand_name: "Pi", domain_name: "pi.test" },
};

describe("payment receipts", () => {
  it("iss inherits the PISP domain; empty when absent", () => {
    const withPisp = createPaymentReceipt({ paymentMandate, reference: "r", nowSeconds: FROZEN_NOW });
    expect(withPisp.iss).toBe("pi.test");
    const { pisp: _pisp, ...noPisp } = paymentMandate;
    const receipt = createPaymentReceipt({
      paymentMandate: noPisp as PaymentMandate,
      reference: "r",
      nowSeconds: FROZEN_NOW,
    });
    expect(receipt.iss).toBe("");
  });

  it("round-trips create -> sign -> verify with a store hit", async () => {
    const issuer = await makeKeypair("issuer");
    const receipt = createPaymentReceipt({
      paymentMandate,
      reference: "ref-1",
      nowSeconds: FROZEN_NOW,
    });
    const jwt = await signReceipt(receipt, issuer.privateJwk);
    const result = await verifyReceipt({
      receiptJwt: jwt,
      issuerKey: issuer.publicJwk,
      hasReference: (r) => r === "ref-1",
      kind: "payment",
    });
    expect(result.ok).toBe(true);
  });

  it("fails when the reference is not in the store", async () => {
    const issuer = await makeKeypair("issuer");
    const jwt = await signReceipt(
      createPaymentReceipt({ paymentMandate, reference: "ref-1", nowSeconds: FROZEN_NOW }),
      issuer.privateJwk,
    );
    const result = await verifyReceipt({
      receiptJwt: jwt,
      issuerKey: issuer.publicJwk,
      hasReference: () => false,
      kind: "payment",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("payload_invalid");
  });

  it("fails on an invalid signature", async () => {
    const issuer = await makeKeypair("issuer");
    const other = await makeKeypair("other");
    const jwt = await signReceipt(
      createPaymentReceipt({ paymentMandate, reference: "ref-1", nowSeconds: FROZEN_NOW }),
      issuer.privateJwk,
    );
    const result = await verifyReceipt({
      receiptJwt: jwt,
      issuerKey: other.publicJwk,
      hasReference: () => true,
      kind: "payment",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("signature_invalid");
  });
});

describe("checkout receipts", () => {
  it("round-trips with an order id", async () => {
    const issuer = await makeKeypair("issuer");
    const receipt = createCheckoutReceipt({
      merchant: "acme.test",
      reference: "ref-c",
      orderId: "order-9",
      nowSeconds: FROZEN_NOW,
    });
    expect(receipt.order_id).toBe("order-9");
    const jwt = await signReceipt(receipt, issuer.privateJwk);
    const result = await verifyReceipt({
      receiptJwt: jwt,
      issuerKey: issuer.publicJwk,
      hasReference: (r) => r === "ref-c",
      kind: "checkout",
    });
    expect(result.ok).toBe(true);
  });
});
