import { describe, expect, it } from "vitest";
import { evaluateLineItemsMaxFlow } from "../src/constraints/line-items.ts";
import type { LineItem, LineItemRequirements } from "../src/schemas/index.ts";

/**
 * Line-item max-flow matching, ported from the reference ap2.sdk
 * max_flow_helper. These cases + expected violation strings mirror the
 * reference's own suite (max_flow / checkout_mandate_chain tests), so a green
 * run is byte-compatibility with the reference matcher.
 */
function item(sku: string, qty: number): LineItem {
  return { id: `li-${sku}`, item: { id: sku, title: sku, price: 100 }, quantity: qty, totals: [] };
}
function req(id: string, acceptable: string[], quantity: number): LineItemRequirements {
  return { id, acceptable_items: acceptable.map((s) => ({ id: s, title: s })), quantity };
}

describe("line-items max-flow matching", () => {
  it("valid single sku within a slot", () => {
    expect(evaluateLineItemsMaxFlow([item("A", 2)], [req("r1", ["A"], 2)])).toEqual([]);
  });

  it("cart smaller than capacity passes (under is fine)", () => {
    expect(evaluateLineItemsMaxFlow([item("A", 1)], [req("r1", ["A"], 2)])).toEqual([]);
  });

  it("disallowed sku with no wildcard is reported uncovered (before flow)", () => {
    const v = evaluateLineItemsMaxFlow([item("A", 2), item("Z", 1)], [req("r1", ["A"], 2)]);
    expect(v).toEqual(["Item Z not in any requirement's acceptable items"]);
  });

  it("wildcard requirement (empty acceptable_items) accepts any sku", () => {
    expect(evaluateLineItemsMaxFlow([item("A", 1), item("Z", 3)], [req("r1", [], 5)])).toEqual([]);
  });

  it("duplicate sku entries are merged before matching", () => {
    expect(
      evaluateLineItemsMaxFlow([item("A", 1), item("A", 2)], [req("r1", ["A"], 3)]),
    ).toEqual([]);
  });

  it("single sku over the slot quantity is stranded", () => {
    expect(evaluateLineItemsMaxFlow([item("A", 3)], [req("r1", ["A"], 2)])).toEqual([
      "Cannot satisfy line item constraints: A (1) could not be assigned to any requirement slot",
    ]);
  });

  it("zero-quantity items are skipped", () => {
    expect(evaluateLineItemsMaxFlow([item("A", 0), item("B", 1)], [req("r1", ["A", "B"], 5)])).toEqual([]);
  });

  it("competing skus for the same single-capacity slot: one is stranded", () => {
    // B and C each fit only r2 (capacity 1); C is stranded after B fills it.
    const v = evaluateLineItemsMaxFlow(
      [item("B", 1), item("C", 1)],
      [req("r1", ["A"], 1), req("r2", ["B", "C"], 1)],
    );
    expect(v).toEqual([
      "Cannot satisfy line item constraints: C (1) could not be assigned to any requirement slot",
    ]);
  });

  it("complex multi-slot routing found by flow, not greedy", () => {
    // A->r1, B->r2, C->r3 is the only valid assignment; a first-match greedy
    // would mis-route B. Flow finds it.
    const v = evaluateLineItemsMaxFlow(
      [item("A", 1), item("B", 1), item("C", 1)],
      [req("r1", ["A", "B"], 1), req("r2", ["B", "C"], 1), req("r3", ["C", "D"], 1)],
    );
    expect(v).toEqual([]);
  });

  it("one sku split across multiple slots (partial routing)", () => {
    expect(
      evaluateLineItemsMaxFlow([item("A", 4)], [req("r1", ["A"], 2), req("r2", ["A"], 2)]),
    ).toEqual([]);
  });

  it("sku shared across requirements fits the summed capacity", () => {
    expect(
      evaluateLineItemsMaxFlow([item("A", 5)], [req("r1", ["A"], 2), req("r2", ["A"], 3)]),
    ).toEqual([]);
  });

  it("sku shared across requirements exceeding total capacity strands the excess", () => {
    expect(
      evaluateLineItemsMaxFlow([item("A", 6)], [req("r1", ["A"], 2), req("r2", ["A"], 3)]),
    ).toEqual([
      "Cannot satisfy line item constraints: A (1) could not be assigned to any requirement slot",
    ]);
  });
});
