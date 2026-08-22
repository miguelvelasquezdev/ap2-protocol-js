/**
 * Verification: root SD-JWT, KB hops, and the N-hop chain walk.
 * Matches sdjwt/chain.py semantics:
 * - hop 0 is verified under a caller-resolved issuer key; every later hop is
 *   verified under the PREVIOUS hop's cnf.jwk (walked from the credential).
 * - aud/nonce are enforced on the terminal hop only.
 * - non-terminal hops must disclose exactly one delegate_payload item.
 * - payloads EXTEND (a hop disclosing two items yields two entries).
 * - exp/iat are checked with clock skew on both raw payloads and each
 *   delegate item.
 * Verification returns Results / throws Ap2Error internally; the chain entry
 * point converts everything into a Result (a denied chain is a value).
 */
import { importJWK, jwtVerify } from "jose";
import { assertEs256Jwk, type Jwk } from "../crypto/index.ts";
import { Ap2Error, err, ok, type Result } from "../errors.ts";
import { resolveDisclosures } from "./disclosure.ts";
import { TYP_INTERMEDIATE, TYP_TERMINAL } from "./issue.ts";
import {
  cnfJwkOf,
  sdAlgOf,
  typOf,
  verifyBinding,
  withVerification,
  type HashMode,
  type ParsedToken,
} from "./token.ts";

/** Resolves the ROOT issuer key for a chain. May be async (registry lookups). */
export type PublicKeyProvider = (token: ParsedToken) => Jwk | Promise<Jwk>;

/**
 * Placeholder x5c provider. Built-in X.509 certificate-chain key discovery is
 * intentionally NOT bundled (it would mean shipping a hand-rolled DER/ASN.1 path
 * validator or a third runtime dependency; the reference likewise leaves x5c to
 * providers). Resolve the issuer key yourself — from a JWKS endpoint, a DID
 * document, or your own x5c/trusted-root validation — and pass it via
 * `resolveKey` / `key`. This provider always fails closed.
 */
export function x5cPublicKeyProvider(): PublicKeyProvider {
  return () => {
    throw new Ap2Error(
      "x5c_not_supported",
      "Built-in x5c certificate-chain key discovery is not available. Resolve " +
        "the issuer key out of band (JWKS / DID / your own x5c validation) and " +
        "pass it via `resolveKey` or `key`. See SECURITY.md 'Key discovery'.",
    );
  };
}

async function verifyJwsSignature(token: ParsedToken, key: Jwk): Promise<void> {
  assertEs256Jwk(key, "verification key");
  try {
    const imported = await importJWK(key as never, "ES256");
    await jwtVerify(token.issuerJwt, imported, { algorithms: ["ES256"] });
  } catch (cause) {
    throw new Ap2Error("signature_invalid", "SD-JWT signature verification failed", { cause });
  }
}

/** Resolve the delegate_payload items of a verified token (CMWallet compat:
 * items may be digest strings resolved against the token's own disclosures). */
async function resolveDelegateItems(
  token: ParsedToken,
  resolvedPayload: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const dp = resolvedPayload["delegate_payload"];
  if (!Array.isArray(dp)) return [];
  const items: Record<string, unknown>[] = [];
  for (const item of dp) {
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      items.push(item as Record<string, unknown>);
    } else if (typeof item === "string") {
      // A digest string: resolve it against the token's disclosures.
      const resolved = await resolveDisclosures(
        { delegate_payload: [{ "...": item }] },
        token.disclosures,
        sdAlgOf(token),
      );
      const arr = resolved["delegate_payload"];
      if (Array.isArray(arr) && typeof arr[0] === "object" && arr[0] !== null) {
        items.push(arr[0] as Record<string, unknown>);
      } else {
        throw new Ap2Error("disclosure_invalid", "Unresolvable delegate_payload digest");
      }
    } else {
      throw new Ap2Error("payload_invalid", "delegate_payload items must be objects or digests");
    }
  }
  return items;
}

