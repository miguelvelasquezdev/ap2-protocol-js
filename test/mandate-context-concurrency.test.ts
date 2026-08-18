import { describe, expect, it } from "vitest";

/**
 * B2 — no-double-spend proof for the MandateContext persistence contract.
 *
 * The SDK evaluates budget/recurrence against the MandateContext counters you
 * pass, but never persists them. Under concurrency the counter you loaded is a
 * stale snapshot: N requests can each read "spent = 0", each pass the budget
 * check, and each commit — spending N× the budget. The fix is to re-check AND
 * increment the counter ATOMICALLY at commit time (per mandate scope), plus an
 * idempotency key so a retry doesn't double-count.
 *
 * `AtomicBudgetStore` is the reference pattern (an in-memory stand-in for a real
 * store's atomic compare-and-increment: Redis WATCH/MULTI, Postgres SELECT … FOR
 * UPDATE, a conditional DynamoDB write). This test proves it holds a budget
 * under parallel load, and that the naive pattern does not.
 */
class AtomicBudgetStore {
  #spent = new Map<string, number>();
  #seen = new Map<string, { committed: boolean }>();
  #tail = new Map<string, Promise<unknown>>();

  // Serialize all work for one scope (the critical section).
  #lock<T>(scope: string, fn: () => T): Promise<T> {
    const prev = this.#tail.get(scope) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.#tail.set(
      scope,
      run.then(
        () => {},
        () => {},
      ),
    );
    return run;
  }

  spent(scope: string): number {
    return this.#spent.get(scope) ?? 0;
  }

  /** Atomically re-check the budget against the CURRENT total and commit. */
  authorize(
    scope: string,
    amountMinor: number,
    budgetMinor: number,
    idempotencyKey: string,
  ): Promise<{ committed: boolean; reason?: string }> {
    return this.#lock(scope, () => {
      const prior = this.#seen.get(idempotencyKey);
      if (prior) return { committed: prior.committed, reason: "idempotent-replay" };
      const spent = this.#spent.get(scope) ?? 0;
      if (spent + amountMinor > budgetMinor) {
        const r = { committed: false as const, reason: "budget_exceeded" };
        this.#seen.set(idempotencyKey, r);
        return r;
      }
      this.#spent.set(scope, spent + amountMinor);
      this.#seen.set(idempotencyKey, { committed: true });
      return { committed: true };
    });
  }
}

/** The BUG: read the counter, yield (the async verify gap), commit vs the stale
 * read with no lock. Every concurrent caller reads 0 and over-commits. */
class NaiveBudgetStore {
  spent = new Map<string, number>();
  async authorize(scope: string, amountMinor: number, budgetMinor: number) {
    const seen = this.spent.get(scope) ?? 0; // read
    await Promise.resolve(); // the verify() gap
    if (seen + amountMinor > budgetMinor) return { committed: false };
    this.spent.set(scope, seen + amountMinor); // write against the stale read
    return { committed: true };
  }
}

const BUDGET = 50_000; // $500 in minor units
const AMOUNT = 10_000; // $100
const CAP = BUDGET / AMOUNT; // 5 authorizations fit
const N = 40;

describe("MandateContext budget: no double-spend under concurrency", () => {
  it("atomic store commits at most the budget across N parallel authorizations", async () => {
    const store = new AtomicBudgetStore();
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => store.authorize("open-1", AMOUNT, BUDGET, `idem-${i}`)),
    );
    const committed = results.filter((r) => r.committed).length;
    expect(committed).toBe(CAP);
    expect(store.spent("open-1")).toBe(BUDGET);
    expect(store.spent("open-1")).toBeLessThanOrEqual(BUDGET);
  });

  it("is idempotent: replaying an authorization does not spend twice", async () => {
    const store = new AtomicBudgetStore();
    const a = await store.authorize("open-2", AMOUNT, BUDGET, "idem-x");
    const b = await store.authorize("open-2", AMOUNT, BUDGET, "idem-x");
    expect(a.committed).toBe(true);
    expect(b.committed).toBe(true); // same result replayed
    expect(store.spent("open-2")).toBe(AMOUNT); // charged once
  });

  it("demonstrates the naive (non-atomic) pattern double-spends", async () => {
    const store = new NaiveBudgetStore();
    const results = await Promise.all(
      Array.from({ length: N }, () => store.authorize("open-3", AMOUNT, BUDGET)),
    );
    const committed = results.filter((r) => r.committed).length;
    expect(committed).toBeGreaterThan(CAP); // over-approved against the same budget
  });
});
