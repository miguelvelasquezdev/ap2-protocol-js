/**
 * Issuance: root SD-JWTs and key-binding SD-JWT hops.
 * Matches sdjwt/sd_jwt.py + sdjwt/kb_sd_jwt.py semantics:
 * - the ROOT SD-JWT injects NO binding claims, no iat/aud/nonce.
 * - a KB hop injects iat + aud + nonce + the binding claim, and its typ is
 *   inferred: `kb+sd-jwt+kb` when the delegate claims carry `cnf`
 *   (intermediate), `kb+sd-jwt` otherwise (terminal). There is no separate
 *   trailing plain KB-JWT (documented AP2 deviation from the delegate draft).
 */
import { importJWK, SignJWT } from "jose";
import { assertEs256Jwk, type Jwk } from "../crypto/index.ts";
import {
  applyDisclosureSpec,
  randomSalt,
  type DisclosureSpec,
  type SaltSource,
} from "./disclosure.ts";
import {
  computeBinding,
  parseToken,
  type HashMode,
  type ParsedToken,
} from "./token.ts";

export const TYP_TERMINAL = ["kb+sd-jwt", "kb-sd-jwt"] as const;
export const TYP_INTERMEDIATE = ["kb+sd-jwt+kb", "kb-sd-jwt+kb"] as const;

async function signSdJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  disclosures: readonly string[],
  signingKey: Jwk,
): Promise<string> {
  assertEs256Jwk(signingKey, "signing key");
  const key = await importJWK(signingKey as never, "ES256");
  const jwt = await new SignJWT(claims)
    .setProtectedHeader({ ...header, alg: "ES256" })
    .sign(key);
  return [jwt, ...disclosures, ""].join("~");
}

function headerFor(signingKey: Jwk, typ?: string): Record<string, unknown> {
  return {
    ...(typ !== undefined ? { typ } : {}),
    ...(typeof signingKey.kid === "string" ? { kid: signingKey.kid } : {}),
  };
}

export interface CreateSdJwtOptions {
  readonly claims: Readonly<Record<string, unknown>>;
  readonly issuerKey: Jwk;
  readonly sd?: DisclosureSpec;
  readonly typ?: string;
  /** Injectable for deterministic tests. */
  readonly saltSource?: SaltSource;
}

/** Create a root SD-JWT (serialized, always ending with ~). */
export async function createSdJwt(options: CreateSdJwtOptions): Promise<string> {
  const { claims, disclosures } = await applyDisclosureSpec(
    options.claims,
    options.sd,
    "sha-256",
    options.saltSource ?? randomSalt,
  );
  return signSdJwt(headerFor(options.issuerKey, options.typ), claims, disclosures, options.issuerKey);
}

export interface CreateKbSdJwtOptions {
  /** The previous hop this one binds to. */
  readonly prevToken: ParsedToken;
  readonly holderKey: Jwk;
  /** The delegate claims (wrapped as delegate_payload array elements). */
  readonly delegateClaims: Readonly<Record<string, unknown>>;
  readonly aud: string;
  readonly nonce: string;
  readonly sd?: DisclosureSpec;
  readonly hashMode?: HashMode;
  readonly saltSource?: SaltSource;
  /** Injectable clock (seconds). */
  readonly nowSeconds?: number;
}

/**
 * Create a key-binding SD-JWT hop. The delegate claims ride as a
 * `delegate_payload` single-element array disclosure; per-field SD inside the
 * claims is applied first via `sd`.
 */
export async function createKbSdJwt(options: CreateKbSdJwtOptions): Promise<ParsedToken> {
  const saltSource = options.saltSource ?? randomSalt;
  const inner = await applyDisclosureSpec(options.delegateClaims, options.sd, "sha-256", saltSource);
  const wrapped = await applyDisclosureSpec(
    { delegate_payload: [inner.claims] },
    { sdArrayElements: { delegate_payload: "all" } },
    "sha-256",
    saltSource,
  );
  const [bindingClaim, bindingValue] = await computeBinding(
    options.prevToken,
    options.hashMode ?? "sd_hash",
  );
  const isIntermediate = "cnf" in options.delegateClaims;
  const typ = isIntermediate ? "kb+sd-jwt+kb" : "kb+sd-jwt";
  const claims: Record<string, unknown> = {
    ...wrapped.claims,
    iat: options.nowSeconds ?? Math.floor(Date.now() / 1000),
    aud: options.aud,
    nonce: options.nonce,
    [bindingClaim]: bindingValue,
  };
  const serialized = await signSdJwt(
    headerFor(options.holderKey, typ),
    claims,
    [...inner.disclosures, ...wrapped.disclosures],
    options.holderKey,
  );
  return parseToken(serialized);
}
