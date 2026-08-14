import { describe, expect, it } from "vitest";
import {
  b64urlEncode,
  computeSha256B64url,
  createCheckoutReceipt,
  extractParsedCheckoutObject,
  parseCheckoutMandateChain,
  signReceipt,
  verifyCheckoutMandateChain,
  verifyReceipt,
} from "../src/index.ts";
import type { CheckoutMandate, OpenCheckoutMandate } from "../src/schemas/index.ts";
import { FROZEN_NOW, makeKeypair } from "./fixtures.ts";

const checkout = {
  id: "checkout-1",
  merchant: { id: "m-1", name: "Acme" },
  line_items: [],
  status: "incomplete",
  currency: "USD",
  totals: [],
  links: [],
};

/** Build a signature-free JWT string carrying `payload` (extract does not
 * verify the signature; that is the merchant's own object). */
function unsignedJwt(payload: Record<string, unknown>): string {
  const header = b64urlEncode(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  return `${header}.${b64urlEncode(JSON.stringify(payload))}.unsigned`;
}

describe("extractParsedCheckoutObject", () => {
  it("decodes a valid checkout object without verifying the signature", () => {
    const result = extractParsedCheckoutObject(unsignedJwt(checkout));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe("checkout-1");
  });

  it("rejects a non-JWT string", () => {
    const result = extractParsedCheckoutObject("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("malformed_token");
  });

  it("rejects a JWT whose payload is not a valid Checkout", () => {
    const result = extractParsedCheckoutObject(unsignedJwt({ id: "x" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("payload_invalid");
  });
});

describe("checkout mandate chain", () => {
  const openMandate: OpenCheckoutMandate = {
    vct: "mandate.checkout.open.1",
    constraints: [
      { type: "checkout.line_items", items: [] },
      { type: "checkout.allowed_merchants", allowed: [{ id: "m-1", name: "Acme" }] },
    ] as OpenCheckoutMandate["constraints"],
    cnf: { jwk: {} },
  };

  it("parse rejects the wrong payload count", () => {
    expect(parseCheckoutMandateChain([{}]).ok).toBe(false);
  });

  it("rejects an unbound checkout_jwt (does not match checkout_hash)", async () => {
    // The checkout object drives constraint evaluation; if it is not bound to
    // the signed mandate, its constraints MUST NOT be evaluated at all.
    const closedMandate: CheckoutMandate = {
      vct: "mandate.checkout.1",
      checkout_jwt: unsignedJwt(checkout),
      checkout_hash: "not-the-real-hash",
    };
    const violations = await verifyCheckoutMandateChain(
      { openMandate, closedMandate },
      { checkoutJwt: closedMandate.checkout_jwt },
    );
    expect(violations).toEqual(["checkout_jwt does not match the mandate checkout_hash"]);
  });

  it("evaluates constraints once the checkout_jwt is correctly bound", async () => {
    const checkoutJwt = unsignedJwt(checkout);
    const closedMandate: CheckoutMandate = {
      vct: "mandate.checkout.1",
      checkout_jwt: checkoutJwt,
      checkout_hash: await computeSha256B64url(checkoutJwt),
    };
    const violations = await verifyCheckoutMandateChain(
      { openMandate, closedMandate },
      { checkoutJwt },
    );
    // Merchant matches (m-1); line_items is the documented not-yet-supported follow-on.
    expect(violations.some((m) => m.includes("allowed_merchants"))).toBe(false);
    expect(violations.some((m) => m.includes("line_items"))).toBe(true);
  });
});

describe("receipt failure modes", () => {
  it("rejects a malformed receipt JWT", async () => {
    const issuer = await makeKeypair("issuer");
    const result = await verifyReceipt({
      receiptJwt: "not.a.jwt",
      issuerKey: issuer.publicJwk,
      hasReference: () => true,
      kind: "payment",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("signature_invalid");
  });

  it("rejects a checkout receipt verified as a payment receipt (wrong schema)", async () => {
    const issuer = await makeKeypair("issuer");
    const checkoutReceipt = createCheckoutReceipt({
      merchant: "acme",
      reference: "r",
      orderId: "o",
      nowSeconds: FROZEN_NOW,
    });
    const jwt = await signReceipt(checkoutReceipt, issuer.privateJwk);
    const result = await verifyReceipt({
      receiptJwt: jwt,
      issuerKey: issuer.publicJwk,
      hasReference: () => true,
      kind: "payment", // wrong kind: a checkout receipt lacks payment_id
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("payload_invalid");
  });
});
