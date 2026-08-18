/**
 * The mandate facade: create, present, verify. Matches sdk/mandate.py
 * semantics, including the two subtle pieces every flow depends on:
 * - the ~~ chain join strips one trailing ~ per non-final segment;
 *   canonicalChainSegment restores it before hashing (get this wrong and
 *   every sd_hash fails).
 * - present() with claimsToDisclose redacts the previous token's disclosures
 *   and re-binds over the REDACTED form (the verifier hashes what it
 *   receives, not what was originally issued).
 */
import { type Jwk } from "../crypto/index.ts";
import { Ap2Error, err, ok, type Result } from "../errors.ts";
import {
  applyDisclosureSpec,
  randomSalt,
  decodeDisclosure,
  type DisclosureSpec,
  type SaltSource,
} from "../sdjwt/disclosure.ts";
import { createDelegateRootSdJwt, createKbSdJwt } from "../sdjwt/issue.ts";
import {
  canonicalOf,
  parseToken,
  sdJwtOf,
  type HashMode,
  type ParsedToken,
} from "../sdjwt/token.ts";
import { verifyChain, verifySdJwt, type PublicKeyProvider } from "../sdjwt/verify.ts";

const CHAIN_SEPARATOR = "~~";

/**
 * Restore the trailing ~ the ~~ join stripped from a non-final segment.
 * Heuristic (mandate.py:68): if the segment's final ~-part is a 3-dot JWT it
 * is a KB-JWT and the segment is left alone; otherwise the ~ is restored.
 */
export function canonicalChainSegment(segment: string): string {
  if (segment.endsWith("~")) return segment;
  // A KB-terminated segment (jwt~d1~...~kbjwt) keeps its KB-JWT: no ~ to
  // restore. Detect it by a trailing 3-part JWT AFTER at least one ~ (a bare
  // issuer JWT has no ~ and is the stripped form of `jwt~`, so it DOES need
  // the ~ back). Disclosures are base64url with no dots, so a 3-dot final
  // part is unambiguously a KB-JWT.
  if (segment.includes("~")) {
    const last = segment.split("~").at(-1) ?? "";
    if (last.split(".").length === 3) return segment;
  }
  return `${segment}~`;
}

/** Split a presentation on ~~ into canonical per-hop token strings. */
export function splitChain(token: string): string[] {
  const segments = token.split(CHAIN_SEPARATOR);
  return segments.map((segment, i) =>
    i < segments.length - 1 ? canonicalChainSegment(segment) : segment,
  );
}

/** The closed (final) mandate JWT of a presentation; its sha-256 is the
 * canonical receipt `reference`. */
export function getClosedMandateJwt(presentationToken: string): string {
  const lastSegment = presentationToken.split(CHAIN_SEPARATOR).at(-1) ?? presentationToken;
  return lastSegment.split("~", 1)[0] ?? "";
}

// ---- create -----------------------------------------------------------------

export interface CreateMandateOptions {
  /** The mandate claims (an open or closed mandate object, snake_case wire form). */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly issuerKey: Jwk;
  readonly sd?: DisclosureSpec;
  readonly saltSource?: SaltSource;
}

/**
 * Issue a mandate as a root SD-JWT (serialized, ends with ~). The payload rides
 * in a `delegate_payload` disclosure so every hop of a chain is in the same
 * delegate form and a chain we issue verifies in reference implementations.
 */
export function createMandate(options: CreateMandateOptions): Promise<string> {
  return createDelegateRootSdJwt({
    claims: options.payload,
    issuerKey: options.issuerKey,
    ...(options.sd !== undefined ? { sd: options.sd } : {}),
    ...(options.saltSource !== undefined ? { saltSource: options.saltSource } : {}),
  });
}

// ---- present ----------------------------------------------------------------

export interface PresentMandateOptions {
  readonly holderKey: Jwk;
  /** The mandate (or chain) being extended. */
  readonly mandateToken: string;
  /** The delegate claims of the new hop (e.g. a closed mandate object). */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly aud: string;
  readonly nonce: string;
  /** Redaction: keep only these top-level disclosed property names (plus vct
   * array items and cnf, which are always kept). */
  readonly claimsToDisclose?: Readonly<Record<string, unknown>>;
  readonly hashMode?: HashMode;
  readonly sd?: DisclosureSpec;
  readonly saltSource?: SaltSource;
  readonly nowSeconds?: number;
}

function redactToken(token: ParsedToken, claimsToDisclose: Readonly<Record<string, unknown>>): ParsedToken {
  const kept = token.disclosures.filter((disclosure) => {
    const decoded = decodeDisclosure(disclosure);
    if (decoded.kind === "element") {
      // Keep vct-bearing array disclosures (the delegate payload items).
      return (
        typeof decoded.value === "object" &&
        decoded.value !== null &&
        "vct" in (decoded.value as Record<string, unknown>)
      );
    }
    // Object.hasOwn, not `in`: `in` walks the prototype chain, so a disclosure
    // named e.g. "toString" or "constructor" would survive redaction even
    // though the holder never listed it.
    return decoded.name === "cnf" || Object.hasOwn(claimsToDisclose, decoded.name);
  });
  return { ...token, disclosures: kept };
}

