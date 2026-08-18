import { describe, expect, it } from "vitest";
import { resolveDisclosures } from "../src/index.ts";
import { evaluateLineItemsMaxFlow } from "../src/constraints/line-items.ts";
import type { LineItem, LineItemRequirements } from "../src/schemas/index.ts";

/**
 * Regressions for the internal adversarial audit (2026-08). Each pins a fix for
 * a reproduced finding.
 */
describe("audit regressions", () => {
  // HIGH — max-flow DoS: unbounded checkout line items × wildcard requirements
  // built a complete bipartite graph and froze the synchronous matcher.
  it("line-items matcher rejects oversized input fast, fail-closed", () => {
    const mkItems = (n: number): LineItem[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `li${i}`,
        item: { id: `SKU-${i}`, title: "x", price: 1 },
        quantity: 1,
        totals: [],
      }));
    const mkReqs = (n: number): LineItemRequirements[] =>
      Array.from({ length: n }, (_, i) => ({ id: `r${i}`, acceptable_items: [], quantity: 1 }));

    // Count guard.
    const t1 = Date.now();
    const v1 = evaluateLineItemsMaxFlow(mkItems(5000), mkReqs(10));
    expect(Date.now() - t1).toBeLessThan(200);
    expect(v1.length).toBeGreaterThan(0);

    // Edge-budget guard (1000×1000 = 1e6 > 50k) — passes the count caps.
    const t2 = Date.now();
    const v2 = evaluateLineItemsMaxFlow(mkItems(1000), mkReqs(1000));
    expect(Date.now() - t2).toBeLessThan(200);
    expect(v2.length).toBeGreaterThan(0);

    // A real (small) cart still evaluates normally.
    expect(evaluateLineItemsMaxFlow(mkItems(3), [{ id: "r", acceptable_items: [], quantity: 3 }])).toEqual([]);
  });

  // MEDIUM — recursive resolver stack overflow: deeply nested disclosed JSON
  // threw a hard RangeError (crashing a direct resolveDisclosures caller).
  it("resolveDisclosures fails closed (Ap2Error) on deep nesting, not RangeError", async () => {
    let deep: unknown = 0;
    for (let i = 0; i < 10_000; i++) deep = [deep];
    await expect(resolveDisclosures({ x: deep }, [], "sha-256")).rejects.toThrow(/depth/i);
  });
});
