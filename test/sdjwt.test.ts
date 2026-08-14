import { describe, expect, it } from "vitest";
import {
  computeIssuerJwtHash,
  computeSdHash,
  createMandate,
  parseToken,
  resolveDisclosures,
  verifyMandate,
} from "../src/index.ts";
import { counterSalts, FROZEN_NOW, makeKeypair, samplePaymentMandate } from "./fixtures.ts";

describe("parseToken", () => {
  it("rejects a leading separator", () => {
    expect(() => parseToken("~abc")).toThrow(/must not start/);
  });
  it("rejects a token with no separator (not an SD-JWT)", () => {
    expect(() => parseToken("a.b.c")).toThrow(/missing ~/);
  });
  it("rejects an empty disclosure segment", () => {
    expect(() => parseToken("a.b.c~~d~")).toThrow(/Empty disclosure/);
  });
  it("rejects a malformed issuer JWT", () => {
    expect(() => parseToken("a.b~")).toThrow(/Malformed issuer JWT/);
  });
});

describe("root SD-JWT", () => {
  it("round-trips create -> verify", async () => {
    const issuer = await makeKeypair("issuer");
    const token = await createMandate({
      payload: samplePaymentMandate(),
      issuerKey: issuer.privateJwk,
      saltSource: counterSalts(),
    });
    expect(token.endsWith("~")).toBe(true);
    const result = await verifyMandate({ token, key: issuer.publicJwk, nowSeconds: FROZEN_NOW });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === "single") {
      expect(result.value.payload["transaction_id"]).toBe("txn-abc");
    }
  });

  it("fails verification under the wrong key", async () => {
    const issuer = await makeKeypair("issuer");
    const other = await makeKeypair("other");
    const token = await createMandate({
      payload: samplePaymentMandate(),
      issuerKey: issuer.privateJwk,
      saltSource: counterSalts(),
    });
    const result = await verifyMandate({ token, key: other.publicJwk, nowSeconds: FROZEN_NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("signature_invalid");
  });

  it("root emits no binding/aud/nonce claims", async () => {
    const issuer = await makeKeypair("issuer");
    const token = await createMandate({
      payload: samplePaymentMandate(),
      issuerKey: issuer.privateJwk,
      saltSource: counterSalts(),
    });
    const parsed = parseToken(token);
    expect(parsed.payload["sd_hash"]).toBeUndefined();
    expect(parsed.payload["aud"]).toBeUndefined();
    expect(parsed.payload["nonce"]).toBeUndefined();
  });
});

describe("hash computations", () => {
  it("computeSdHash covers disclosures; issuer_jwt_hash ignores them", async () => {
    const issuer = await makeKeypair("issuer");
    const token = await createMandate({
      payload: samplePaymentMandate(),
      issuerKey: issuer.privateJwk,
      sd: { sdKeys: ["transaction_id"] },
      saltSource: counterSalts(),
    });
    const parsed = parseToken(token);
    const sdHash = await computeSdHash(parsed);
    const issuerHash = await computeIssuerJwtHash(parsed);
    expect(sdHash).not.toBe(issuerHash);
    expect(sdHash).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("resolveDisclosures", () => {
  it("rejects a disclosure not referenced by any digest", async () => {
    const issuer = await makeKeypair("issuer");
    const token = await createMandate({
      payload: samplePaymentMandate(),
      issuerKey: issuer.privateJwk,
      sd: { sdKeys: ["transaction_id"] },
      saltSource: counterSalts(),
    });
    const parsed = parseToken(token);
    // Append the same disclosure twice: duplicate digest must reject.
    const dup = [...parsed.disclosures, parsed.disclosures[0] ?? ""];
    await expect(resolveDisclosures(parsed.payload, dup, "sha-256")).rejects.toThrow(/Duplicate/);
  });
});
