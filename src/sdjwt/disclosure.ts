/**
 * SD-JWT disclosures (RFC 9901): create, digest, and fail-closed resolution
 * of `_sd` property digests and `...` array-element digests.
 */
import { b64urlEncode, b64urlDecode, hashB64url, type SdAlg } from "../crypto/index.ts";
import { Ap2Error } from "../errors.ts";

export type SaltSource = () => string;

/**
 * Assign a resolved claim as an OWN data property. Untrusted tokens can name a
 * disclosure `__proto__` (or `constructor`); a plain `obj[key] = value` would
 * trigger the prototype setter and corrupt the object. defineProperty makes it
 * inert data, matching the reference Python (where such a name is an ordinary
 * dict key).
 */
function assignOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Max JSON nesting depth resolveDisclosures will walk before failing closed. */
const MAX_DISCLOSURE_DEPTH = 256;

/** 128-bit random salt, base64url (the RFC 9901 recommendation). */
export const randomSalt: SaltSource = () => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return b64urlEncode(bytes);
};

/** A property disclosure: [salt, name, value]. */
export function createPropertyDisclosure(salt: string, name: string, value: unknown): string {
  return b64urlEncode(JSON.stringify([salt, name, value]));
}

/** An array-element disclosure: [salt, value]. */
export function createElementDisclosure(salt: string, value: unknown): string {
  return b64urlEncode(JSON.stringify([salt, value]));
}

export type DecodedDisclosure =
  | { readonly kind: "property"; readonly salt: string; readonly name: string; readonly value: unknown }
  | { readonly kind: "element"; readonly salt: string; readonly value: unknown };

export function decodeDisclosure(disclosure: string): DecodedDisclosure {
  let arr: unknown;
  try {
    arr = JSON.parse(b64urlDecode(disclosure));
  } catch (cause) {
    throw new Ap2Error("disclosure_invalid", "Disclosure is not base64url JSON", { cause });
  }
  if (!Array.isArray(arr) || arr.length < 2 || arr.length > 3 || typeof arr[0] !== "string") {
    throw new Ap2Error("disclosure_invalid", "Disclosure must be [salt, name?, value]");
  }
  if (arr.length === 3) {
    if (typeof arr[1] !== "string") {
      throw new Ap2Error("disclosure_invalid", "Disclosure name must be a string");
    }
    return { kind: "property", salt: arr[0], name: arr[1], value: arr[2] };
  }
  return { kind: "element", salt: arr[0], value: arr[1] };
}

export function computeDisclosureDigest(disclosure: string, sdAlg: SdAlg): Promise<string> {
  return hashB64url(disclosure, sdAlg);
}

/**
 * Resolve every `_sd` and `...` digest in `payload` against `disclosures`.
 * Fail-closed: duplicate digests (RFC 9901 section 7.1) and disclosures whose
 * digest appears nowhere both reject. Returns a new resolved object with the
 * `_sd` machinery removed (the `_sd_alg` marker is kept).
 */
