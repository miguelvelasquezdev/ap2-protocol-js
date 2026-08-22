import { describe, expect, it } from "vitest";
import { createMandate, verifyMandate, VCT } from "../src/index.ts";
import { evaluateLineItemsMaxFlow } from "../src/constraints/line-items.ts";
import type { LineItem, LineItemRequirements } from "../src/schemas/index.ts";
import { cnf, makeKeypair } from "./fixtures.ts";

/**
 * Regressions for the findings surfaced by the retro-dvd integration review:
 *   #3 single-token verify returned `ok` with an empty payload when the
 *      delegate_payload disclosure was stripped;
 *   #7 single-token verify ignored nowSeconds (expired mandate verified ok);
 *   #4 line-item matching netted negative quantities (bypass).
 */
async function mintOpen(extra: Record<string, unknown> = {}) {
  const issuer = await makeKeypair("issuer");
  const agent = await makeKeypair("agent");
  const token = await createMandate({
    payload: {
      vct: VCT.openPaymentMandate,
      constraints: [{ type: "payment.reference", conditional_transaction_id: "h" }],
      cnf: cnf(agent.publicJwk),
      ...extra,
    },
    issuerKey: issuer.privateJwk,
  });
  return { token, issuerJwk: issuer.publicJwk };
}

describe("#7 single-token time claims", () => {
  it("denies an expired standalone mandate (nowSeconds no longer ignored)", async () => {
    const { token, issuerJwk } = await mintOpen({ exp: 1_000_000 }); // ~1970
    const result = await verifyMandate({ token, key: issuerJwk });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("expired");
  });

  it("accepts a non-expired standalone mandate", async () => {
    const { token, issuerJwk } = await mintOpen({ exp: 4_000_000_000 }); // ~2096
    expect((await verifyMandate({ token, key: issuerJwk })).ok).toBe(true);
  });
});

describe("#3 stripped delegate_payload", () => {
  it("denies a delegate root whose delegate_payload disclosure was stripped", async () => {
    const { token, issuerJwk } = await mintOpen();
    // `jwt~d1~` relayed as `jwt~`: the JWS still verifies, but the payload is gone.
    const stripped = token.slice(0, token.indexOf("~")) + "~";
    const result = await verifyMandate({ token: stripped, key: issuerJwk });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("payload_invalid");
  });

  it("accepts the intact delegate root", async () => {
    const { token, issuerJwk } = await mintOpen();
    expect((await verifyMandate({ token, key: issuerJwk })).ok).toBe(true);
  });
});

describe("#4 line-item negative-quantity guard", () => {
  const li = (sku: string, quantity: number): LineItem => ({
    id: `li-${sku}-${quantity}`,
    item: { id: sku, title: sku, price: 1 },
    quantity,
    totals: [],
  });
  const reqA: LineItemRequirements[] = [
    { id: "r", acceptable_items: [{ id: "A", title: "A", price: 1 }], quantity: 1 },
  ];

  it("rejects [A×5, A×-4] netting down to satisfy a quantity:1 slot", () => {
    expect(evaluateLineItemsMaxFlow([li("A", 5), li("A", -4)], reqA).length).toBeGreaterThan(0);
  });

  it("rejects [A×1, Z×5, Z×-5] smuggling an unauthorized SKU by netting it to zero", () => {
    const v = evaluateLineItemsMaxFlow([li("A", 1), li("Z", 5), li("Z", -5)], reqA);
    expect(v.length).toBeGreaterThan(0);
  });

  it("still accepts a normal positive cart", () => {
    expect(evaluateLineItemsMaxFlow([li("A", 1)], reqA)).toEqual([]);
  });
});
