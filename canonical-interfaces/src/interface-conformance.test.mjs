// Cross-language round-trip conformance for the generated adapters.
//
// Every $def is synthesized into a `full` and a `minimal` fixture, decoded and
// re-encoded by each language's generated types, and compared back to the
// input. This is the check that a type-level bug — a missing type, a bad null
// guard, a dropped key — cannot pass review just because one language happens
// to be the one someone looked at.
//
// Dart and Rust drivers are skipped (not failed) when their toolchain is
// absent, so the suite stays runnable on a bare Node checkout. CI is expected
// to provide both; see tests/interface-conformance/README.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTypes } from './generate.mjs';
import { buildFixtures, expectedKeys } from '../tests/interface-conformance/fixtures.mjs';
import { hasTool, runDart, runRust } from '../tests/interface-conformance/drivers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const types = loadTypes();
const fixtures = buildFixtures(types);
const byName = new Map(types.map((t) => [t.name, t]));

const DART_LIB = join(root, 'generated', 'dart', 'lib', 'canonical_interfaces.dart');
const workdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-conformance-'));

test('fixtures cover every declared type in both variants', () => {
  assert.equal(fixtures.length, types.length * 2);
  for (const t of types) {
    assert.ok(fixtures.some((f) => f.name === `${t.name}/full`), `no full fixture for ${t.name}`);
    assert.ok(fixtures.some((f) => f.name === `${t.name}/minimal`), `no minimal fixture for ${t.name}`);
  }
});

test('minimal fixtures exercise the required-but-nullable case', () => {
  // Guards the regression class directly: if the schema ever stops having a
  // required nullable field this test tells us the suite lost its teeth.
  const nulls = fixtures.filter((f) => f.variant === 'minimal')
    .flatMap((f) => Object.entries(f.json).filter(([, v]) => v === null).map(([k]) => `${f.type}.${k}`));
  assert.ok(nulls.length > 0, 'no required-nullable field present in any minimal fixture');
  assert.ok(nulls.includes('MutationOperation.baseVersion'), `expected baseVersion among ${nulls.join(', ')}`);
});

for (const runtime of ['dart', 'rust']) {
  const bin = runtime === 'dart' ? 'dart' : 'cargo';
  test(`${runtime} round-trips every fixture without loss`, { skip: hasTool(bin) ? false : `${bin} not installed` }, () => {
    const dir = workdir();
    const results = runtime === 'dart'
      ? runDart(dir, types, fixtures, DART_LIB)
      : runRust(dir, types, fixtures, join(root, 'generated', 'rust'));

    for (const fixture of fixtures) {
      const out = results.get(fixture.name);
      assert.ok(out !== undefined, `${runtime} produced no output for ${fixture.name}`);
      assert.deepEqual(out, fixture.json, `${runtime} altered ${fixture.name} on round-trip`);

      const { present, absent } = expectedKeys(byName.get(fixture.type), fixture);
      for (const key of present) {
        assert.ok(key in out, `${runtime}: ${fixture.name} dropped required key "${key}"`);
      }
      for (const key of absent) {
        assert.ok(!(key in out), `${runtime}: ${fixture.name} invented absent optional key "${key}"`);
      }
    }
  });
}

test('dart and rust agree with each other on every fixture', {
  skip: hasTool('dart') && hasTool('cargo') ? false : 'dart and cargo both required',
}, () => {
  const dartOut = runDart(workdir(), types, fixtures, DART_LIB);
  const rustOut = runRust(workdir(), types, fixtures, join(root, 'generated', 'rust'));
  for (const fixture of fixtures) {
    assert.deepEqual(
      dartOut.get(fixture.name),
      rustOut.get(fixture.name),
      `dart and rust disagree on ${fixture.name}`,
    );
  }
});
