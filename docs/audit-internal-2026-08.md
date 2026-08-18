# Internal adversarial security audit — ap2-protocol-js

**Date:** 2026-08 · **Scope:** the whole SDK (SD-JWT chain verification, mandate
constraints, receipts, crypto). **Method:** 3 parallel offensive red-team passes
(crypto/signature/chain, parsing/disclosure/logic, DoS/resource) each writing and
running PoC exploit tests, plus a SAST + dependency pass. This is the internal
pass that precedes a third-party audit.

## Headline

**No authentication or authorization bypass was found.** Across three
independent attackers, none could forge acceptance of a credential the SDK should
reject, or flip a verdict. The cryptographic core — ES256 algorithm pinning
(no alg:none / HS256 / kty confusion), never trusting a key named in the token,
the signature-gated chain walk (each hop under the prior hop's `cnf`), `sd_hash`
binding, and mandatory `aud`/`nonce` replay defense — held against every attack.
The findings are hardening and robustness, not bypass.

## SAST / dependencies

Clean: no `eval`/`Function`, no `node:crypto`/`Buffer` (WebCrypto-only holds),
no dependency CVEs (`jose`, `zod`), prototype-pollution sink on the attacker path
guarded (`Object.defineProperty`), only anchored single-char base64url RegExps
(no ReDoS).

## Findings and disposition

| Sev | Finding | Disposition |
|---|---|---|
| HIGH | max-flow line-item DoS: ~350 KB crafted checkout froze the sync matcher ~21 s | **Fixed** — fail-closed caps (items/requirements ≤ 1000, ≤ 50k matching edges) |
| MEDIUM | recursive resolver stack overflow on deeply nested disclosed JSON | **Fixed** — 256-level depth cap → `Ap2Error` |
| MEDIUM | `issuer_jwt_hash` binding excludes disclosures and was accepted by default | **Fixed** — rejected by default; `allowIssuerJwtHash` opt-in |
| MEDIUM | ECDSA malleability → signature-derived receipt `reference` non-unique | **Documented** — rejecting high-S would break interop; dedup on aud+nonce+transaction_id |
| LOW | negative amount under a `max`-only range | **Documented** — confirmed Python parity; set an explicit `min` |
| INFO | root exempt from 1-delegate-item rule; `payment.reference` caller-asserted; negative line-item qty; >2⁵³ float precision | Noted; not exploitable through the public gates |

## Verification

All fixes shipped with regression tests. `pnpm test` 112 green, `tsc --noEmit`
clean, `publint` clean, and both directions of cross-implementation interop with
the reference Python `ap2.sdk` still pass. Remediation commit: `1474f89`.

## For the third-party audit

The design is audit-ready. Focus areas to hand the external firm: the SD-JWT
chain-walk + binding logic (`src/sdjwt/`), the delegate_payload wrapping, the
constraint evaluators (`src/constraints/`), and the ECDSA-malleability /
receipt-reference question (a spec-level consideration worth raising upstream).
