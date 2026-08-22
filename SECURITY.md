# Security Policy

`ap2-protocol-js` is a cryptographic verification library: its correctness is
its entire value. This document describes its security posture and how to report
a vulnerability.

## Status: pre-audit

This SDK is experimental (pre-1.0) and has **not** undergone an independent
third-party security audit. It has, however, been through an internal adversarial
review (algorithm-confusion, key-injection, SD-JWT disclosure integrity,
mandate-chain replay, and constraint fail-open classes). Do not rely on it as the
sole control for authorizing real payments until it has been independently
reviewed. Treat every release in the 0.x line as subject to change.

## Design principles

- **Fail closed.** Verification returns a typed `Result`; a denied credential is
  a value, never a thrown surprise. Unknown or malformed input is rejected, not
  coerced.
- **No trust in attacker-supplied key material.** Algorithms are pinned to ES256
  and keys are always caller-supplied; the library never selects a verification
  key from a token header (`jwk`/`jku`/`kid`/`x5c`/`x5u`).
- **Recompute, do not trust.** Binding hashes (`sd_hash`, `checkout_hash`,
  `transaction_id`) are recomputed and compared, never read and believed.
- **No side effects.** The library performs no filesystem, network, or logging
  I/O, and never logs token contents, claims, or key material.

## Key discovery

Resolving the **root issuer's** public key is the integrator's responsibility,
by design — the library never trusts a key named in the token. Pass the resolved
key via `resolveKey` (chain) or `key` (single token). Do this however your trust
model requires: a JWKS endpoint (with your own allowlist, `kid` rotation, and
SSRF protection), a DID document, or your own `x5c` certificate-chain validation
against trusted roots. Built-in `x5c` chain resolution is intentionally not
bundled — `x5cPublicKeyProvider()` fails closed and directs you to `resolveKey`.
(An audited built-in `x5c` provider is a candidate for a future release.)

## Stateful constraints (budget / recurrence) — you own persistence

The `payment.budget` and `payment.agent_recurrence` constraints are evaluated
against counters you pass in `MandateContext` (`totalAmount`, `totalUses`,
`lastUsedDate`). **The SDK never persists these and does no locking** — it reads
what you hand it. To actually prevent over-spend or replay you MUST back these
counters with a **durable, atomic, race-safe** store and update them under a
transaction/idempotency key around each authorization; otherwise concurrent
requests can each read a stale counter and double-spend. See
`example/enforce-budget.mjs` for the load → verify → commit flow and
`test/mandate-context-concurrency.test.ts` for the atomic reference pattern
(and a demonstration that the naive pattern double-spends). Also note
`agent_recurrence` enforces `max_occurrences` only — `frequency`/period windowing
is not evaluated by the SDK (parity with the reference; it is the network's job).

## Resource limits (DoS)

Verification is synchronous and runs server-side on untrusted input, so it is
bounded to fail closed rather than exhaust CPU or the stack. The line-item
matcher rejects a checkout with more than 1000 line items or 1000 requirements,
or whose matching graph would exceed ~50k edges (distinct SKUs × requirements) —
a real checkout is tens of items. Disclosure resolution rejects JSON nested past
256 levels. These bounds are generous for real mandates and stop a crafted token
from freezing the event loop or overflowing the stack.

## Line-item quantities

The `checkout.line_items` matcher rejects any line item or requirement with a
**negative or non-integer quantity**, fail-closed. This is a deliberate
divergence from the reference, which nets quantities: without the guard,
`[A×5, A×−4]` would satisfy a `quantity: 1` slot, and `[Z×5, Z×−5]` would smuggle
an unauthorized SKU past the uncovered-item check by netting it to zero. A
negative line-item quantity has no legitimate meaning, so we reject rather than
net.

## Payment mandates without a separate checkout mandate

A payment mandate schema requires at least one `payment.reference` constraint,
whose `conditional_transaction_id` is checked against the `expectedOpenCheckoutHash`
you pass at verify time. When you mint a checkout mandate, that value is its
`sd_hash`. When you DON'T (a payment-only v1 with no checkout step), the supported
pattern is to use a **stable identifier for the thing being paid — your order
id** — as BOTH the constraint's `conditional_transaction_id` and the verifier's
`expectedOpenCheckoutHash`. That is not a workaround: it binds the chain to
exactly one order, which is the property `payment.reference` exists to give. Use
an id the client cannot forge (server-minted), and pass the same value on both
sides.

## Signature malleability and receipt references

ECDSA signatures are malleable (WebCrypto does not enforce low-S), and the SDK
accepts both forms — as it must to interoperate with signers that do not
normalize. Consequence: a receipt `reference` derived from the closed mandate's
raw JWT bytes is NOT unique across two signature-equivalent presentations of the
same mandate. Do not use `reference` alone as an idempotency / already-seen key;
combine it with the mandate's `aud`, `nonce`, and `transaction_id` (signed
content that cannot be malleated).

## Amount units (read this before setting `max`)

Two constraints carry amounts, in **two different units** — this mirrors the
reference `ap2.sdk` exactly and is not something this port will "fix" (aligning
them would break cross-implementation parity):

- **`payment.amount_range`** — `min`/`max` are **unscaled**, in the SAME unit as
  `payment_amount.amount` (the currency's smallest/minor unit, e.g. cents). A
  range of `{min: 500, max: 500}` on a USD mandate pins the amount to exactly
  $5.00.
- **`payment.budget`** — `max` is a **major** unit and is scaled **×100** before
  it is compared against the (minor-unit) amount. `{max: 5}` on USD is a $5.00
  cumulative cap.

**Zero-decimal currencies (COP, JPY, CLP, …):** 1 major == 1 minor, so a
`budget.max` written in whole pesos/yen is silently 100× too large. To bind an
exact amount in those currencies use `amount_range` (unscaled) with
`min == max`; reserve `budget` for cumulative caps and size it in major units
accordingly.

## Amount floors

`payment.amount_range` matches the reference exactly: `min` and `max` are each
optional and only checked when present. A range with no `min` permits any amount
at or below `max`, including zero or negative. If you require a positive floor,
the mandate author must set an explicit `min` (e.g. `min: 1`), or pin the exact
amount with `min == max`.

## Redaction-tolerant binding is opt-in

The `issuer_jwt_hash` hop binding covers the previous JWS but not its disclosures
(that is the redaction-privacy property). Because a relay could then add or strip
disclosures, verification REJECTS it by default; pass `allowIssuerJwtHash: true`
only if you deliberately use redactable intermediate hops. The default `sd_hash`
binding covers disclosures and is tamper-evident.

## Supported versions

The current `0.x` pre-release line is the only supported version. Security fixes
land on the latest `0.x`.

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** via
[GitHub private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, rather than opening a public issue.

- We aim to acknowledge a report within a few business days.
- We will work with you on a coordinated disclosure timeline (target: 90 days or
  sooner once a fix is available).
- Please include a minimal reproduction (a token/chain and the expected vs actual
  verdict) where possible.

Thank you for helping make agent payment verification trustworthy.
