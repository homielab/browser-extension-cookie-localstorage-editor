/**
 * Unit tests for lib/storage.js — the pure logic behind the Local storage tab.
 *
 *   node --test test/
 */
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

// lib/storage.js assigns to globalThis when loaded as a classic script.
require(path.join(__dirname, "..", "src", "lib", "storage.js"));
const S = globalThis.StorageUtils;

const entry = (key, value) => ({ key, value });

test("toEntries sorts by key, numbers in numeric order, and stringifies", () => {
  assert.deepStrictEqual(
    S.toEntries([
      ["b", "2"],
      ["item10", "x"],
      ["item2", null],
      ["A", 1],
    ]),
    [entry("A", "1"), entry("b", "2"), entry("item2", ""), entry("item10", "x")]
  );
  assert.deepStrictEqual(S.toEntries(undefined), []);
});

test("toEntries keeps keys that differ only in case apart, in a stable order", () => {
  assert.deepStrictEqual(
    S.toEntries([
      ["b", "1"],
      ["B", "2"],
    ]).map((e) => e.key),
    ["B", "b"]
  );
});

test("sameEntries compares keys and values in order", () => {
  assert.ok(S.sameEntries([entry("a", "1")], [entry("a", "1")]));
  assert.ok(!S.sameEntries([entry("a", "1")], [entry("a", "2")]));
  assert.ok(!S.sameEntries([entry("a", "1")], []));
});

test("matchesFilter needs every term in the key or the value, ignoring case", () => {
  const item = entry("Theme", "dark-mode");
  assert.ok(S.matchesFilter(item, ""));
  assert.ok(S.matchesFilter(item, "theme DARK"));
  assert.ok(!S.matchesFilter(item, "theme light"));
});

test("only JSON objects and arrays count as JSON", () => {
  assert.ok(S.isJson('{"a":1}'));
  assert.ok(S.isJson(" [1, 2] "));
  assert.ok(!S.isJson("42"), "a bare number is just text");
  assert.ok(!S.isJson('"str"'));
  assert.ok(!S.isJson("{broken"));
  assert.ok(!S.isJson(""));
});

test("formatJson and compactJson round-trip", () => {
  assert.strictEqual(S.formatJson('{"a":[1]}'), '{\n  "a": [\n    1\n  ]\n}');
  assert.strictEqual(S.compactJson('{\n  "a": [1]\n}'), '{"a":[1]}');
  assert.strictEqual(S.formatJson("text"), null);
  assert.strictEqual(S.compactJson("text"), null);
});

test("sizes count UTF-16 code units, two bytes each", () => {
  assert.strictEqual(S.byteSize(entry("ab", "cde")), 10);
  assert.strictEqual(S.totalSize([entry("a", "b"), entry("cc", "")]), 8);
  assert.strictEqual(S.formatSize(512), "512 B");
  assert.strictEqual(S.formatSize(1536), "1.5 KB");
  assert.strictEqual(S.formatSize(20 * 1024), "20 KB");
  assert.strictEqual(S.formatSize(5 * 1024 * 1024), "5.0 MB");
});

test("validateItem wants a key that is not already taken", () => {
  const entries = [entry("a", "1"), entry("b", "2")];
  assert.deepStrictEqual(S.validateItem(entry("c", ""), entries, null), []);
  assert.strictEqual(S.validateItem(entry("", "x"), entries, null)[0].field, "key");
  assert.match(S.validateItem(entry("b", "x"), entries, null)[0].message, /already exists/);
  assert.deepStrictEqual(S.validateItem(entry("a", "x"), entries, "a"), [], "saving an item under its own key");
  assert.match(S.validateItem(entry("b", "x"), entries, "a")[0].message, /already exists/, "renaming onto another");
});

test("serializeEntries and parseImport round-trip", () => {
  const entries = [entry("a", '{"x":1}'), entry("b", "")];
  assert.deepStrictEqual(S.parseImport(S.serializeEntries(entries)), { entries });
});

test("parseImport stores non-string values as their JSON text", () => {
  assert.deepStrictEqual(S.parseImport('{"n": 1, "o": {"a": true}, "z": null}').entries, [
    entry("n", "1"),
    entry("o", '{"a":true}'),
    entry("z", "null"),
  ]);
});

test("parseImport explains what it could not read", () => {
  assert.match(S.parseImport("").error, /nothing to import/);
  assert.match(S.parseImport("{oops").error, /not valid JSON/);
  assert.match(S.parseImport("[1]").error, /JSON object/);
  assert.match(S.parseImport('"text"').error, /JSON object/);
  assert.match(S.parseImport("{}").error, /no items/);
});
