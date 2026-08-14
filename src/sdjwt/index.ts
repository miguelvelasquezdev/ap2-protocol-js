/** SD-JWT primitives: parsing, disclosures, issuance, verification. */
export {
  parseToken,
  sdJwtOf,
  canonicalOf,
  typOf,
  sdAlgOf,
  cnfJwkOf,
  computeSdHash,
  computeIssuerJwtHash,
  computeBinding,
  verifyBinding,
} from "./token.ts";
export type { ParsedToken, HashMode } from "./token.ts";
export {
  createPropertyDisclosure,
  createElementDisclosure,
  decodeDisclosure,
  computeDisclosureDigest,
  resolveDisclosures,
  applyDisclosureSpec,
  randomSalt,
} from "./disclosure.ts";
export type { DisclosureSpec, DecodedDisclosure, SaltSource } from "./disclosure.ts";
export { createSdJwt, createKbSdJwt, TYP_TERMINAL, TYP_INTERMEDIATE } from "./issue.ts";
export type { CreateSdJwtOptions, CreateKbSdJwtOptions } from "./issue.ts";
export { verifySdJwt, verifyKbSdJwt, verifyChain, x5cPublicKeyProvider } from "./verify.ts";
export type {
  PublicKeyProvider,
  VerifySdJwtOptions,
  VerifyKbSdJwtOptions,
  VerifyChainOptions,
} from "./verify.ts";
