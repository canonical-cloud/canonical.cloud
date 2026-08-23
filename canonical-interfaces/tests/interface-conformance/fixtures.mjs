// Deterministic fixture synthesis for every $def in schema/index.json.
//
// Two fixtures per type, chosen to exercise the two ways a generated adapter
// goes wrong:
//
//   full     every field present; nullable fields carry a real value.
//   minimal  only schema-`required` fields; a required-but-nullable field is
//            explicitly null. This is the shape that caught the Dart emitter
//            casting `null as String`.
//
// Values are derived from the schema (const, enum, format, bounds) so the
// fixtures stay valid as the schema evolves, and are fully deterministic so a
// diff between two runs means a real change.

import { loadTypes, isNullable, isStringEnum } from "../../src/generate.mjs";

const nonNull = (s) => {
  if (!s || !Array.isArray(s.type)) return s;
  const types = s.type.filter((t) => t !== "null");
  return { ...s, type: types.length === 1 ? types[0] : types };
};
const refOf = (s) => (s && s.$ref ? s.$ref.split("/").pop() : null);

// Produces the shortest string matching a deliberately narrow subset of regex:
// anchors, literal alternation groups, character classes with ranges, and the
// {n}/{n,m}/*/+/? quantifiers. Anything outside that throws — a fixture suite
// that silently emits schema-invalid data is worse than one that stops.
export function satisfyPattern(pattern, fieldName) {
  const body = pattern.replace(/^\^/, "").replace(/\$$/, "");
  const unsupported = (why) =>
    new Error(`fixtures: cannot satisfy pattern ${pattern} on "${fieldName}" (${why})`);

  const firstOfClass = (contents) => {
    // Ranges win over the literal `-` that may trail a class like [a-z0-9._-].
    const range = /([^\\])-([^\]])/.exec(contents);
    if (range) return range[1];
    const literal = contents.replace(/^\^/, "")[0];
    if (!literal) throw unsupported("empty character class");
    return literal;
  };

  const readQuantifier = (rest) => {
    const exact = /^\{(\d+)(?:,(\d+)?)?\}/.exec(rest);
    if (exact) return { min: Number(exact[1]), width: exact[0].length };
    if (rest.startsWith("*") || rest.startsWith("?")) return { min: 0, width: 1 };
    if (rest.startsWith("+")) return { min: 1, width: 1 };
    return { min: 1, width: 0 };
  };

  let out = "";
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "(") {
      const close = body.indexOf(")", i);
      if (close === -1) throw unsupported("unbalanced group");
      const first = body.slice(i + 1, close).split("|")[0];
      if (/[[\](){}*+?\\]/.test(first)) throw unsupported("non-literal alternation branch");
      out += first;
      i = close + 1;
      const q = readQuantifier(body.slice(i));
      i += q.width;
    } else if (ch === "[") {
      const close = body.indexOf("]", i + 1);
      if (close === -1) throw unsupported("unbalanced character class");
      const unit = firstOfClass(body.slice(i + 1, close));
      i = close + 1;
      const q = readQuantifier(body.slice(i));
      i += q.width;
      out += unit.repeat(q.min);
    } else if (/[A-Za-z0-9_.:/-]/.test(ch)) {
      i += 1;
      const q = readQuantifier(body.slice(i));
      i += q.width;
      out += ch.repeat(q.min);
    } else {
      throw unsupported(`unsupported token "${ch}"`);
    }
  }
  if (!new RegExp(pattern).test(out)) throw unsupported(`produced "${out}", which does not match`);
  return out;
}

function stringValue(schema, fieldName) {
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  switch (schema.format) {
    case "uuid": return "00000000-0000-4000-8000-000000000000";
    case "date": return "2026-01-02";
    case "date-time": return "2026-01-02T03:04:05Z";
    case "email": return "conformance@example.test";
    case "uri": case "uri-reference": return "https://example.test/conformance";
    default: break;
  }
  // A `pattern` we cannot satisfy would produce a value the schema rejects, so
  // satisfyPattern throws rather than emitting something quietly invalid.
  if (schema.pattern) return satisfyPattern(schema.pattern, fieldName);
  const base = `${fieldName}-value`;
  const max = typeof schema.maxLength === "number" ? schema.maxLength : base.length;
  const min = typeof schema.minLength === "number" ? schema.minLength : 0;
  return base.slice(0, Math.max(max, min)).padEnd(min, "x");
}

function valueFor(schema, fieldName, byName, seen) {
  if (schema && "const" in schema) return schema.const;
  const s = nonNull(schema) || {};

  const ref = refOf(s);
  if (ref) {
    if (seen.has(ref)) return null; // cycle guard; only reachable via a nullable edge
    const target = byName.get(ref);
    if (!target) throw new Error(`fixtures: unknown $ref "${ref}"`);
    return objectFor(target, byName, new Set([...seen, ref]), /* full */ true);
  }

  switch (s.type) {
    case "string": return stringValue(s, fieldName);
    case "integer": {
      if (typeof s.minimum === "number") return s.minimum;
      if (typeof s.maximum === "number") return Math.min(1, s.maximum);
      return 1;
    }
    case "number": return typeof s.minimum === "number" ? s.minimum : 1.5;
    case "boolean": return true;
    case "array": {
      const count = Math.max(1, s.minItems || 1);
      return Array.from({ length: count }, (_, i) =>
        valueFor(s.items || {}, `${fieldName}Item${i}`, byName, seen));
    }
    default: return { conformance: "opaque" };
  }
}

function objectFor(type, byName, seen, full) {
  const out = {};
  for (const p of type.props) {
    const include = full || p.required;
    if (!include) continue;
    // minimal + required + nullable -> the explicit-null case.
    if (!full && isNullable(p.schema)) { out[p.name] = null; continue; }
    out[p.name] = valueFor(p.schema, p.name, byName, seen);
  }
  return out;
}

/** @returns {{name: string, variant: 'full'|'minimal', type: string, json: object}[]} */
export function buildFixtures(types = loadTypes()) {
  const byName = new Map(types.map((t) => [t.name, t]));
  const cases = [];
  for (const t of types) {
    for (const variant of ["full", "minimal"]) {
      cases.push({
        name: `${t.name}/${variant}`,
        variant,
        type: t.name,
        json: objectFor(t, byName, new Set([t.name]), variant === "full"),
      });
    }
  }
  return cases;
}

/**
 * Which keys a correct adapter must emit for a fixture, and which it must omit.
 * Schema-`required` keys are always present — including when the value is null,
 * matching serde without `skip_serializing_if`, Go without `omitempty`, and the
 * TypeScript `T | null` (rather than `T?`) declaration.
 */
export function expectedKeys(type, fixture) {
  const present = [];
  const absent = [];
  for (const p of type.props) {
    if (p.required) present.push(p.name);
    else if (fixture.variant === "full") present.push(p.name);
    else absent.push(p.name);
  }
  return { present, absent };
}

export { isStringEnum };
