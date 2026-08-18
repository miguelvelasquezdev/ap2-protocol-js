import { describe, expect, it } from "vitest";
import {
  createMandate,
  createSdJwt,
  parseToken,
  presentMandate,
  resolveDisclosures,
  verifyChain,
  verifyMandate,
  type PublicKeyProvider,
} from "../src/index.ts";
import {
  computeDisclosureDigest,
  createPropertyDisclosure,
} from "../src/sdjwt/disclosure.ts";
import { cnf, counterSalts, FROZEN_NOW, makeKeypair, samplePaymentMandate } from "./fixtures.ts";

/** A verified two-hop chain builder with a chosen binding mode. */
async function twoHop(hashMode: "sd_hash" | "issuer_jwt_hash" = "sd_hash") {
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
    payload: samplePaymentMandate(),
    aud: "cp",
    nonce: "n",
    hashMode,
    saltSource: counterSalts(),
    nowSeconds: FROZEN_NOW,
  });
  return { issuer, chain };
}

describe("replay: aud/nonce are required, not optional", () => {
  it("verifyChain now requires expectedAud/expectedNonce at the type level", async () => {
    const { issuer, chain } = await twoHop();
    const tokens = [parseToken(chain.split("~~")[0] + "~"), parseToken(chain.split("~~")[1] ?? "")];
    // @ts-expect-error expectedAud/expectedNonce are required by the type.
    const bad = verifyChain(tokens, { resolveKey: () => issuer.publicJwk });
    // At runtime the missing terminal aud/nonce comparison rejects.
    const result = await bad;
    expect(result.ok).toBe(false);
  });

  it("verifyMandate rejects a chain with no expectedAud/expectedNonce", async () => {
    const { issuer, chain } = await twoHop();
    const result = await verifyMandate({ token: chain, resolveKey: () => issuer.publicJwk });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("aud_nonce_required");
  });

  it("a terminal hop MISSING aud/nonce is rejected (present-and-match, not skip)", async () => {
    // Build a chain then verify with the correct aud/nonce -> ok; with a
    // different verifier nonce -> replay is caught.
    const { issuer, chain } = await twoHop();
    const good = await verifyMandate({
      token: chain,
      resolveKey: () => issuer.publicJwk,
      expectedAud: "cp",
      expectedNonce: "n",
      nowSeconds: FROZEN_NOW,
    });
    expect(good.ok).toBe(true);
    const replay = await verifyMandate({
      token: chain,
      resolveKey: () => issuer.publicJwk,
      expectedAud: "cp",
      expectedNonce: "a-different-verifiers-nonce",
      nowSeconds: FROZEN_NOW,
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe("nonce_mismatch");
  });
});

describe("requireHashMode: verifier can refuse redaction-tolerant binding", () => {
  it("rejects an issuer_jwt_hash chain when sd_hash is required", async () => {
    const { issuer, chain } = await twoHop("issuer_jwt_hash");
    const resolveKey: PublicKeyProvider = () => issuer.publicJwk;
    const strict = await verifyMandate({
      token: chain,
      resolveKey,
      expectedAud: "cp",
      expectedNonce: "n",
      requireHashMode: "sd_hash",
      nowSeconds: FROZEN_NOW,
    });
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.error.code).toBe("binding_mismatch");

    // With the redaction opt-in the same chain verifies.
    const lax = await verifyMandate({
      token: chain,
      resolveKey,
      allowIssuerJwtHash: true,
      expectedAud: "cp",
      expectedNonce: "n",
      nowSeconds: FROZEN_NOW,
    });
    expect(lax.ok).toBe(true);
  });
});

describe("RFC 9901 s7.1 resolver correctness", () => {
  it("rejects an unrecognized _sd_alg instead of coercing to sha-256", async () => {
    const issuer = await makeKeypair("issuer");
    // Build an inline root so _sd_alg lands at the top level of the JWS body
    // (createMandate now nests the payload in a delegate_payload disclosure).
    const token = await createSdJwt({
      claims: { ...samplePaymentMandate(), _sd_alg: "sha-1" },
      issuerKey: issuer.privateJwk,
      saltSource: counterSalts(),
    });
    const result = await verifyMandate({ token, key: issuer.publicJwk, nowSeconds: FROZEN_NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unsupported_format");
  });

  it("rejects a disclosure whose name is _sd or ...", async () => {
    const bad = createPropertyDisclosure("salt", "_sd", ["x"]);
    const digest = await computeDisclosureDigest(bad, "sha-256");
    await expect(
      resolveDisclosures({ _sd: [digest] }, [bad], "sha-256"),
    ).rejects.toThrow(/Illegal disclosure name/);
  });

  it("rejects a disclosure that collides with an existing cleartext claim", async () => {
    const collide = createPropertyDisclosure("salt", "amount", 1);
    const digest = await computeDisclosureDigest(collide, "sha-256");
    await expect(
      resolveDisclosures({ amount: 999, _sd: [digest] }, [collide], "sha-256"),
    ).rejects.toThrow(/collides/);
  });
});

describe("time-claim hardening", () => {
  it("rejects a non-finite exp (Infinity never expires)", async () => {
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
    // 1e400 parses to Infinity; inject it as the closed mandate exp.
    const chain = await presentMandate({
      holderKey: holder.privateJwk,
      mandateToken: open,
      payload: samplePaymentMandate({ exp: 1e400 }),
      aud: "cp",
      nonce: "n",
      saltSource: counterSalts(),
      nowSeconds: FROZEN_NOW,
    });
    const result = await verifyMandate({
      token: chain,
      resolveKey: () => issuer.publicJwk,
      expectedAud: "cp",
      expectedNonce: "n",
      nowSeconds: FROZEN_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("expired");
  });

  it("rejects a delegate item that is not yet valid (nbf in the future)", async () => {
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
      payload: samplePaymentMandate({ nbf: FROZEN_NOW + 100_000 }),
      aud: "cp",
      nonce: "n",
      saltSource: counterSalts(),
      nowSeconds: FROZEN_NOW,
    });
    const result = await verifyMandate({
      token: chain,
      resolveKey: () => issuer.publicJwk,
      expectedAud: "cp",
      expectedNonce: "n",
      nowSeconds: FROZEN_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("iat_invalid");
  });
});
