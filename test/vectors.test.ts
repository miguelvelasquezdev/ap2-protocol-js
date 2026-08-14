import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verifyMandate, verifyReceipt, type Jwk } from "../src/index.ts";

/**
 * Cross-implementation vectors: chains/receipts SIGNED by the reference Python
 * ap2.sdk and VERIFIED here. Generate with scripts/generate-fixtures.py. When
 * the file is the empty scaffold the suite is a no-op placeholder that turns
 * live as soon as vectors are committed.
 */
interface Vector {
  name: string;
  kind: "single" | "chain" | "receipt";
  issuer_jwk: Jwk;
  token: string;
  expected_aud?: string;
  expected_nonce?: string;
  now?: number;
  should_verify: boolean;
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
    });
  }
});
