/**
 * Crypto primitives: base64url, hashing keyed by `_sd_alg`, and plain ES256
 * JWTs (receipts and checkout_jwt are plain JWTs, not SD-JWTs).
 * WebCrypto + jose only: runs on Node >=20, browsers, and edge runtimes.
 */
import { SignJWT, jwtVerify, importJWK, decodeProtectedHeader } from "jose";
import { Ap2Error } from "../errors.ts";

// ---- base64url -------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Unpadded base64url of bytes or a UTF-8 string. */
export function b64urlEncode(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? textEncoder.encode(data) : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode base64url (re-padding as needed) to bytes. */
export function b64urlDecodeBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Decode base64url to a UTF-8 string. */
export function b64urlDecode(s: string): string {
  return textDecoder.decode(b64urlDecodeBytes(s));
}

/** Decode a base64url JSON segment, with a labeled error on failure. */
export function decodeJsonSegment(segment: string, partName: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(b64urlDecode(segment));
  } catch (cause) {
    throw new Ap2Error("malformed_token", `Malformed ${partName}: not base64url JSON`, { cause });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Ap2Error("malformed_token", `Malformed ${partName}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

// ---- hashing ---------------------------------------------------------------

export type SdAlg = "sha-256" | "sha-384" | "sha-512";
const SUBTLE_ALG: Record<SdAlg, string> = {
  "sha-256": "SHA-256",
  "sha-384": "SHA-384",
  "sha-512": "SHA-512",
};

/** base64url(hash(ascii bytes of `data`)) using the given `_sd_alg`. */
export async function hashB64url(data: string, sdAlg: SdAlg = "sha-256"): Promise<string> {
  // Object.hasOwn so a value like "toString" cannot resolve to an inherited
  // Object.prototype member instead of a real algorithm.
  if (!Object.hasOwn(SUBTLE_ALG, sdAlg)) {
    throw new Ap2Error("unsupported_format", `Unsupported _sd_alg: ${String(sdAlg)}`);
  }
  const subtleName = SUBTLE_ALG[sdAlg];
  const digest = await globalThis.crypto.subtle.digest(subtleName as string, textEncoder.encode(data));
  return b64urlEncode(new Uint8Array(digest));
}

/** base64url(SHA-256(data)) - the receipt `reference` convention. */
export function computeSha256B64url(data: string): Promise<string> {
  return hashB64url(data, "sha-256");
}

// ---- JWK -------------------------------------------------------------------

/** An EC P-256 public or private JWK. Extra members are preserved. */
export interface Jwk {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  d?: string;
  kid?: string;
  alg?: string;
  [member: string]: unknown;
}

/**
 * Fail-closed guard: the AP2 profile is EC P-256 (ES256) only.
 * LOAD-BEARING: `importJWK` does not validate kty against alg (importing an
 * `oct` key as ES256 succeeds), so this guard is the only thing preventing
 * HS256-style key confusion. It MUST be called before every importJWK. Do not
 * remove it because it "looks redundant" next to the ES256 algorithm pin.
 */
export function assertEs256Jwk(jwk: Jwk, label = "key"): void {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Ap2Error("invalid_key", `${label} must be an EC P-256 JWK`);
  }
}

// ---- plain ES256 JWTs (receipts, checkout_jwt) ------------------------------

export interface JwtHeader {
  alg?: string;
  typ?: string;
  kid?: string;
  [param: string]: unknown;
}

/** Create a plain ES256 JWT (header alg is forced to ES256). */
export async function createJwt(
  header: JwtHeader,
  payload: Record<string, unknown>,
  privateKey: Jwk,
): Promise<string> {
  assertEs256Jwk(privateKey, "signing key");
  const key = await importJWK(privateKey as never, "ES256");
  const { alg: _ignored, ...rest } = header;
  return new SignJWT(payload).setProtectedHeader({ ...rest, alg: "ES256" }).sign(key);
}

/** Verify a plain ES256 JWT and return its payload. Throws Ap2Error.
 * `clockToleranceSeconds` widens jose's exp/nbf window (jose enforces at zero
 * tolerance by default). Expiry is surfaced as the `expired` code, not
 * `signature_invalid`, so callers can distinguish a stale token from a forgery. */
export async function verifyJwt(
  token: string,
  publicKey: Jwk,
  clockToleranceSeconds = 0,
): Promise<Record<string, unknown>> {
  assertEs256Jwk(publicKey, "verification key");
  try {
    const key = await importJWK(publicKey as never, "ES256");
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["ES256"],
      clockTolerance: clockToleranceSeconds,
    });
    return payload as Record<string, unknown>;
  } catch (cause) {
    const code = (cause as { code?: string })?.code;
    if (code === "ERR_JWT_EXPIRED") {
      throw new Ap2Error("expired", "JWT is expired", { cause });
    }
    if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
      throw new Ap2Error("iat_invalid", "JWT time claim validation failed", { cause });
    }
    throw new Ap2Error("signature_invalid", "JWT signature verification failed", { cause });
  }
}

/** Decode a JWT header without verification (for kid/typ routing). */
export function decodeJwtHeader(token: string): JwtHeader {
  try {
    return decodeProtectedHeader(token) as JwtHeader;
  } catch (cause) {
    throw new Ap2Error("malformed_token", "Malformed JWT header", { cause });
  }
}
