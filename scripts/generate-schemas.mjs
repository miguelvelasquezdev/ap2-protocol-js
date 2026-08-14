/**
 * Generate Zod v4 schemas + TypeScript types from the canonical AP2 JSON
 * Schemas (code/sdk/schemas). Mirrors the Python SDK's rule (generate, don't
 * hand-maintain) so wire types cannot drift from the spec.
 *
 *   node scripts/generate-schemas.mjs
 *
 * Design notes:
 * - Refs resolve in a FLATTENED namespace (all schema files keyed by
 *   basename), matching the Python generate.py behavior of copying the ap2/
 *   and ucp/ trees into one directory before codegen.
 * - The receipt schemas put a oneOf (status-discriminated) BESIDE root
 *   properties/required. Generic converters drop the per-branch `required`
 *   lists in that shape, so branches are materialized here: base + branch
 *   merged into a z.discriminatedUnion on `status`.
 * - The `contains` keyword on open-mandate constraint arrays (at least one
 *   payment.reference / checkout.line_items constraint) is expressed as a
 *   Zod .refine. The Python codegen cannot express `contains` (pydantic has
 *   no equivalent), so this is validated here and only here.
 * - Objects are z.looseObject: unknown keys are preserved, matching pydantic's
 *   default of ignoring (not stripping) extra fields.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMAS = join(here, "..", "schemas");
const OUT = join(here, "..", "src", "schemas", "generated.ts");

// ---- load all schema files into a flattened registry ----------------------
const registry = new Map(); // basename -> { json, file }
for (const dir of ["ap2", "ap2/types", "ucp/types"]) {
  for (const f of readdirSync(join(SCHEMAS, dir))) {
    if (!f.endsWith(".json")) continue;
    const file = join(SCHEMAS, dir, f);
    registry.set(f, { json: JSON.parse(readFileSync(file, "utf8")), file });
  }
}

// ---- naming ---------------------------------------------------------------
const pascal = (s) =>
  s
    .replace(/\.json$/, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");

const usedNames = new Set();
const nameForFile = new Map(); // basename -> exported name
function claimName(preferred, fallbackPrefix) {
  let name = preferred;
  if (usedNames.has(name)) name = `${fallbackPrefix}${preferred}`;
  if (usedNames.has(name)) throw new Error(`name collision: ${name}`);
  usedNames.add(name);
  return name;
}

// ---- emission -------------------------------------------------------------
const emitted = [];
const emittedFiles = new Set();
const emittingStack = [];

function schemaExpr(s, ctx) {
  if (s.$ref) return refExpr(s.$ref, ctx);
  const variants = s.oneOf ?? s.anyOf;
  if (variants) {
    const parts = variants.map((b) => schemaExpr(b, ctx));
    // Discriminated union when every branch carries a `type` const (the
    // constraint shape); plain union otherwise.
    const allTyped = variants.every((b) => {
      let t = b;
      if (t.$ref?.startsWith("#/$defs/")) t = ctx.defs[t.$ref.slice("#/$defs/".length)];
      return t?.properties?.type?.const !== undefined;
    });
    return allTyped
      ? `z.discriminatedUnion("type", [${parts.join(", ")}])`
      : `z.union([${parts.join(", ")}])`;
  }
  if (s.const !== undefined) return `z.literal(${JSON.stringify(s.const)})`;
  if (s.enum) return `z.enum([${s.enum.map((e) => JSON.stringify(e)).join(", ")}])`;
  switch (s.type) {
    case "string":
      return "z.string()";
    case "integer":
      return "z.number().int()";
    case "number":
      return "z.number()";
    case "boolean":
      return "z.boolean()";
    case "array": {
      const inner = s.items ? schemaExpr(s.items, ctx) : "z.unknown()";
      let expr = `z.array(${inner})`;
      if (s.contains) {
        const containsRef = s.contains.$ref ?? "";
        const constType = containsConstType(s.contains, ctx);
        if (constType) {
          expr += `.refine((arr) => arr.some((c) => c.type === ${JSON.stringify(constType)}), { message: ${JSON.stringify(`must contain at least one ${constType} constraint`)} })`;
        } else {
          throw new Error(`unsupported contains: ${containsRef}`);
        }
      }
      return expr;
    }
    case "object":
    case undefined: {
      if (!s.properties || Object.keys(s.properties).length === 0) {
        return "z.record(z.string(), z.unknown())";
      }
      return objectExpr(s.properties, s.required ?? [], ctx);
    }
    default:
      throw new Error(`unsupported schema type: ${s.type}`);
  }
}

function containsConstType(containsSchema, ctx) {
  let target = containsSchema;
  if (target.$ref?.startsWith("#/$defs/")) {
    target = ctx.defs[target.$ref.slice("#/$defs/".length)];
  }
  return target?.properties?.type?.const;
}

function objectExpr(properties, required, ctx) {
  const lines = [];
  for (const [key, prop] of Object.entries(properties)) {
    const opt = required.includes(key) ? "" : ".optional()";
    const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
    lines.push(`  ${safeKey}: ${schemaExpr(prop, ctx)}${opt},`);
  }
  return `z.looseObject({\n${lines.join("\n")}\n})`;
}

function refExpr(ref, ctx) {
  if (ref.startsWith("#/$defs/")) {
    const defKey = ref.slice("#/$defs/".length);
    return emitDef(defKey, ctx);
  }
  // file ref: "types/merchant.json" | "item.json" -> flattened basename
  const base = basename(ref);
  return `${emitFile(base)}Schema`;
}

function emitDef(defKey, ctx) {
  const cached = ctx.defNames.get(defKey);
  if (cached) return `${cached}Schema`;
  const def = ctx.defs[defKey];
  if (!def) throw new Error(`missing $def ${defKey} in ${ctx.owner}`);
  const name = claimName(pascal(defKey), ctx.ownerName);
  ctx.defNames.set(defKey, name);
  const expr = schemaExpr(def, ctx);
  pushEmit(name, def.title ?? defKey, def.description, expr);
  return `${name}Schema`;
}

function pushEmit(name, title, description, expr) {
  const doc = description ? `/** ${title}: ${description} */\n` : `/** ${title} */\n`;
  emitted.push(
    `${doc}export const ${name}Schema = ${expr};\nexport type ${name} = z.infer<typeof ${name}Schema>;\n`,
  );
}

function emitFile(base) {
  const known = nameForFile.get(base);
  if (known) return known;
  if (emittingStack.includes(base)) throw new Error(`ref cycle at ${base}`);
  const entry = registry.get(base);
  if (!entry) throw new Error(`unresolved schema file ref: ${base}`);
  emittingStack.push(base);

  const json = entry.json;
  const name = claimName(pascal(json.title ?? base), "Ap2");
  nameForFile.set(base, name);

  const ctx = {
    owner: base,
    ownerName: name,
    defs: json.$defs ?? {},
    defNames: new Map(),
  };

  let expr;
  if (json.oneOf && json.properties) {
    // Sibling-oneOf materialization (the receipt shape).
    const branches = json.oneOf.map((branch) => {
      const mergedProps = { ...json.properties, ...(branch.properties ?? {}) };
      const mergedRequired = [
        ...new Set([...(json.required ?? []), ...(branch.required ?? [])]),
      ];
      const branchName = claimName(pascal(branch.title ?? `${name}Variant`), name);
      const branchExpr = objectExpr(mergedProps, mergedRequired, ctx);
      pushEmit(branchName, branch.title ?? branchName, branch.description, branchExpr);
      return `${branchName}Schema`;
    });
    expr = `z.discriminatedUnion("status", [${branches.join(", ")}])`;
  } else if (json.oneOf) {
    const parts = json.oneOf.map((b) => schemaExpr(b, ctx));
    expr = `z.union([${parts.join(", ")}])`;
  } else {
    expr = schemaExpr(json, ctx);
  }

  pushEmit(name, json.title ?? name, json.description, expr);
  emittingStack.pop();
  emittedFiles.add(base);
  return name;
}

// ---- drive: top-level ap2 schemas + the ucp Checkout object ---------------
const TOP_LEVEL = [
  "open_payment_mandate.json",
  "payment_mandate.json",
  "open_checkout_mandate.json",
  "checkout_mandate.json",
  "payment_receipt.json",
  "checkout_receipt.json",
  "checkout.json",
];
for (const f of TOP_LEVEL) emitFile(f);

const header = `/**
 * GENERATED FILE - do not edit by hand.
 * Source of truth: code/sdk/schemas (canonical AP2 JSON Schemas).
 * Regenerate: node scripts/generate-schemas.mjs
 */
import { z } from "zod";
`;
writeFileSync(OUT, `${header}\n${emitted.join("\n")}`);
console.log(`Wrote ${emitted.length} schemas to ${OUT}`);
