import { describe, expect, it } from "vitest";
import {
  createMandate,
  decodeDisclosure,
  parseToken,
  presentMandate,
  sdJwtOf,
  splitChain,
  verifyMandate,
  type PublicKeyProvider,
} from "../src/index.ts";
import { cnf, counterSalts, FROZEN_NOW, makeKeypair, samplePaymentMandate } from "./fixtures.ts";

/**
 * Drop a named property disclosure from the FIRST segment of a chain, without
 * recomputing any downstream binding. This models a middle party (e.g. a
 * credentials provider) forwarding a redacted upstream token: it cannot re-sign
 * the hop that bound to the original, so the binding is tested as-is.
 */
function redactRootDisclosure(chain: string, name: string): string {
  const segments = chain.split("~~");
  const first = segments[0] ?? "";
  const token = parseToken(first.endsWith("~") ? first : `${first}~`);
  const kept = token.disclosures.filter((d) => {
    const decoded = decodeDisclosure(d);
    return decoded.kind !== "property" || decoded.name !== name;
  });
  const redacted = sdJwtOf({ ...token, disclosures: kept });
  // Re-strip the trailing ~ that the ~~ join removes from a non-final segment.
  segments[0] = redacted.endsWith("~") ? redacted.slice(0, -1) : redacted;
  return segments.join("~~");
}

/**
 * The issuer_jwt_hash privacy property: a downstream party can DROP a
 * disclosure the issuer made and the chain still verifies, because the SA hop
 * binds to the issuer JWT (not the disclosures). Under sd_hash the same
 * redaction MUST fail with an sd_hash mismatch.
 */
describe("issuer_jwt_hash redaction property", () => {
  async function buildChain(hashMode: "sd_hash" | "issuer_jwt_hash") {
    const issuer = await makeKeypair("issuer");
    const agent = await makeKeypair("agent");
    const holder = await makeKeypair("holder");
    // Root discloses `secret`; a downstream party will drop it.
    const open = await createMandate({
      payload: {
        vct: "mandate.payment.open.1",
        constraints: [{ type: "payment.reference", conditional_transaction_id: "chk-1" }],
        cnf: cnf(agent.publicJwk),
        secret: "top-secret",
      },
      issuerKey: issuer.privateJwk,
      sd: { sdKeys: ["secret"] },
      saltSource: counterSalts(),
    });
    // SA (agent) hop binds to the FULL root with the chosen hash mode.
    const intermediate = await presentMandate({
      holderKey: agent.privateJwk,
      mandateToken: open,
      payload: {
        vct: "mandate.payment.open.1",
        constraints: [{ type: "payment.reference", conditional_transaction_id: "chk-1" }],
        cnf: cnf(holder.publicJwk),
      },
      aud: "cp",
      nonce: "n-1",
      hashMode,
      saltSource: counterSalts(),
      nowSeconds: FROZEN_NOW,
    });
    // Terminal holder hop.
    const chain = await presentMandate({
      holderKey: holder.privateJwk,
      mandateToken: intermediate,
      payload: samplePaymentMandate(),
      aud: "cp",
      nonce: "n-2",
      hashMode,
      saltSource: counterSalts(),
      nowSeconds: FROZEN_NOW,
    });
    return { issuer, chain };
  }

  it("issuer_jwt_hash: dropping the secret still verifies, secret invisible", async () => {
    const { issuer, chain } = await buildChain("issuer_jwt_hash");
    expect(splitChain(chain).length).toBe(3);
    const redacted = redactRootDisclosure(chain, "secret");
    const resolveKey: PublicKeyProvider = () => issuer.publicJwk;
    const result = await verifyMandate({
      token: redacted,
      resolveKey,
      expectedAud: "cp",
      expectedNonce: "n-2",
      nowSeconds: FROZEN_NOW,
      allowIssuerJwtHash: true, // redaction-tolerant mode is opt-in
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === "chain") {
      expect(result.value.payloads[0]?.["secret"]).toBeUndefined();
    }
  });

  it("sd_hash: dropping the secret fails with sd_hash mismatch", async () => {
    const { issuer, chain } = await buildChain("sd_hash");
    const redacted = redactRootDisclosure(chain, "secret");
    const result = await verifyMandate({
      token: redacted,
      resolveKey: () => issuer.publicJwk,
      expectedAud: "cp",
      expectedNonce: "n-2",
      nowSeconds: FROZEN_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("binding_mismatch");
      expect(result.error.message).toContain("sd_hash");
    }
  });

  it("issuer_jwt_hash without redaction also verifies", async () => {
    const { issuer, chain } = await buildChain("issuer_jwt_hash");
    const result = await verifyMandate({
      token: chain,
      resolveKey: () => issuer.publicJwk,
      expectedAud: "cp",
      expectedNonce: "n-2",
      nowSeconds: FROZEN_NOW,
      allowIssuerJwtHash: true, // redaction-tolerant mode is opt-in
    });
    expect(result.ok).toBe(true);
  });
});
