/**
 * Constraint evaluation: does a closed mandate satisfy the constraints its
 * open mandate imposed? Matches sdk/constraints.py, including its unit rules:
 * amounts are ISO 4217 MINOR units everywhere EXCEPT Budget.max, which is a
 * number in MAJOR units (multiplied by 100 at evaluation). AgentRecurrence
 * evaluates maxOccurrences only; `frequency` is schema-validated but not
 * enforced (parity with the Python SDK, where period windowing is deferred to
 * the network). Violations are returned as readonly string arrays, never
 * thrown.
 */
import { err, ok, type Result } from "../errors.ts";
import { b64urlDecode, computeSha256B64url } from "../crypto/index.ts";
import {
  CheckoutMandateSchema,
  CheckoutSchema,
  OpenCheckoutMandateSchema,
  OpenPaymentMandateSchema,
  PaymentMandateSchema,
  type Checkout,
  type CheckoutConstraint,
  type CheckoutMandate,
  type Merchant,
  type OpenCheckoutMandate,
  type OpenPaymentMandate,
  type PaymentConstraint,
  type PaymentMandate,
} from "../schemas/index.ts";

/** Network-side counters for stateful constraints (budget, recurrence). The
 * SDK takes this as an argument and never persists it. */
export interface MandateContext {
  readonly totalAmount?: number;
  readonly totalUses?: number;
  readonly lastUsedDate?: number;
}

/** Merchant identity match: id equality preferred; else non-empty name AND
 * non-empty website both equal. */
export function merchantMatches(candidate: Merchant, target: Merchant): boolean {
  if (candidate.id && target.id) return candidate.id === target.id;
  return (
    Boolean(candidate.name) &&
    Boolean(target.name) &&
    candidate.name === target.name &&
    Boolean(candidate.website) &&
    Boolean(target.website) &&
    candidate.website === target.website
  );
}

export interface PaymentConstraintInputs {
  readonly closedMandate: PaymentMandate;
  /** compute_sd_hash of the open checkout segment (for payment.reference). */
  readonly openCheckoutHash?: string;
  readonly context?: MandateContext;
}

function evaluatePaymentConstraint(
  constraint: PaymentConstraint,
  inputs: PaymentConstraintInputs,
): string[] {
  const violations: string[] = [];
  const closed = inputs.closedMandate;
  switch (constraint.type) {
    case "payment.amount_range": {
      const amount = closed.payment_amount;
      if (amount.currency !== constraint.currency) {
        violations.push(`amount_range: currency ${amount.currency} does not match ${constraint.currency}`);
        break;
      }
      if (constraint.min !== undefined && amount.amount < constraint.min) {
        violations.push(`amount_range: ${amount.amount} below min ${constraint.min}`);
      }
      if (amount.amount > constraint.max) {
        violations.push(`amount_range: ${amount.amount} above max ${constraint.max}`);
      }
      break;
    }
    case "payment.allowed_payees": {
      if (!constraint.allowed.some((m) => merchantMatches(closed.payee, m))) {
        violations.push("allowed_payees: payee is not in the allowed list");
      }
      break;
    }
    case "payment.reference": {
      if (inputs.openCheckoutHash === undefined) {
        violations.push("reference: open checkout hash context is required");
      } else if (inputs.openCheckoutHash !== constraint.conditional_transaction_id) {
        violations.push("reference: conditional_transaction_id does not match the open checkout hash");
      }
      break;
    }
    case "payment.agent_recurrence": {
      // frequency is validated by schema but NOT enforced (Python parity;
      // period windowing is the network's job).
      if (constraint.max_occurrences !== undefined) {
        if (inputs.context === undefined) {
          violations.push("agent_recurrence: mandate context is required");
        } else if ((inputs.context.totalUses ?? 0) >= constraint.max_occurrences) {
          violations.push("agent_recurrence: max_occurrences exceeded");
        }
      }
      break;
    }
    case "payment.allowed_payment_instruments": {
      const allowedIds = constraint.allowed.map((instrument) => instrument.id);
      if (!allowedIds.includes(closed.payment_instrument.id)) {
        violations.push("allowed_payment_instruments: instrument is not allowed");
      }
      break;
    }
    case "payment.allowed_pisps": {
      const pisp = closed.pisp;
      const match =
        pisp !== undefined &&
        constraint.allowed.some(
          (allowed) =>
            allowed.domain_name === pisp.domain_name &&
            allowed.legal_name === pisp.legal_name &&
            allowed.brand_name === pisp.brand_name,
        );
      if (!match) violations.push("allowed_pisps: pisp is not allowed");
      break;
    }
    case "payment.budget": {
      const amount = closed.payment_amount;
      if (amount.currency !== constraint.currency) {
        violations.push(`budget: currency ${amount.currency} does not match ${constraint.currency}`);
        break;
      }
      if (inputs.context === undefined) {
        violations.push("budget: mandate context is required");
        break;
      }
      // Budget.max is MAJOR units; amounts are MINOR units.
      const budgetMinor = Math.round(constraint.max * 100);
      if ((inputs.context.totalAmount ?? 0) + amount.amount > budgetMinor) {
        violations.push("budget: cumulative amount exceeds budget");
      }
      break;
    }
    case "payment.execution_date": {
      const date = closed.execution_date;
      if (date === undefined) break; // absent execution date passes
      if (constraint.not_before !== undefined && date < constraint.not_before) {
        violations.push("execution_date: before not_before");
      }
      if (constraint.not_after !== undefined && date > constraint.not_after) {
        violations.push("execution_date: after not_after");
      }
      break;
    }
    default: {
      const exhaustive: never = constraint;
      violations.push(`unknown constraint: ${JSON.stringify(exhaustive)}`);
    }
  }
  return violations;
}

