/**
 * Checkout `line_items` constraint matching — a faithful port of the reference
 * ap2.sdk max_flow_helper.evaluate_line_items_max_flow.
 *
 * The open mandate declares requirement slots (`{ acceptable_items, quantity }`);
 * the closed checkout has actual line items. Each cart unit must be assignable
 * to some slot without exceeding any slot's quantity. Because one SKU can be
 * acceptable to several slots and slots have finite capacity, this is bipartite
 * b-matching, solved as max-flow. Matching is by `item.id` string equality; an
 * empty `acceptable_items` list is a wildcard (matches any SKU). Returns
 * violation strings (empty = satisfied); the strings match the reference exactly.
 *
 * A greedy degree-1 pre-pass assigns unambiguous SKUs first (matching the
 * reference), and only genuinely ambiguous SKUs enter the flow network — so the
 * residual read-out for the "could not be assigned" message is byte-compatible.
 */
import type { LineItem, LineItemRequirements } from "../schemas/index.ts";

const INF = 1e15;

// DoS guard: the matcher is synchronous and worst-case near-cubic on the flow
// network (a complete bipartite graph when every SKU is acceptable to every
// requirement — e.g. wildcard slots). Untrusted checkout line items and, within
// a delegation chain, adversarial requirements can drive that. Real checkouts
// are tiny (tens of items); anything past these budgets is rejected fail-closed
// rather than allowed to freeze the event loop. See SECURITY.md "Resource limits".
const MAX_LINE_ITEMS = 1000;
const MAX_REQUIREMENTS = 1000;
const MAX_MATCH_EDGES = 50_000; // distinct SKUs × requirements

export function evaluateLineItemsMaxFlow(
  checkoutItems: readonly LineItem[],
  requirements: readonly LineItemRequirements[],
): string[] {
  if (checkoutItems.length > MAX_LINE_ITEMS || requirements.length > MAX_REQUIREMENTS) {
    return ["line_items: too many line items or requirements to evaluate"];
  }

  // Negative quantities have no legitimate meaning for a line item and would
  // NET against positive ones: [A×5, A×−4] could satisfy a quantity:1 slot, and
  // [Z×5, Z×−5] could smuggle an unauthorized SKU past the uncovered-SKU check
  // by netting Z to zero (which line (D) then skips). The reference nets them;
  // we DELIBERATELY diverge and fail closed. See SECURITY.md "Line-item quantities".
  for (const li of checkoutItems) {
    if (!Number.isInteger(li.quantity) || li.quantity < 0) {
      return [`line_items: invalid quantity ${li.quantity} for item ${li.item.id}`];
    }
  }
  for (const r of requirements) {
    if (!Number.isInteger(r.quantity) || r.quantity < 0) {
      return [`line_items: invalid requirement quantity ${r.quantity} for ${r.id}`];
    }
  }

  // (A) merge duplicate SKUs, preserving first-seen order.
  const cartQty = new Map<string, number>();
  for (const li of checkoutItems) {
    const sku = li.item.id;
    cartQty.set(sku, (cartQty.get(sku) ?? 0) + li.quantity);
  }
  const skuList = [...cartQty.keys()];

  if (skuList.length * requirements.length > MAX_MATCH_EDGES) {
    return ["line_items: constraint problem exceeds the evaluation budget"];
  }

  const reqAcceptable = requirements.map((r) => new Set(r.acceptable_items.map((ai) => ai.id)));
  const reqIsWildcard = requirements.map((r) => r.acceptable_items.length === 0);
  const hasWildcard = reqIsWildcard.some(Boolean);

  const violations: string[] = [];

  // (D) uncovered-SKU early exit — suppressed entirely when any wildcard exists.
  if (!hasWildcard) {
    const allAcceptable = new Set<string>();
    for (const acc of reqAcceptable) for (const id of acc) allAcceptable.add(id);
    for (const [sku, qty] of cartQty) {
      if (qty <= 0) continue;
      if (!allAcceptable.has(sku)) {
        violations.push(`Item ${sku} not in any requirement's acceptable items`);
      }
    }
    if (violations.length > 0) return violations;
  }

  // Greedy degree-1 elimination: assign SKUs acceptable to exactly one slot.
  const reqRemaining = requirements.map((r) => r.quantity);
  const complexSkus: string[] = [];
  const unassigned: string[] = [];

  for (const sku of skuList) {
    const qty = cartQty.get(sku)!;
    if (qty <= 0) continue;
    let matchIdx = -1;
    let isComplex = false;
    for (let j = 0; j < requirements.length; j++) {
      if (reqIsWildcard[j] || reqAcceptable[j]!.has(sku)) {
        if (matchIdx === -1) matchIdx = j;
        else {
          isComplex = true;
          break;
        }
      }
    }
    if (matchIdx !== -1 && !isComplex) {
      const assigned = Math.min(qty, reqRemaining[matchIdx]!);
      reqRemaining[matchIdx]! -= assigned;
      const leftover = qty - assigned;
      if (leftover > 0) unassigned.push(`${sku} (${leftover})`);
    } else {
      complexSkus.push(sku);
    }
  }

  // Ambiguous SKUs go through the flow network with remaining slot capacities.
  if (complexSkus.length > 0) {
    const { maxFlow, residualSource } = maxFlowForComplexSkus(
      complexSkus,
      cartQty,
      requirements.length,
      reqAcceptable,
      reqIsWildcard,
      reqRemaining,
    );
    const totalComplex = complexSkus.reduce((sum, sku) => sum + cartQty.get(sku)!, 0);
    if (maxFlow < totalComplex) {
      for (let i = 0; i < complexSkus.length; i++) {
        const remaining = residualSource.get(1 + i) ?? 0; // source=0, sku nodes start at 1
        if (remaining > 0) unassigned.push(`${complexSkus[i]} (${remaining})`);
      }
    }
  }

  if (unassigned.length > 0) {
    violations.push(
      `Cannot satisfy line item constraints: ${unassigned.join(", ")} could not be assigned to any requirement slot`,
    );
  }
  return violations;
}

