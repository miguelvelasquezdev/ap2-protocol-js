import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  CheckoutMandateSchema,
  OpenPaymentMandateSchema,
  PaymentMandateSchema,
  PaymentReceiptSchema,
} from "../src/schemas/index.ts";

/**
 * Oracle test: the canonical JSON Schemas are the source of truth. For a set
 * of representative objects, the generated Zod schema and Ajv (validating
 * against the raw JSON Schema) must AGREE on accept/reject. This guards the
 * codegen against silently drifting from the spec.
 */
// ESM/CJS interop: Ajv and ajv-formats are CJS (`export =`); pick the callable
// value whether it arrived as the module or under `.default`.
type Ctor = new (opts: Record<string, unknown>) => {
  addSchema(schema: unknown): void;
  getSchema(key: string): ((data: unknown) => boolean) | undefined;
};
type AddFormats = (ajv: unknown) => void;
const Ajv2020 = ((Ajv2020Module as { default?: unknown }).default ?? Ajv2020Module) as Ctor;
const addFormats = ((addFormatsModule as { default?: unknown }).default ??
  addFormatsModule) as AddFormats;

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMAS = join(here, "..", "schemas");

type AjvInstance = InstanceType<typeof Ajv2020>;

function buildAjv(): AjvInstance {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  // Re-key each schema by its path relative to the schemas root so the
  // canonical relative refs (e.g. "types/merchant.json") resolve.
  for (const dir of ["ap2", "ap2/types", "ucp/types"]) {
    for (const f of readdirSync(join(SCHEMAS, dir))) {
      if (!f.endsWith(".json")) continue;
      const schema = JSON.parse(readFileSync(join(SCHEMAS, dir, f), "utf8"));
      delete schema.$schema;
      schema.$id = `${dir}/${f}`;
      ajv.addSchema(schema);
    }
  }
  return ajv;
}

const ajv = buildAjv();

function ajvValidate(schemaFile: string, data: unknown): boolean {
  const validate = ajv.getSchema(schemaFile);
  if (!validate) throw new Error(`no ajv schema ${schemaFile}`);
  return validate(data) === true;
}

const paymentMandate = {
  vct: "mandate.payment.1",
  transaction_id: "txn",
  payee: { id: "m", name: "Acme" },
  payment_amount: { currency: "USD", amount: 1000 },
  payment_instrument: { id: "pi", type: "CARD" },
};

const openPaymentMandate = {
  vct: "mandate.payment.open.1",
  constraints: [{ type: "payment.reference", conditional_transaction_id: "chk" }],
  cnf: { jwk: {} },
};

const paymentReceipt = {
  status: "Success",
  iss: "acme",
  iat: 1,
  reference: "r",
  payment_id: "p",
  psp_confirmation_id: "c",
  network_confirmation_id: "n",
};

const checkoutMandate = {
  vct: "mandate.checkout.1",
  checkout_jwt: "a.b.c",
  checkout_hash: "h",
};

describe("Zod codegen agrees with Ajv over the canonical schemas", () => {
  const invalidReceipt: Record<string, unknown> = { ...paymentReceipt };
  delete invalidReceipt["psp_confirmation_id"]; // Success requires it.

  const cases: Array<{ file: string; zod: { safeParse: (d: unknown) => { success: boolean } }; valid: unknown; invalid: unknown }> = [
    {
      file: "ap2/payment_mandate.json",
      zod: PaymentMandateSchema,
      valid: paymentMandate,
      invalid: { ...paymentMandate, vct: "wrong" },
    },
    {
      file: "ap2/open_payment_mandate.json",
      zod: OpenPaymentMandateSchema,
      valid: openPaymentMandate,
      invalid: { vct: "mandate.payment.open.1", cnf: { jwk: {} }, constraints: [] },
    },
    {
      file: "ap2/payment_receipt.json",
      zod: PaymentReceiptSchema,
      valid: paymentReceipt,
      invalid: invalidReceipt,
    },
    {
      file: "ap2/checkout_mandate.json",
      zod: CheckoutMandateSchema,
      valid: checkoutMandate,
      invalid: { vct: "mandate.checkout.1", checkout_hash: "h" },
    },
  ];

  for (const c of cases) {
    it(`accepts valid ${c.file}`, () => {
      expect(ajvValidate(c.file, c.valid)).toBe(true);
      expect(c.zod.safeParse(c.valid).success).toBe(true);
    });
    it(`rejects invalid ${c.file}`, () => {
      expect(ajvValidate(c.file, c.invalid)).toBe(false);
      expect(c.zod.safeParse(c.invalid).success).toBe(false);
    });
  }
});