/** Preset claims on the open mandate must match the closed mandate exactly. */
export function checkPresetPaymentClaims(
  openMandate: OpenPaymentMandate,
  closedMandate: PaymentMandate,
): readonly string[] {
  const violations: string[] = [];
  if (openMandate.payee && !merchantMatches(closedMandate.payee, openMandate.payee)) {
    violations.push("preset: payee does not match the open mandate");
  }
  if (
    openMandate.payment_amount &&
    (openMandate.payment_amount.amount !== closedMandate.payment_amount.amount ||
      openMandate.payment_amount.currency !== closedMandate.payment_amount.currency)
  ) {
    violations.push("preset: payment_amount does not match the open mandate");
  }
  if (
    openMandate.payment_instrument &&
    openMandate.payment_instrument.id !== closedMandate.payment_instrument.id
  ) {
    violations.push("preset: payment_instrument does not match the open mandate");
  }
  if (
    openMandate.execution_date !== undefined &&
    openMandate.execution_date !== closedMandate.execution_date
  ) {
    violations.push("preset: execution_date does not match the open mandate");
  }
  return violations;
}

export interface CheckPaymentConstraintsOptions {
  readonly openCheckoutHash?: string;
  readonly context?: MandateContext;
}

/** All payment constraint checks: presets, the cross-constraint rule, and
 * every evaluator. Returns violations (empty = satisfied). */
export function checkPaymentConstraints(
  openMandate: OpenPaymentMandate,
  closedMandate: PaymentMandate,
  options: CheckPaymentConstraintsOptions = {},
): readonly string[] {
  const violations: string[] = [...checkPresetPaymentClaims(openMandate, closedMandate)];
  const constraints = openMandate.constraints as readonly PaymentConstraint[];
  const has = (type: PaymentConstraint["type"]) => constraints.some((c) => c.type === type);
  if (has("payment.agent_recurrence")) {
    if (!has("payment.amount_range")) {
      violations.push("agent_recurrence requires an amount_range constraint");
    }
    if (!has("payment.budget")) {
      violations.push("agent_recurrence requires a budget constraint");
    }
  }
  const inputs: PaymentConstraintInputs = {
    closedMandate,
    ...(options.openCheckoutHash !== undefined
      ? { openCheckoutHash: options.openCheckoutHash }
      : {}),
    ...(options.context !== undefined ? { context: options.context } : {}),
  };
  for (const constraint of constraints) {
    violations.push(...evaluatePaymentConstraint(constraint, inputs));
  }
  return violations;
}

/** Checkout constraint checks. Line-item matching (max-flow) is a documented
 * follow-on; it currently returns a typed violation rather than passing. */
