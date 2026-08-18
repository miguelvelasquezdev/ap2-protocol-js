import { describe, expect, it } from "vitest";
import {
  b64urlEncode,
  computeSdHash,
  createMandate,
  parseToken,
  presentMandate,
  resolveDisclosures,
  verifyBinding,
  verifyMandate,
  type ParsedToken,
  type PublicKeyProvider,
} from "../src/index.ts";
import {
  createPropertyDisclosure,
  computeDisclosureDigest,
} from "../src/sdjwt/disclosure.ts";
import { cnf, counterSalts, FROZEN_NOW, makeKeypair, samplePaymentMandate } from "./fixtures.ts";

/** Replace the payload segment of the issuer JWT inside an SD-JWT token. */
function tamperPayload(token: string, mutate: (payload: Record<string, unknown>) => void): string {
  const parsed = parseToken(token);
  const [h, p, s] = parsed.issuerJwt.split(".");
  const payload = JSON.parse(Buffer.from(p ?? "", "base64url").toString());
  mutate(payload);
  const newP = b64urlEncode(JSON.stringify(payload));
  const newJwt = `${h}.${newP}.${s}`;
  return [newJwt, ...parsed.disclosures, ""].join("~") + parsed.kbJwt;
}

describe("signature attacks (single token)", () => {
  it("rejects an alg:none forgery", async () => {
    const issuer = await makeKeypair("issuer");
    const header = b64urlEncode(JSON.stringify({ alg: "none", typ: "JWT" }));
    const payload = b64urlEncode(JSON.stringify(samplePaymentMandate()));
    const forged = `${header}.${payload}.~`;
    const result = await verifyMandate({ token: forged, key: issuer.publicJwk, nowSeconds: FROZEN_NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("signature_invalid");
  });

  it("rejects a tampered payload (claims changed after signing)", async () => {
    const issuer = await makeKeypair("issuer");
    const token = await createMandate({
      payload: samplePaymentMandate(),
      issuerKey: issuer.privateJwk,
      saltSource: counterSalts(),
    });
    // The mandate payload rides in a delegate_payload disclosure; mutating the
    // signed JWS body (its commitment to that payload) must break the issuer
    // signature.
    const tampered = tamperPayload(token, (p) => {
      p["delegate_payload"] = [{ "...": "0000000000000000000000000000000000000000000" }];
    });
    const result = await verifyMandate({ token: tampered, key: issuer.publicJwk, nowSeconds: FROZEN_NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("signature_invalid");
  });

  it("rejects a token verified under a different curve's key shape", async () => {
    const issuer = await makeKeypair("issuer");
    const token = await createMandate({
      payload: samplePaymentMandate(),
      issuerKey: issuer.privateJwk,
      saltSource: counterSalts(),
    });
    const badKey = { ...issuer.publicJwk, kty: "RSA" };
    const result = await verifyMandate({ token, key: badKey, nowSeconds: FROZEN_NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_key");
  });
});

describe("disclosure integrity", () => {
  it("rejects an unreferenced (tampered) disclosure", async () => {
    const issuer = await makeKeypair("issuer");
    const token = await createMandate({
      payload: samplePaymentMandate(),
      issuerKey: issuer.privateJwk,
      sd: { sdKeys: ["transaction_id"] },
      saltSource: counterSalts(),
    });
    const parsed = parseToken(token);
    // Swap the disclosure for one the payload never committed to.
    const rogue = createPropertyDisclosure("x", "transaction_id", "rogue");
    const forged = [parsed.issuerJwt, rogue, ""].join("~");
    const result = await verifyMandate({ token: forged, key: issuer.publicJwk, nowSeconds: FROZEN_NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("disclosure_invalid");
  });

  it("rejects duplicate disclosure digests (RFC 9901 s7.1)", async () => {
    const issuer = await makeKeypair("issuer");
    const token = await createMandate({
      payload: samplePaymentMandate(),
      issuerKey: issuer.privateJwk,
      sd: { sdKeys: ["transaction_id"] },
      saltSource: counterSalts(),
    });
    const parsed = parseToken(token);
    const dup = [...parsed.disclosures, parsed.disclosures[0] ?? ""];
    await expect(resolveDisclosures(parsed.payload, dup, "sha-256")).rejects.toThrow(/Duplicate/);
  });

  it("does not pollute Object.prototype via a __proto__ disclosure", async () => {
    // A property disclosure named __proto__ must not corrupt the prototype.
    const disclosure = createPropertyDisclosure("salt", "__proto__", { polluted: true });
    const digest = await computeDisclosureDigest(disclosure, "sha-256");
    const resolved = await resolveDisclosures({ _sd: [digest] }, [disclosure], "sha-256");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.getPrototypeOf(resolved)).toBe(Object.prototype);
  });
});

describe("binding XOR rule", () => {
  async function prevToken(): Promise<ParsedToken> {
    const issuer = await makeKeypair("issuer");
    const token = await createMandate({
      payload: samplePaymentMandate(),
      issuerKey: issuer.privateJwk,
      saltSource: counterSalts(),
    });
    return parseToken(token);
  }

  it("rejects a payload with NEITHER binding claim", async () => {
    const prev = await prevToken();
    await expect(verifyBinding({ iat: 1 }, prev)).rejects.toThrow(/Exactly one/);
  });

  it("rejects a payload with BOTH binding claims", async () => {
    const prev = await prevToken();
    const sd = await computeSdHash(prev);
    await expect(
      verifyBinding({ sd_hash: sd, issuer_jwt_hash: sd }, prev),
    ).rejects.toThrow(/Exactly one/);
  });
});

describe("chain temporal and key edge cases", () => {
  async function buildTwoHop(overrides: Record<string, unknown>, nowSeconds: number) {
    const issuer = await makeKeypair("issuer");
    const holder = await makeKeypair("holder");
    const open = await createMandate({
      payload: {
        vct: "mandate.payment.open.1",
        constraints: [{ type: "payment.reference", conditional_transaction_id: "chk" }],
        cnf: cnf(holder.publicJwk),
      },
      issuerKey: issuer.privateJwk,
      saltSource: counterSalts(),
    });
    const chain = await presentMandate({
      holderKey: holder.privateJwk,
      mandateToken: open,
      payload: samplePaymentMandate(overrides),
      aud: "a",
      nonce: "n",
      saltSource: counterSalts(),
      nowSeconds,
    });
    return { issuer, chain };
  }

  it("accepts a future iat within clock skew", async () => {
    const { issuer, chain } = await buildTwoHop({}, FROZEN_NOW + 100);
    const resolveKey: PublicKeyProvider = () => issuer.publicJwk;
    const result = await verifyMandate({
      token: chain,
      resolveKey,
      expectedAud: "a",
      expectedNonce: "n",
      clockSkewSeconds: 300,
      nowSeconds: FROZEN_NOW,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a future iat beyond clock skew", async () => {
    const { issuer, chain } = await buildTwoHop({}, FROZEN_NOW + 10_000);
    const result = await verifyMandate({
      token: chain,
      resolveKey: () => issuer.publicJwk,
      expectedAud: "a",
      expectedNonce: "n",
      clockSkewSeconds: 300,
      nowSeconds: FROZEN_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("iat_invalid");
  });

  it("rejects a wrong nonce at the terminal hop", async () => {
    const { issuer, chain } = await buildTwoHop({}, FROZEN_NOW);
    const result = await verifyMandate({
      token: chain,
      resolveKey: () => issuer.publicJwk,
      expectedAud: "a",
      expectedNonce: "WRONG",
      nowSeconds: FROZEN_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("nonce_mismatch");
  });

  it("rejects a wrong aud at the terminal hop", async () => {
    const { issuer, chain } = await buildTwoHop({}, FROZEN_NOW);
    const result = await verifyMandate({
      token: chain,
      resolveKey: () => issuer.publicJwk,
      expectedAud: "WRONG",
      expectedNonce: "n",
      nowSeconds: FROZEN_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("aud_mismatch");
  });
});

describe("malformed input", () => {
  it("rejects an empty string", async () => {
    const issuer = await makeKeypair("issuer");
    const result = await verifyMandate({ token: "", key: issuer.publicJwk });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unsupported_format");
  });

  it("rejects a random non-token string", async () => {
    const issuer = await makeKeypair("issuer");
    const result = await verifyMandate({ token: "not-a-token~", key: issuer.publicJwk });
    expect(result.ok).toBe(false);
  });

  it("single-token mode requires a key", async () => {
    const result = await verifyMandate({ token: "a.b.c~" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("missing_key");
  });
});