export async function resolveDisclosures(
  payload: Readonly<Record<string, unknown>>,
  disclosures: readonly string[],
  sdAlg: SdAlg,
): Promise<Record<string, unknown>> {
  const byDigest = new Map<string, DecodedDisclosure>();
  for (const d of disclosures) {
    const digest = await computeDisclosureDigest(d, sdAlg);
    if (byDigest.has(digest)) {
      throw new Ap2Error("disclosure_invalid", "Duplicate disclosure digest");
    }
    byDigest.set(digest, decodeDisclosure(d));
  }
  const used = new Set<string>();
  const seenDigests = new Set<string>();

  const resolveNode = (node: unknown, depth: number): unknown => {
    // Depth cap: resolveNode recurses on JSON structure. Untrusted disclosures
    // can nest arbitrarily deep; without a bound a crafted token overflows the
    // stack (a hard RangeError, which crashes a direct resolveDisclosures caller
    // outside verify's try/catch). Real mandates are shallow.
    if (depth > MAX_DISCLOSURE_DEPTH) {
      throw new Ap2Error("disclosure_invalid", "disclosure nesting exceeds the depth limit");
    }
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      for (const el of node) {
        if (typeof el === "object" && el !== null && !Array.isArray(el)) {
          const marker = (el as Record<string, unknown>)["..."];
          if (typeof marker === "string" && Object.keys(el).length === 1) {
            if (seenDigests.has(marker)) {
              throw new Ap2Error("disclosure_invalid", "Duplicate digest reference");
            }
            seenDigests.add(marker);
            const disc = byDigest.get(marker);
            if (disc === undefined) continue; // undisclosed element: omitted
            if (disc.kind !== "element") {
              throw new Ap2Error("disclosure_invalid", "Array digest resolved to a property disclosure");
            }
            used.add(marker);
            out.push(resolveNode(disc.value, depth + 1));
            continue;
          }
        }
        out.push(resolveNode(el, depth + 1));
      }
      return out;
    }
    if (typeof node === "object" && node !== null) {
      const src = node as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(src)) {
        if (key === "_sd") continue;
        assignOwn(out, key, resolveNode(value, depth + 1));
      }
      const sd = src["_sd"];
      if (sd !== undefined) {
        if (!Array.isArray(sd) || sd.some((x) => typeof x !== "string")) {
          throw new Ap2Error("disclosure_invalid", "_sd must be an array of digest strings");
        }
        for (const digest of sd as string[]) {
          if (seenDigests.has(digest)) {
            throw new Ap2Error("disclosure_invalid", "Duplicate digest reference");
          }
          seenDigests.add(digest);
          const disc = byDigest.get(digest);
          if (disc === undefined) continue; // undisclosed property: omitted
          if (disc.kind !== "property") {
            throw new Ap2Error("disclosure_invalid", "_sd digest resolved to an element disclosure");
          }
          // RFC 9901 s7.1 step 3.3.2.2: the disclosed name MUST NOT be `_sd`
          // or `...`, and MUST NOT collide with a claim already present.
          if (disc.name === "_sd" || disc.name === "...") {
            throw new Ap2Error("disclosure_invalid", `Illegal disclosure name: ${disc.name}`);
          }
          if (Object.hasOwn(out, disc.name)) {
            throw new Ap2Error("disclosure_invalid", `Disclosure name collides with an existing claim: ${disc.name}`);
          }
          used.add(digest);
          assignOwn(out, disc.name, resolveNode(disc.value, depth + 1));
        }
      }
      return out;
    }
    return node;
  };

  const resolved = resolveNode(payload, 0) as Record<string, unknown>;
  for (const digest of byDigest.keys()) {
    if (!used.has(digest)) {
      throw new Ap2Error("disclosure_invalid", "Disclosure not referenced by any digest");
    }
  }
  return resolved;
}

// ---- issuance-side SD application -------------------------------------------

/**
 * Which parts of a claims object become selectively disclosable.
 * v1 supports property disclosures and array-element disclosures (the shapes
 * the AP2 flows use). Deriving specs from the schema
 * `x-selectively-disclosable-*` annotations is a planned follow-on; the known
 * per-schema specs are exported as constants where needed.
 */
export interface DisclosureSpec {
  readonly sdKeys?: readonly string[];
  /** array property name -> which elements become disclosures. */
  readonly sdArrayElements?: Readonly<Record<string, "all" | readonly number[]>>;
}

export interface AppliedSd {
  readonly claims: Record<string, unknown>;
  readonly disclosures: readonly string[];
}

/** Apply a DisclosureSpec: replace chosen parts with digests + disclosures. */
export async function applyDisclosureSpec(
  claims: Readonly<Record<string, unknown>>,
  spec: DisclosureSpec | undefined,
  sdAlg: SdAlg,
  saltSource: SaltSource,
): Promise<AppliedSd> {
  if (!spec) return { claims: { ...claims }, disclosures: [] };
  const out: Record<string, unknown> = { ...claims };
  const disclosures: string[] = [];
  const sdDigests: string[] = [];

  for (const key of spec.sdKeys ?? []) {
    if (!(key in out)) continue;
    const disclosure = createPropertyDisclosure(saltSource(), key, out[key]);
    disclosures.push(disclosure);
    sdDigests.push(await computeDisclosureDigest(disclosure, sdAlg));
    delete out[key];
  }

  for (const [key, which] of Object.entries(spec.sdArrayElements ?? {})) {
    const arr = out[key];
    if (!Array.isArray(arr)) continue;
    const indices = which === "all" ? arr.map((_, i) => i) : which;
    const replaced: unknown[] = [];
    for (let i = 0; i < arr.length; i++) {
      if (indices.includes(i)) {
        const disclosure = createElementDisclosure(saltSource(), arr[i]);
        disclosures.push(disclosure);
        replaced.push({ "...": await computeDisclosureDigest(disclosure, sdAlg) });
      } else {
        replaced.push(arr[i]);
      }
    }
    out[key] = replaced;
  }

  if (sdDigests.length > 0) out["_sd"] = sdDigests;
  return { claims: out, disclosures };
}
