import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const fixtureRoot = new URL("fixtures/quote-v1/", root);
const manifest = JSON.parse(
  await readFile(new URL("manifest.json", fixtureRoot), "utf8"),
);
const schema = JSON.parse(
  await readFile(new URL("schema/quote.schema.json", root), "utf8"),
);
const documentation = await readFile(
  new URL("docs/quote-api-v1.md", root),
  "utf8",
);

const expectedDefinitions = [
  "QuoteRequest",
  "QuoteSubmissionResponse",
  "QuoteDetail",
  "QuoteListResponse",
  "QuoteStatusEvent",
  "QuoteProblem",
  "QuoteRetryResponse",
];

function gitBlob(bytes) {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`, "utf8");
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

async function fixture(definition) {
  const entry = manifest.fixtures[definition];
  assert.ok(entry, `missing manifest entry for ${definition}`);
  const url = new URL(entry.path, fixtureRoot);
  const bytes = await readFile(url);
  assert.equal(
    gitBlob(bytes),
    entry.gitBlob,
    `${entry.path} no longer reproduces its reviewed Git blob`,
  );
  return JSON.parse(bytes.toString("utf8"));
}

test("quote-v1 manifest is complete and schema-backed", async () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.schemaPath, "schema/quote.schema.json");
  assert.equal(
    manifest.schemaRevision,
    "4c6ca63ca24fa214a1cb1a917ac27f1d5265916a",
  );
  assert.equal(manifest.wireCase, "camelCase");
  assert.deepEqual(
    Object.keys(manifest.fixtures).sort(),
    expectedDefinitions.toSorted(),
  );

  for (const definition of expectedDefinitions) {
    assert.ok(schema.$defs[definition], `schema definition ${definition} is missing`);
    const entry = manifest.fixtures[definition];
    assert.match(entry.gitBlob, /^[0-9a-f]{40}$/);
    await fixture(definition);
    assert.ok(
      documentation.includes(`fixtures/quote-v1/${entry.path}`),
      `documentation does not reference ${entry.path}`,
    );
  }
});

test("retry fixture matches the current public transition contract", async () => {
  const value = await fixture("QuoteRetryResponse");
  assert.deepEqual(Object.keys(value).sort(), [
    "quoteId",
    "status",
    "streamUrl",
    "updatedAt",
  ]);
  assert.match(
    value.quoteId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.equal(value.status, "queued");
  assert.equal(value.streamUrl, `/api/v1/quotes/${value.quoteId}/events`);
  assert.ok(Number.isFinite(Date.parse(value.updatedAt)));
});

test("current fixture corpus preserves owner and server authority", async () => {
  const request = await fixture("QuoteRequest");
  assert.equal(request.answersVersion, 1);
  assert.equal(request.contextKey, "quote-analysis");
  assert.ok(
    schema.$defs.QuoteRequest.properties.frameworks.items.enum.includes(
      "nist_800_53",
    ),
    "the current schema no longer supports NIST 800-53",
  );

  for (const forbidden of [
    "userId",
    "user_id",
    "tenantId",
    "tenant_id",
    "contextRecordId",
    "context_record_id",
    "markdownContext",
    "markdown_context",
    "company_name",
    "target_frameworks",
  ]) {
    assert.equal(
      Object.hasOwn(request, forbidden),
      false,
      `caller-controlled field ${forbidden} reappeared`,
    );
  }

  const detail = await fixture("QuoteDetail");
  const list = await fixture("QuoteListResponse");
  const event = await fixture("QuoteStatusEvent");
  assert.ok(
    Object.hasOwn(detail, "quoteId"),
    `QuoteDetail keys: ${Object.keys(detail).join(",")}`,
  );
  assert.ok(
    Array.isArray(list.quotes) &&
      list.quotes.length > 0 &&
      Object.hasOwn(list.quotes[0], "quoteId"),
    `QuoteListResponse first summary keys: ${Object.keys(list.quotes?.[0] ?? {}).join(",")}`,
  );
  assert.ok(
    Object.hasOwn(event, "quoteId"),
    `QuoteStatusEvent keys: ${Object.keys(event).join(",")}`,
  );
  assert.equal(detail.quoteId, event.quoteId, "detail and event quote IDs drifted");
  assert.equal(
    list.quotes[0].quoteId,
    detail.quoteId,
    "list and detail quote IDs drifted",
  );
  assert.ok(
    Number.isFinite(Date.parse(event.occurredAt)),
    "event occurredAt is not an RFC 3339 timestamp",
  );
});