export function checkTimeClaims(
  payload: Readonly<Record<string, unknown>>,
  nowSeconds: number,
  clockSkewSeconds: number,
  label: string,
): void {
  const exp = payload["exp"];
  if (exp !== undefined) {
    // Number.isFinite rejects Infinity (JSON.parse("1e400") -> Infinity), which
    // would otherwise be a token that never expires.
    if (typeof exp !== "number" || !Number.isFinite(exp)) {
      throw new Ap2Error("expired", `${label}: exp must be a finite number`);
    }
    if (nowSeconds > exp + clockSkewSeconds) throw new Ap2Error("expired", `${label}: token expired`);
  }
  const iat = payload["iat"];
  if (iat !== undefined) {
    if (typeof iat !== "number" || !Number.isFinite(iat)) {
      throw new Ap2Error("iat_invalid", `${label}: iat must be a finite number`);
    }
    if (iat > nowSeconds + clockSkewSeconds) {
      throw new Ap2Error("iat_invalid", `${label}: iat is in the future`);
    }
  }
  const nbf = payload["nbf"];
  if (nbf !== undefined) {
    if (typeof nbf !== "number" || !Number.isFinite(nbf)) {
      throw new Ap2Error("iat_invalid", `${label}: nbf must be a finite number`);
    }
    if (nbf > nowSeconds + clockSkewSeconds) {
      throw new Ap2Error("iat_invalid", `${label}: token not yet valid (nbf)`);
    }
  }
}

export interface VerifySdJwtOptions {
  readonly issuerKey: Jwk;
}

/** Verify a ROOT SD-JWT: signature + disclosure resolution. Mutates nothing;
 * returns the token with verifiedPayload/delegateItems attached. */
export async function verifySdJwt(
  token: ParsedToken,
  options: VerifySdJwtOptions,
): Promise<ParsedToken> {
  await verifyJwsSignature(token, options.issuerKey);
  const resolved = await resolveDisclosures(token.payload, token.disclosures, sdAlgOf(token));
  const delegateItems = await resolveDelegateItems(token, resolved);
  return withVerification(token, resolved, delegateItems);
}

export interface VerifyKbSdJwtOptions {
  readonly prevToken: ParsedToken;
  readonly expectedAud?: string;
  readonly expectedNonce?: string;
  /** Enforce terminal-hop rules (aud/nonce + no cnf). */
  readonly terminal: boolean;
  /** Verifier redaction policy: refuse a hop that did not use this binding. */
  readonly requireHashMode?: HashMode;
  /** Accept the redaction-tolerant issuer_jwt_hash binding (default: reject). */
  readonly allowIssuerJwtHash?: boolean;
}

/** Verify one KB hop under the previous hop's cnf key. */
export async function verifyKbSdJwt(
  token: ParsedToken,
  options: VerifyKbSdJwtOptions,
): Promise<ParsedToken> {
  const typ = typOf(token);
  const allTyps: readonly string[] = [...TYP_TERMINAL, ...TYP_INTERMEDIATE];
  if (typ === undefined || !allTyps.includes(typ)) {
    throw new Ap2Error("typ_invalid", `Unexpected KB-SD-JWT typ: ${String(typ)}`);
  }
  const holderKey = cnfJwkOf(options.prevToken);
  if (!holderKey) throw new Ap2Error("cnf_missing", "Previous token missing cnf.jwk");
  await verifyJwsSignature(token, holderKey);

  const resolved = await resolveDisclosures(token.payload, token.disclosures, sdAlgOf(token));
  const delegateItems = await resolveDelegateItems(token, resolved);
  await verifyBinding(resolved, options.prevToken, options.requireHashMode, options.allowIssuerJwtHash);

  const isIntermediateTyp = (TYP_INTERMEDIATE as readonly string[]).includes(typ);
  const hasCnf = delegateItems.some((item) => item["cnf"] !== undefined);
  if (isIntermediateTyp && !hasCnf) {
    throw new Ap2Error("cnf_missing", "Intermediate hop must carry cnf in its delegate payload");
  }
  if (!isIntermediateTyp && hasCnf) {
    throw new Ap2Error("cnf_forbidden", "Terminal hop must not carry cnf");
  }

  if (options.terminal) {
    if (typeof resolved["iat"] !== "number") {
      throw new Ap2Error("iat_invalid", "KB hop missing iat");
    }
    // A terminal hop MUST NOT carry cnf at the top level either (not only in
    // its delegate items) - it does not delegate onward.
    if (resolved["cnf"] !== undefined) {
      throw new Ap2Error("cnf_forbidden", "Terminal hop must not carry a top-level cnf");
    }
    // aud/nonce are REQUIRED on the terminal hop (RFC 9901 s4.3): they MUST be
    // present AND match. Absence is fatal, not a skipped check - that is the
    // replay defense.
    if (typeof resolved["aud"] !== "string" || resolved["aud"] !== options.expectedAud) {
      throw new Ap2Error("aud_mismatch", "aud missing or does not match the expected audience");
    }
    if (typeof resolved["nonce"] !== "string" || resolved["nonce"] !== options.expectedNonce) {
      throw new Ap2Error("nonce_mismatch", "nonce missing or does not match the expected nonce");
    }
  }
  return withVerification(token, resolved, delegateItems);
}