export function checkCheckoutConstraints(
  openMandate: OpenCheckoutMandate,
  checkout: Checkout,
): readonly string[] {
  const violations: string[] = [];
  for (const constraint of openMandate.constraints as readonly CheckoutConstraint[]) {
    switch (constraint.type) {
      case "checkout.allowed_merchants": {
        const merchant = checkout.merchant;
        if (!merchant || !constraint.allowed.some((m) => merchantMatches(merchant, m))) {
          violations.push("allowed_merchants: checkout merchant is not allowed");
        }
        break;
      }
      case "checkout.line_items": {
        violations.push("line_items: not supported yet (max-flow matching is a follow-on)");
        break;
      }
      default: {
        const exhaustive: never = constraint;
        violations.push(`unknown constraint: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  return violations;
}

// ---- typed chain wrappers -----------------------------------------------------

export interface PaymentMandateChain {
  readonly openMandate: OpenPaymentMandate;
  readonly closedMandate: PaymentMandate;
}

/** Parse exactly two chain payloads into a typed payment mandate chain. */
export function parsePaymentMandateChain(
  payloads: readonly Record<string, unknown>[],
): Result<PaymentMandateChain> {
  if (payloads.length !== 2) {
    return err("payload_invalid", `Expected exactly 2 payloads, got ${payloads.length}`);
  }
  const open = OpenPaymentMandateSchema.safeParse(payloads[0]);
  if (!open.success) return err("payload_invalid", `Open payment mandate invalid: ${open.error.message}`);
  const closed = PaymentMandateSchema.safeParse(payloads[1]);
  if (!closed.success) return err("payload_invalid", `Payment mandate invalid: ${closed.error.message}`);
  return ok({ openMandate: open.data, closedMandate: closed.data });
}

export interface VerifyPaymentMandateChainOptions {
  readonly expectedTransactionId?: string;
  readonly expectedOpenCheckoutHash?: string;
  readonly context?: MandateContext;
  /** When provided, the payment mandate's `transaction_id` is REQUIRED to equal
   * sha-256(checkoutJwt) - the recompute-don't-trust binding between the
   * payment mandate and the checkout it authorizes (schema: transaction_id is
   * the hash of the checkout_jwt value). Prefer this over expectedTransactionId
   * when you hold the checkout JWT. */
  readonly checkoutJwt?: string;
}

export async function verifyPaymentMandateChain(
  chain: PaymentMandateChain,
  options: VerifyPaymentMandateChainOptions = {},
): Promise<readonly string[]> {
  const violations: string[] = [];
  if (
    options.expectedTransactionId !== undefined &&
    chain.closedMandate.transaction_id !== options.expectedTransactionId
  ) {
    violations.push("transaction_id does not match the expected checkout hash");
  }
  if (options.checkoutJwt !== undefined) {
    const actual = await computeSha256B64url(options.checkoutJwt);
    if (chain.closedMandate.transaction_id !== actual) {
      violations.push("transaction_id does not match sha-256(checkout_jwt)");
    }
  }
  violations.push(
    ...checkPaymentConstraints(chain.openMandate, chain.closedMandate, {
      ...(options.expectedOpenCheckoutHash !== undefined
        ? { openCheckoutHash: options.expectedOpenCheckoutHash }
        : {}),
      ...(options.context !== undefined ? { context: options.context } : {}),
    }),
  );
  return violations;
}

export interface CheckoutMandateChain {
  readonly openMandate: OpenCheckoutMandate;
  readonly closedMandate: CheckoutMandate;
}

export function parseCheckoutMandateChain(
  payloads: readonly Record<string, unknown>[],
): Result<CheckoutMandateChain> {
  if (payloads.length !== 2) {
    return err("payload_invalid", `Expected exactly 2 payloads, got ${payloads.length}`);
  }
  const open = OpenCheckoutMandateSchema.safeParse(payloads[0]);
  if (!open.success) return err("payload_invalid", `Open checkout mandate invalid: ${open.error.message}`);
  const closed = CheckoutMandateSchema.safeParse(payloads[1]);
  if (!closed.success) return err("payload_invalid", `Checkout mandate invalid: ${closed.error.message}`);
  return ok({ openMandate: open.data, closedMandate: closed.data });
}

/** Decode the Checkout object out of a checkout_jwt WITHOUT verifying its
 * signature (Python parity: the merchant signed it and is the caller; chain
 * verification already proved integrity via checkout_hash). */
export function extractParsedCheckoutObject(checkoutJwt: string): Result<Checkout> {
  const payloadSegment = checkoutJwt.split(".")[1];
  if (!payloadSegment) return err("malformed_token", "checkout_jwt is not a JWT");
  let raw: unknown;
  try {
    raw = JSON.parse(b64urlDecode(payloadSegment));
  } catch {
    return err("malformed_token", "checkout_jwt payload is not base64url JSON");
  }
  const parsed = CheckoutSchema.safeParse(raw);
  if (!parsed.success) return err("payload_invalid", `Checkout invalid: ${parsed.error.message}`);
  return ok(parsed.data);
}

export interface VerifyCheckoutMandateChainOptions {
  readonly checkoutJwt: string;
  readonly expectedCheckoutHash?: string;
}

/**
 * Verify a checkout mandate chain. The `checkoutJwt` drives merchant and
 * line-item constraint evaluation, so it MUST be cryptographically bound to the
 * signed mandate: the schema defines `checkout_hash` as the hash of the
 * `checkout_jwt` value. We RECOMPUTE that hash and require it to equal
 * `closedMandate.checkout_hash` - never trust the claim alone. Without this a
 * relay can swap in any well-formed checkout JWT (attacker-chosen merchant and
 * line items) while the mandate chain still verifies.
 *
 * v1 recomputes with sha-256 (the schema default and the overwhelming case). A
 * checkout mandate that pins a non-default `_sd_alg` is out of v1 scope.
 */
export async function verifyCheckoutMandateChain(
  chain: CheckoutMandateChain,
  options: VerifyCheckoutMandateChainOptions,
): Promise<readonly string[]> {
  const violations: string[] = [];
  // Bind the checkout object to the signed mandate before trusting its contents.
  const actualHash = await computeSha256B64url(options.checkoutJwt);
  if (chain.closedMandate.checkout_hash !== actualHash) {
    // The evidence is unauthenticated - do not evaluate its constraints.
    return ["checkout_jwt does not match the mandate checkout_hash"];
  }
  const checkoutResult = extractParsedCheckoutObject(options.checkoutJwt);
  if (!checkoutResult.ok) return [checkoutResult.error.message];
  violations.push(...checkCheckoutConstraints(chain.openMandate, checkoutResult.value));
  if (options.expectedCheckoutHash !== undefined) {
    if (chain.closedMandate.checkout_hash !== options.expectedCheckoutHash) {
      violations.push("checkout_hash does not match the expected value");
    }
  }
  return violations;
}