/** Build the flow network for the ambiguous SKUs and run Dinic (reference default). */
function maxFlowForComplexSkus(
  skuList: readonly string[],
  cartQty: ReadonlyMap<string, number>,
  reqCount: number,
  reqAcceptable: readonly ReadonlySet<string>[],
  reqIsWildcard: readonly boolean[],
  reqRemaining: readonly number[],
): { maxFlow: number; residualSource: Map<number, number> } {
  const s = skuList.length;
  const n = 1 + s + reqCount + 1;
  const source = 0;
  const sink = n - 1;
  const skuOffset = 1;
  const reqOffset = 1 + s;

  const graph: Array<Map<number, number>> = Array.from({ length: n }, () => new Map());
  const addEdge = (u: number, v: number, cap: number) => {
    graph[u]!.set(v, cap);
    graph[v]!.set(u, 0);
  };

  for (let i = 0; i < s; i++) addEdge(source, skuOffset + i, cartQty.get(skuList[i]!)!);
  for (let i = 0; i < s; i++) {
    for (let j = 0; j < reqCount; j++) {
      if (reqIsWildcard[j] || reqAcceptable[j]!.has(skuList[i]!)) {
        addEdge(skuOffset + i, reqOffset + j, INF);
      }
    }
  }
  for (let j = 0; j < reqCount; j++) addEdge(reqOffset + j, sink, reqRemaining[j]!);

  const maxFlow = dinic(graph, source, sink, n);
  return { maxFlow, residualSource: graph[source]! };
}

function dinic(graph: Array<Map<number, number>>, source: number, sink: number, n: number): number {
  const adj = graph.map((m) => [...m.keys()]); // edge set is stable; capacities mutate

  const bfsLevel = (): number[] | null => {
    const level = new Array<number>(n).fill(-1);
    level[source] = 0;
    const queue = [source];
    for (let head = 0; head < queue.length; head++) {
      const u = queue[head]!;
      for (const v of adj[u]!) {
        if (level[v] === -1 && graph[u]!.get(v)! > 0) {
          level[v] = level[u]! + 1;
          queue.push(v);
        }
      }
    }
    return level[sink] === -1 ? null : level;
  };

  const dfsBlock = (u: number, pushed: number, level: number[], it: number[]): number => {
    if (u === sink || pushed === 0) return pushed;
    let total = 0;
    while (it[u]! < adj[u]!.length) {
      const v = adj[u]![it[u]!]!;
      const cap = graph[u]!.get(v)!;
      if (level[v] === level[u]! + 1 && cap > 0) {
        const d = dfsBlock(v, Math.min(pushed, cap), level, it);
        if (d > 0) {
          graph[u]!.set(v, cap - d);
          graph[v]!.set(u, graph[v]!.get(u)! + d);
          total += d;
          pushed -= d;
          if (pushed === 0) break;
        }
      }
      it[u]!++;
    }
    return total;
  };

  let flow = 0;
  for (;;) {
    const level = bfsLevel();
    if (level === null) break;
    const it = new Array<number>(n).fill(0);
    for (;;) {
      const f = dfsBlock(source, INF, level, it);
      if (f === 0) break;
      flow += f;
    }
  }
  return flow;
}