/**
 * Extend a mandate with a key-bound hop and return the joined presentation.
 * Throws Ap2Error on misuse (aud/nonce are required for KB hops).
 */
export async function presentMandate(options: PresentMandateOptions): Promise<string> {
  if (!options.aud || !options.nonce) {
    throw new Ap2Error("aud_nonce_required", "aud and nonce are required for KB-SD-JWT hops");
  }
  const segments = splitChain(options.mandateToken);
  const lastSegment = segments.at(-1);
  if (lastSegment === undefined) {
    throw new Ap2Error("malformed_token", "Empty mandate token");
  }
  let prevToken = parseToken(canonicalChainSegment(lastSegment));
  let sentPrevSerialized = canonicalChainSegment(lastSegment);
  if (options.claimsToDisclose) {
    prevToken = redactToken(prevToken, options.claimsToDisclose);
    sentPrevSerialized = sdJwtOf(prevToken) + prevToken.kbJwt;
  }

  const hop = await createKbSdJwt({
    prevToken,
    holderKey: options.holderKey,
    delegateClaims: options.payload,
    aud: options.aud,
    nonce: options.nonce,
    ...(options.hashMode !== undefined ? { hashMode: options.hashMode } : {}),
    ...(options.sd !== undefined ? { sd: options.sd } : {}),
    saltSource: options.saltSource ?? randomSalt,
    ...(options.nowSeconds !== undefined ? { nowSeconds: options.nowSeconds } : {}),
  });

  const priorSegments = segments.slice(0, -1);
  const joined = [...priorSegments, sentPrevSerialized]
    .map((segment) => (segment.endsWith("~") ? segment.slice(0, -1) : segment))
    .join(CHAIN_SEPARATOR);
  return `${joined}${CHAIN_SEPARATOR}${canonicalOf(hop)}`;
}

// ---- verify -----------------------------------------------------------------

export type VerifiedMandate =
  | { readonly kind: "single"; readonly payload: Record<string, unknown> }
  | { readonly kind: "chain"; readonly payloads: readonly Record<string, unknown>[] };

export interface VerifyMandateOptions {
  readonly token: string;
  /** Single-token mode: the issuer key. Chain mode: a provider. */
  readonly key?: Jwk;
  readonly resolveKey?: PublicKeyProvider;
  readonly expectedAud?: string;
  readonly expectedNonce?: string;
  readonly clockSkewSeconds?: number;
  readonly nowSeconds?: number;
  /** Refuse redaction-tolerant issuer_jwt_hash binding on any hop. */
  readonly requireHashMode?: HashMode;
}

/**
 * Verify a mandate token (single SD-JWT) or a ~~-joined chain. A denied
 * credential is a value: this never throws for untrusted input.
 */
export async function verifyMandate(
  options: VerifyMandateOptions,
): Promise<Result<VerifiedMandate>> {
  try {
    if (!options.token.includes("~")) {
      return err("unsupported_format", "Only SD-JWT formats are supported");
    }
    const segments = splitChain(options.token);

    if (segments.length === 1) {
      if (!options.key) {
        return err("missing_key", "Single-token verification requires `key` (an issuer JWK)");
      }
      const token = parseToken(segments[0] ?? "");
      const verified = await verifySdJwt(token, { issuerKey: options.key });
      const items = verified.delegateItems ?? [];
      if (items.length > 1) {
        return err("payload_invalid", "Expected exactly one disclosed delegate_payload item");
      }
      const payload = items[0] ?? verified.verifiedPayload ?? {};
      return ok({ kind: "single", payload });
    }

    // Chain mode.
    const resolveKey = options.resolveKey;
    if (!resolveKey) {
      return err("missing_key", "Chain verification requires `resolveKey` (a PublicKeyProvider)");
    }
    // A chain (>1 segment) always terminates in a key-bound hop, so aud/nonce
    // are always required here - there is no replay-safe way to skip them.
    if (options.expectedAud === undefined || options.expectedNonce === undefined) {
      return err(
        "aud_nonce_required",
        "expectedAud and expectedNonce are required to verify a chain",
      );
    }
    const tokens = segments.map((segment) => parseToken(segment));
    const result = await verifyChain(tokens, {
      resolveKey,
      expectedAud: options.expectedAud,
      expectedNonce: options.expectedNonce,
      ...(options.clockSkewSeconds !== undefined
        ? { clockSkewSeconds: options.clockSkewSeconds }
        : {}),
      ...(options.nowSeconds !== undefined ? { nowSeconds: options.nowSeconds } : {}),
      ...(options.requireHashMode !== undefined ? { requireHashMode: options.requireHashMode } : {}),
    });
    if (!result.ok) return result;
    return ok({ kind: "chain", payloads: result.value });
  } catch (error) {
    if (error instanceof Ap2Error) return err(error.code, error.message);
    return err("internal", error instanceof Error ? error.message : String(error));
  }
}

export type { DisclosureSpec } from "../sdjwt/disclosure.ts";
export { applyDisclosureSpec };
