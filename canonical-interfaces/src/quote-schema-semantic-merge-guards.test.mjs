import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const schemaDirectory = new URL("schema/", root);

const NON_NULL_SCHEMA_KEYWORDS = new Set([
  "$defs",
  "$ref",
  "additionalProperties",
  "enum",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "pattern",
  "properties",
  "required",
  "type",
  "uniqueItems",
]);

async function loadSchemas() {
  const index = JSON.parse(
    await readFile(new URL("index.json", schemaDirectory), "utf8"),
  );
  assert.ok(Array.isArray(index.schemas), "schema/index.json must list schemas");

  return Promise.all(
    index.schemas.map(async (name) => ({
      name,
      document: JSON.parse(
        await readFile(new URL(name, schemaDirectory), "utf8"),
      ),
    })),
  );
}

function rejectNullStructuralKeywords(value, location) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      rejectNullStructuralKeywords(entry, `${location}[${index}]`),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    const childLocation = `${location}.${key}`;
    if (NON_NULL_SCHEMA_KEYWORDS.has(key)) {
      assert.notEqual(
        child,
        null,
        `${childLocation} is null; omit the keyword or provide a valid value`,
      );
    }
    rejectNullStructuralKeywords(child, childLocation);
  }
}

test("semantic merges never leave null JSON Schema keywords", async () => {
  for (const { name, document } of await loadSchemas()) {
    rejectNullStructuralKeywords(document, name);
  }
});

test("quote-v1 exposes the complete definition set independent of declaration order", async () => {
  const quote = JSON.parse(
    await readFile(new URL("quote.schema.json", schemaDirectory), "utf8"),
  );
  const actual = Object.keys(quote.$defs ?? {}).sort();
  const expected = [
    "QuoteDetail",
    "QuoteEstimate",
    "QuoteListQuery",
    "QuoteListResponse",
    "QuoteProblem",
    "QuoteRequest",
    "QuoteRetryResponse",
    "QuoteStatusEvent",
    "QuoteSubmissionResponse",
    "QuoteSummary",
  ].sort();

  assert.deepEqual(actual, expected);
});

test("Dart quote generation has one authoritative implementation", async () => {
  await assert.rejects(
    access(new URL("src/generate-quote-dart.mjs", root)),
    (error) => error?.code === "ENOENT",
    "the removed duplicate Dart quote generator must not reappear",
  );

  const shim = await readFile(
    new URL("generated/dart/lib/quote_v1.dart", root),
    "utf8",
  );
  assert.match(shim, /export 'canonical_interfaces\.dart';/);
  assert.doesNotMatch(shim, /final class /);
});
