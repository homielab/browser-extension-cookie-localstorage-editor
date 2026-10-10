/**
 * Pure helpers for the local storage tab: sorting, filtering, sizing, JSON
 * detection and import/export. Nothing here touches the page or the
 * extension APIs, so all of it runs (and is tested) under plain Node.
 *
 * An entry is `{ key, value }`, both strings, as localStorage stores them.
 */
(function (global) {
  "use strict";

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

  /** `[[key, value], ...]` as read from the page, sorted by key. */
  function toEntries(pairs) {
    return (pairs || [])
      .map(([key, value]) => ({ key: String(key), value: value == null ? "" : String(value) }))
      .sort((a, b) => collator.compare(a.key, b.key) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  function sameEntries(a, b) {
    if (a.length !== b.length) return false;
    return a.every((entry, index) => entry.key === b[index].key && entry.value === b[index].value);
  }

  /** Every whitespace-separated term must appear in the key or the value. */
  function matchesFilter(entry, query) {
    const terms = String(query || "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (!terms.length) return true;
    const haystack = `${entry.key}\u0000${entry.value}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  }

  /** The value parsed, if it is a JSON object or array; otherwise undefined. */
  function parseJson(value) {
    const text = String(value).trim();
    if (!text || (text[0] !== "{" && text[0] !== "[")) return undefined;
    try {
      return JSON.parse(text);
    } catch (_) {
      return undefined;
    }
  }

  const isJson = (value) => parseJson(value) !== undefined;

  /** Pretty-printed JSON, or null if the value is not a JSON object/array. */
  function formatJson(value) {
    const parsed = parseJson(value);
    return parsed === undefined ? null : JSON.stringify(parsed, null, 2);
  }

  /** The same JSON on one line, or null. */
  function compactJson(value) {
    const parsed = parseJson(value);
    return parsed === undefined ? null : JSON.stringify(parsed);
  }

  /** Browsers count the quota in UTF-16 code units: two bytes each. */
  const byteSize = (entry) => (entry.key.length + entry.value.length) * 2;

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  const totalSize = (entries) => entries.reduce((sum, entry) => sum + byteSize(entry), 0);

  /** Problems with a key/value about to be saved, as `{field, message}`. */
  function validateItem(item, entries, originalKey) {
    const errors = [];
    if (item.key === "") errors.push({ field: "key", message: "Give the item a key." });
    else if (item.key !== originalKey && entries.some((entry) => entry.key === item.key)) {
      errors.push({ field: "key", message: `An item called “${item.key}” already exists.` });
    }
    return errors;
  }

  /** A JSON object of key → value, the format `parseImport` reads back. */
  function serializeEntries(entries) {
    const object = {};
    for (const entry of entries) object[entry.key] = entry.value;
    return JSON.stringify(object, null, 2);
  }

  /**
   * Read a pasted JSON object back into entries. Values that are not strings
   * (an object pasted by hand, a number) are stored as their JSON text, which
   * is what the page would have had to do itself.
   * @returns {{entries: Array<{key: string, value: string}>}|{error: string}}
   */
  function parseImport(text) {
    const source = String(text || "").trim();
    if (!source) return { error: "There is nothing to import." };
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch (_) {
      return { error: "That is not valid JSON." };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Expected a JSON object of keys and values." };
    }
    const entries = Object.keys(parsed).map((key) => {
      const value = parsed[key];
      return { key, value: typeof value === "string" ? value : JSON.stringify(value) };
    });
    if (!entries.length) return { error: "That object has no items." };
    return { entries };
  }

  global.StorageUtils = {
    byteSize,
    compactJson,
    formatJson,
    formatSize,
    isJson,
    matchesFilter,
    parseImport,
    sameEntries,
    serializeEntries,
    toEntries,
    totalSize,
    validateItem,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
