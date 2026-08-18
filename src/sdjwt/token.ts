/**
 * ParsedToken: the parsed form of one SD-JWT hop (issuer JWT + disclosures +
 * optional key-binding JWT), plus the binding hash computations. Matches the
 * Python SDK's sdjwt/common.py semantics.
 */
import { b64urlEncode, decodeJsonSegment, hashB64url, type Jwk, type SdAlg } from "../crypto/index.ts";
import { Ap2Error } from "../errors.ts";

export type HashMode = "sd_hash" | "issuer_jwt_hash";

export interface ParsedToken {
  readonly issuerJwt: string;
  readonly disclosures: readonly string[];
  /** Compact KB-JWT trailing segment, or "" when the token ends with ~. */
  readonly kbJwt: string;
  readonly header: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Set by verification: the payload with disclosures resolved. */
  readonly verifiedPayload?: Readonly<Record<string, unknown>>;
  /** Set by verification: the resolved delegate_payload items. */
  readonly delegateItems?: readonly Record<string, unknown>[];
}

/** `issuerJwt~d1~...~` (always ends with ~; never includes the KB-JWT). */
export function sdJwtOf(token: ParsedToken): string {
  return [token.issuerJwt, ...token.disclosures, ""].join("~");
}

/** The full canonical serialization: sdJwt + kbJwt. */
export function canonicalOf(token: ParsedToken): string {
  return sdJwtOf(token) + token.kbJwt;
}

export function typOf(token: ParsedToken): string | undefined {
  const typ = token.header["typ"];
  return typeof typ === "string" ? typ : undefined;
}

/** Resolve the `_sd_alg` for a token. Absent defaults to sha-256 (RFC 9901
 * s4.1.1); a PRESENT but unrecognized value is rejected, not silently coerced
 * (RFC 9901 s7.1 step 2.4 - a verifier MUST check the value is understood). */
export function sdAlgOf(token: ParsedToken): SdAlg {
  const alg = token.payload["_sd_alg"];
  if (alg === undefined) return "sha-256";
  if (alg === "sha-256" || alg === "sha-384" || alg === "sha-512") return alg;
  throw new Ap2Error("unsupported_format", `Unrecognized _sd_alg: ${String(alg)}`);
}

/** Parse one `~`-separated SD-JWT token. Throws Ap2Error on malformed input. */
export function parseToken(token: string): ParsedToken {
  if (token.startsWith("~")) {
    throw new Ap2Error("malformed_token", "Token must not start with a separator");
  }
  if (!token.includes("~")) {
    throw new Ap2Error("unsupported_format", "Only SD-JWT formats are supported (missing ~)");
  }
  const segments = token.split("~");
  const issuerJwt = segments[0] ?? "";
  const last = segments[segments.length - 1] ?? "";
  const kbJwt = last === "" ? "" : last;
  if (kbJwt !== "" && kbJwt.split(".").length !== 3) {
    throw new Ap2Error("malformed_token", "Malformed KB-JWT segment");
  }
  const disclosures = segments.slice(1, segments.length - 1);
  if (disclosures.some((d) => d === "")) {
    throw new Ap2Error("malformed_token", "Empty disclosure segment");
  }
  const jwtParts = issuerJwt.split(".");
  if (jwtParts.length !== 3) {
    throw new Ap2Error("malformed_token", "Malformed issuer JWT");
  }
  const header = decodeJsonSegment(jwtParts[0] ?? "", "JWT header");
  const payload = decodeJsonSegment(jwtParts[1] ?? "", "JWT payload");
  return { issuerJwt, disclosures, kbJwt, header, payload };
}

export function withVerification(
  token: ParsedToken,
  verifiedPayload: Record<string, unknown>,
  delegateItems: readonly Record<string, unknown>[],
): ParsedToken {
  return { ...token, verifiedPayload, delegateItems };
}

