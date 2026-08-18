import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseCheckoutMandateChain,
  parsePaymentMandateChain,
  verifyCheckoutMandateChain,
  verifyMandate,
  verifyPaymentMandateChain,
  verifyReceipt,
  type Jwk,
} from "../src/index.ts";

/**
 * Cross-implementation vectors: chains/receipts SIGNED by the reference Python
 * ap2.sdk and VERIFIED here. Generate with scripts/generate-fixtures.py. A green
 * suite proves ap2-protocol-js interoperates with the reference on the wire
 * (same SD-JWT chain format, crypto, binding, and constraint semantics) — not
 * just that it is self-consistent.
 *
 * Two verification layers are asserted independently, matching the reference:
 *   - `should_verify`  → verifyMandate (signatures, binding, aud/nonce)
 *   - `constraints_ok` → verifyPaymentMandateChain (business constraints)
 */
interface Vector {
  name: string;
  kind: "single" | "chain" | "checkout-chain" | "receipt";
  issuer_jwk: Jwk;
  token: string;
  expected_aud?: string;
  expected_nonce?: string;
  now?: number;
  should_verify: boolean;
  // Constraint layer (chains):
  expected_open_checkout_hash?: string;
  expected_transaction_id?: string;
  constraints_ok?: boolean;
  // Checkout chains:
  checkout_jwt?: string;
  // Receipts:
  receipt_kind?: "payment" | "checkout";
  reference?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, "fixtures", "vectors.json");
const vectors: Vector[] = JSON.parse(readFileSync(file, "utf8")).vectors ?? [];

describe("cross-impl vectors (reference Python -> TS verify)", () => {
  if (vectors.length === 0) {
    it.skip("no vectors committed yet (run scripts/generate-fixtures.py)", () => {});
    return;
  }
  for (const v of vectors) {
    it(`${v.should_verify ? "verifies" : "rejects"}: ${v.name}`, async () => {
      if (v.kind === "receipt") {
        const result = await verifyReceipt({
          receiptJwt: v.token,
          issuerKey: v.issuer_jwk,
          hasReference: (r) => r === v.reference,
          kind: v.receipt_kind ?? "payment",
        });
        expect(result.ok).toBe(v.should_verify);
        return;
      }

      const result = await verifyMandate({
        token: v.token,
        key: v.issuer_jwk,
        resolveKey: () => v.issuer_jwk,
        ...(v.expected_aud !== undefined ? { expectedAud: v.expected_aud } : {}),
        ...(v.expected_nonce !== undefined ? { expectedNonce: v.expected_nonce } : {}),
        ...(v.now !== undefined ? { nowSeconds: v.now } : {}),
      });
      expect(result.ok).toBe(v.should_verify);

      // Constraint layer: only meaningful once the chain crypto-verifies.
      if (v.constraints_ok !== undefined && result.ok && result.value.kind === "chain") {
        let violations: readonly string[];
        if (v.kind === "checkout-chain") {
          const parsed = parseCheckoutMandateChain(result.value.payloads);
          expect(parsed.ok).toBe(true);
          if (!parsed.ok) return;
          violations = await verifyCheckoutMandateChain(parsed.value, { checkoutJwt: v.checkout_jwt! });
        } else {
          const parsed = parsePaymentMandateChain(result.value.payloads);
          expect(parsed.ok).toBe(true);
          if (!parsed.ok) return;
          violations = await verifyPaymentMandateChain(parsed.value, {
            ...(v.expected_transaction_id !== undefined
              ? { expectedTransactionId: v.expected_transaction_id }
              : {}),
            ...(v.expected_open_checkout_hash !== undefined
              ? { expectedOpenCheckoutHash: v.expected_open_checkout_hash }
              : {}),
          });
        }
        expect(violations.length === 0).toBe(v.constraints_ok);
      }
    });
  }
});