export interface VerifyChainOptions {
  readonly resolveKey: PublicKeyProvider;
  /**
   * REQUIRED. The audience this verifier identifies as, and the fresh nonce it
   * issued for this exchange. They are the replay defense (RFC 9901 s4.3):
   * making them mandatory prevents the fail-open default where a captured
   * presentation replays against any verifier. To intentionally verify a chain
   * without an exchange (e.g. offline audit) the caller must still pass the
   * values it expects; there is no "skip" path by design.
   */
  readonly expectedAud: string;
  readonly expectedNonce: string;
  readonly clockSkewSeconds?: number;
  /** Injectable clock in seconds; defaults to the wall clock. */
  readonly nowSeconds?: number;
  /** Force a specific binding mode on every KB hop (reject the other). */
  readonly requireHashMode?: HashMode;
  /** Accept the redaction-tolerant issuer_jwt_hash binding. Default false: it
   * binds only the previous JWS, not its disclosures, so a relay could add or
   * strip disclosures — rejected unless you explicitly opt in. */
  readonly allowIssuerJwtHash?: boolean;
}

/**
 * Verify an N-hop chain of parsed tokens. Returns the effective payloads
 * (delegate items where present, else the resolved payload), EXTENDED across
 * hops. Fail-closed: any failure is a Result error, never a partial payload.
 */
export async function verifyChain(
  tokens: readonly ParsedToken[],
  options: VerifyChainOptions,
): Promise<Result<Record<string, unknown>[]>> {
  if (tokens.length === 0) return err("malformed_token", "Empty chain");
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const clockSkew = options.clockSkewSeconds ?? 300;
  const payloads: Record<string, unknown>[] = [];
  try {
    let prev: ParsedToken | undefined;
    for (let i = 0; i < tokens.length; i++) {
      const raw = tokens[i];
      if (!raw) return err("malformed_token", "Missing chain segment");
      const isLast = i === tokens.length - 1;
      let verified: ParsedToken;
      if (i === 0) {
        const issuerKey = await options.resolveKey(raw);
        verified = await verifySdJwt(raw, { issuerKey });
      } else {
        if (!prev) throw new Ap2Error("internal", "chain walk lost its previous hop");
        verified = await verifyKbSdJwt(raw, {
          prevToken: prev,
          terminal: isLast,
          ...(isLast ? { expectedAud: options.expectedAud, expectedNonce: options.expectedNonce } : {}),
          ...(options.requireHashMode !== undefined
            ? { requireHashMode: options.requireHashMode }
            : {}),
          ...(options.allowIssuerJwtHash !== undefined
            ? { allowIssuerJwtHash: options.allowIssuerJwtHash }
            : {}),
        });
      }
      const resolved = verified.verifiedPayload ?? {};
      const items = verified.delegateItems ?? [];
      checkTimeClaims(resolved, nowSeconds, clockSkew, `hop ${i}`);
      for (const item of items) checkTimeClaims(item, nowSeconds, clockSkew, `hop ${i} delegate`);
      if (!isLast && i > 0 && items.length !== 1) {
        throw new Ap2Error(
          "payload_invalid",
          "Non-terminal hops must disclose exactly one delegate_payload item",
        );
      }
      payloads.push(...(items.length > 0 ? items : [resolved]));
      prev = verified;
    }
    return ok(payloads);
  } catch (error) {
    if (error instanceof Ap2Error) return err(error.code, error.message);
    return err("internal", error instanceof Error ? error.message : String(error));
  }
}