/** The holder key pinned for the NEXT hop, walked per Python cnf_jwk(). */
export function cnfJwkOf(token: ParsedToken): Jwk | undefined {
  if (token.verifiedPayload === undefined) {
    throw new Ap2Error("internal", "cnfJwkOf requires a verified token");
  }
  const fromItems = (items: readonly unknown[] | undefined): Jwk | undefined => {
    for (const item of items ?? []) {
      if (typeof item === "object" && item !== null) {
        const cnf = (item as Record<string, unknown>)["cnf"];
        const jwk = typeof cnf === "object" && cnf !== null ? (cnf as Record<string, unknown>)["jwk"] : undefined;
        if (typeof jwk === "object" && jwk !== null) return jwk as Jwk;
      }
    }
    return undefined;
  };
  const viaDelegates = fromItems(token.delegateItems);
  if (viaDelegates) return viaDelegates;
  const dp = token.verifiedPayload["delegate_payload"];
  if (Array.isArray(dp)) {
    const viaPayload = fromItems(dp);
    if (viaPayload) return viaPayload;
  }
  const cnf = token.verifiedPayload["cnf"];
  const jwk = typeof cnf === "object" && cnf !== null ? (cnf as Record<string, unknown>)["jwk"] : undefined;
  return typeof jwk === "object" && jwk !== null ? (jwk as Jwk) : undefined;
}

// ---- binding hashes ---------------------------------------------------------

/** base64url(hash(sd-jwt part incl. disclosures, excl. KB-JWT)). */
export function computeSdHash(token: ParsedToken): Promise<string> {
  return hashB64url(sdJwtOf(token), sdAlgOf(token));
}

/** base64url(hash(issuer JWT only)) - the redaction-tolerant binding mode. */
export function computeIssuerJwtHash(token: ParsedToken): Promise<string> {
  return hashB64url(token.issuerJwt, sdAlgOf(token));
}

export async function computeBinding(
  prevToken: ParsedToken,
  hashMode: HashMode,
): Promise<readonly [HashMode, string]> {
  const value =
    hashMode === "issuer_jwt_hash"
      ? await computeIssuerJwtHash(prevToken)
      : await computeSdHash(prevToken);
  return [hashMode, value];
}

/**
 * Verify the binding claim: EXACTLY ONE of sd_hash / issuer_jwt_hash must be
 * present (XOR), and it must match the previous token.
 *
 * `requireHashMode` is the verifier's redaction policy (RFC 9901 s7.3 step 1:
 * key-binding checks MUST NOT be decided by what the holder supplied). Under
 * `issuer_jwt_hash` the previous hop's disclosures are NOT covered by this
 * hop's signature, so a relay can re-attach redacted disclosures undetected;
 * a verifier that will not tolerate that passes `requireHashMode: "sd_hash"`.
 */
export async function verifyBinding(
  payload: Readonly<Record<string, unknown>>,
  prevToken: ParsedToken,
  requireHashMode?: HashMode,
  allowIssuerJwtHash = false,
): Promise<void> {
  const sdHash = payload["sd_hash"];
  const issuerJwtHash = payload["issuer_jwt_hash"];
  const hasSd = typeof sdHash === "string";
  const hasIssuer = typeof issuerJwtHash === "string";
  if (hasSd === hasIssuer) {
    throw new Ap2Error(
      "binding_mismatch",
      "Exactly one of sd_hash / issuer_jwt_hash must be present",
    );
  }
  const actual: HashMode = hasSd ? "sd_hash" : "issuer_jwt_hash";
  if (requireHashMode !== undefined) {
    if (actual !== requireHashMode) {
      throw new Ap2Error(
        "binding_mismatch",
        `Verifier requires ${requireHashMode} binding but the hop used ${actual}`,
      );
    }
  } else if (actual === "issuer_jwt_hash" && !allowIssuerJwtHash) {
    // issuer_jwt_hash binds the previous hop's JWS only, NOT its disclosures, so
    // a keyless relay can add or strip disclosures and the chain still verifies.
    // Reject it by default (fail-closed); a caller that genuinely needs the
    // redaction-tolerant mode must opt in with allowIssuerJwtHash.
    throw new Ap2Error(
      "binding_mismatch",
      "issuer_jwt_hash binding is redaction-tolerant (does not cover disclosures) and is rejected by default; pass allowIssuerJwtHash to accept it, or use sd_hash",
    );
  }
  if (hasSd) {
    if (sdHash !== (await computeSdHash(prevToken))) {
      throw new Ap2Error("binding_mismatch", "sd_hash mismatch");
    }
  } else if (issuerJwtHash !== (await computeIssuerJwtHash(prevToken))) {
    throw new Ap2Error("binding_mismatch", "issuer_jwt_hash mismatch");
  }
}

/** Deterministic b64url JSON encoding used for JWT segments. */
export function encodeJsonSegment(obj: Record<string, unknown>): string {
  return b64urlEncode(JSON.stringify(obj));
}
