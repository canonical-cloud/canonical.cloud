# Cross-language round-trip conformance

Proves that the generated adapters do not merely *declare* the same types, but
*behave* the same when a real payload passes through them.

```sh
node --test src/interface-conformance.test.mjs
```

## What it does

For every `$def` in `schema/index.json`, `fixtures.mjs` synthesizes two payloads:

| Variant | Shape | Catches |
| --- | --- | --- |
| `full` | every field present, nullable fields carry a value | dropped keys, mangled nesting |
| `minimal` | only schema-`required` fields; required-nullable fields explicitly `null` | bad null guards, keys wrongly omitted |

Each payload is decoded and re-encoded by the generated Dart and Rust types and
compared back to the input, then the two languages are compared to each other.

The `minimal` variant is the one that matters most. `MutationOperation.baseVersion`
is `required` **and** nullable, and an adapter that guards null only on
*optional* fields will emit `json["baseVersion"] as String` and throw on the null
the schema explicitly permits. A test asserts that such a field still exists in
the schema, so the suite cannot quietly lose its teeth.

## Fixture values

Values are derived from the schema — `const`, `enum`, `format`, `minimum`,
`minItems`, `maxLength`, and `pattern` — so fixtures stay valid as the schema
evolves, and they are fully deterministic, so a diff between runs is a real
change.

`satisfyPattern` handles a deliberately narrow regex subset: anchors, literal
alternation groups, character classes with ranges, and `{n}` / `{n,m}` / `*` /
`+` / `?`. Anything outside that **throws**. A fixture suite that silently emits
schema-invalid data is worse than one that stops, so unsupported patterns are a
build break rather than a guess. Every generated value is re-checked against its
own pattern before use.

## Drivers

The Dart and Rust drivers are **generated** from the type list rather than
committed. A hand-maintained driver would drift into exactly the partial
coverage this suite exists to catch — a new `$def` is covered the moment it
appears in `schema/index.json`.

Both are skipped, not failed, when their toolchain is absent, so the suite still
runs on a bare Node checkout. CI should provide `dart` and `cargo`; without them
these tests report as skipped and prove nothing.

## Verified against mutants

The suite was checked by deliberately reintroducing each bug it is meant to
catch, and confirming it fails:

| Mutation | Result |
| --- | --- |
| Null-guard narrowed back to optional-only | Dart throws `type 'Null' is not a subtype of type 'String'`; Rust stays green; cross-language check fails |
| Dart emitter filtered back to `Quote*` types | `dart missing HealthStatus` |
| Required-nullable key made conditional in `toJson` | Round-trip loses `baseVersion`; cross-language check fails |

A suite that has never been seen to fail is not evidence. Re-run this exercise
when changing the emitters.
