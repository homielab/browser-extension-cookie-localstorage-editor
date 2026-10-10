/**
 * Pure cookie helpers: no DOM, no extension APIs. Everything in here is a plain
 * function of its arguments so it can be reasoned about (and unit tested) on
 * its own.
 */
(function (global) {
  "use strict";

  /** SameSite values understood by the cookies API. */
  const SAME_SITES = [
    { value: "unspecified", label: "Unset" },
    { value: "lax", label: "Lax" },
    { value: "strict", label: "Strict" },
    { value: "no_restriction", label: "None" },
  ];

  /** Expiry presets offered by the editor. `null` means "session cookie". */
  const EXPIRY_PRESETS = [
    { value: "session", label: "Session" },
    { value: "1h", label: "1 hour", seconds: 3600 },
    { value: "1d", label: "1 day", seconds: 86400 },
    { value: "7d", label: "7 days", seconds: 604800 },
    { value: "30d", label: "30 days", seconds: 2592000 },
    { value: "1y", label: "1 year", seconds: 31536000 },
    { value: "custom", label: "Custom…" },
  ];

  /** Browsers refuse cookie names and values containing these. */
  const ILLEGAL_CHARS = /[;,]/;

  /** Rough per-cookie size limit; values above this often get truncated. */
  const SOFT_VALUE_LIMIT = 4096;

  /** `value` as a string, with `null`/`undefined` read as empty. */
  const asText = (value) => String(value == null ? "" : value);

  /** `now` if given, otherwise the current time, in Unix seconds. */
  const nowSeconds = (now) => (typeof now === "number" ? now : Date.now() / 1000);

  /** The top-level site a cookie is partitioned by, or `null` if it is not. */
  const partitionSite = (cookie) => (cookie.partitionKey && cookie.partitionKey.topLevelSite) || null;

  /**
   * Work out which site a tab URL refers to and whether cookies can be listed
   * for it at all.
   * @param {string} url
   * @returns {{supported: true, url: string, host: string, secure: boolean}
   *          |{supported: false, reason: string, protocol?: string}}
   */
  function parseSite(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return { supported: false, reason: "This tab has no address, so there are no cookies to manage." };
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      const reason =
        parsed.protocol === "file:"
          ? "Cookies for file:// pages need “Allow access to file URLs” to be enabled for this extension."
          : `Pages on ${parsed.protocol}// can’t have cookies.`;
      return { supported: false, reason, protocol: parsed.protocol };
    }

    return {
      supported: true,
      url: parsed.href,
      host: normalizeDomain(parsed.hostname),
      secure: parsed.protocol === "https:",
    };
  }

  /**
   * Lower-cased, without the leading dot browsers use for domain cookies, and
   * without empty labels ("..a..b.." -> "a.b").
   */
  function normalizeDomain(domain) {
    return asText(domain).trim().toLowerCase().split(".").filter(Boolean).join(".");
  }

  /** IPv4 literals have no parent domains, so they get no chain. */
  function isIpAddress(host) {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  }

  /**
   * The current host and every parent domain a cookie may legally be set on.
   * `www.example.com` -> ["www.example.com", "example.com"]
   *
   * The last entry is assumed to be registrable; public suffixes such as
   * `co.uk` are still offered, but the browser rejects them with an error.
   */
  function domainChain(host) {
    const normalized = normalizeDomain(host);
    if (!normalized) return [];
    const labels = normalized.split(".");
    // A single label ("localhost") or an IPv4 literal has no parent domains.
    if (labels.length === 1 || isIpAddress(normalized)) return [normalized];
    const chain = [];
    for (let i = 0; i < labels.length - 1; i++) chain.push(labels.slice(i).join("."));
    return chain;
  }

  /**
   * Host permissions a site's cookie list needs: the browser only reports and
   * writes cookies for hosts the extension may access, and a page's list
   * includes cookies set on its parent domains, so each of those is asked for
   * by exact host. A wildcard (`*.example.com`) would be simpler, but without
   * the public suffix list it could not tell `example.co.uk` from `co.uk`.
   */
  function accessOrigins(site) {
    return domainChain(site.host).map((domain) => `*://${domain}/*`);
  }

  /** True when `domain` is `host` or a parent domain of it. */
  function isDomainSuffix(domain, host) {
    const d = normalizeDomain(domain);
    const h = normalizeDomain(host);
    return d.length > 0 && (d === h || h.endsWith("." + d));
  }

  /**
   * A URL that the given cookie applies to. The cookies API takes a URL (not a
   * cookie) when writing, and derives scheme, host and path from it.
   */
  function cookieUrl(cookie) {
    const path = normalizePath(cookie.path);
    return `${cookie.secure ? "https" : "http"}://${normalizeDomain(cookie.domain)}${path}`;
  }

  function normalizePath(path) {
    const p = asText(path).trim();
    if (!p) return "/";
    return p.startsWith("/") ? p : "/" + p;
  }

  /** Host part of a URL, normalised. Empty when the URL cannot be parsed. */
  function hostOfUrl(url) {
    try {
      return normalizeDomain(new URL(url).hostname);
    } catch (_) {
      return "";
    }
  }

  /** Options for `cookies.remove`. */
  function removeOptions(cookie) {
    const options = {
      url: cookieUrl(cookie),
      name: cookie.name,
      storeId: cookie.storeId,
    };
    if (cookie.partitionKey) options.partitionKey = cookie.partitionKey;
    return options;
  }

  /**
   * Stable identity for a cookie. Cookies have no id, so name + domain + path
   * + store + partition is the closest thing to one.
   *
   * The domain and path are normalised first, so an import draft, a stored
   * cookie and the `.example.com` spelling all compare equal.
   */
  function cookieKey(cookie) {
    return [
      cookie.name,
      normalizeDomain(cookie.domain),
      // A host-only cookie and a domain cookie on the same host really are two
      // different cookies, even though everything else about them matches.
      cookie.hostOnly === false ? "domain" : "host",
      normalizePath(cookie.path),
      cookie.storeId || "",
      partitionSite(cookie) || "",
    ].join("\u0000");
  }

  /* ---------------------------------------------------------------- expiry */

  /** Human readable expiry for a stored cookie. */
  function expiryInfo(cookie, now) {
    const current = nowSeconds(now);
    if (cookie.session || !cookie.expirationDate) {
      return { session: true, timestamp: null, label: "Session", relative: "", display: "Session", urgent: false };
    }
    const ts = cookie.expirationDate;
    const date = new Date(ts * 1000);
    const relative = relativeTime(ts, current);
    const remaining = ts - current;
    // Within a month the countdown is what matters; past that, the day is
    // enough. The full timestamp stays available as `label`.
    const soon = !relative.expired && remaining < 30 * 86400;
    return {
      session: false,
      timestamp: ts,
      label: formatDateTime(date),
      relative: relative.text,
      display: soon ? relative.text : formatDate(date),
      urgent: !relative.expired && remaining < 86400,
    };
  }

  /** e.g. `{ expired: false, text: "in 3 h" }` */
  function relativeTime(timestamp, now) {
    const delta = timestamp - nowSeconds(now);
    if (delta <= 0) return { expired: true, text: "expired" };
    const units = [
      [31536000, "y"],
      [2592000, "mo"],
      [604800, "w"],
      [86400, "d"],
      [3600, "h"],
      [60, "min"],
    ];
    for (const [seconds, suffix] of units) {
      if (delta >= seconds) return { expired: false, text: `in ${Math.floor(delta / seconds)} ${suffix}` };
    }
    return { expired: false, text: `in ${Math.max(1, Math.round(delta))} s` };
  }

  function formatDateTime(date) {
    return date.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatDate(date) {
    return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  /** Unix seconds -> value for an `<input type="datetime-local">`. */
  function toDateTimeInput(timestamp) {
    const d = new Date(timestamp * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` + `T${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
  }

  /** Value of an `<input type="datetime-local">` -> Unix seconds. */
  function fromDateTimeInput(value) {
    const parsed = new Date(value);
    const time = parsed.getTime();
    return Number.isNaN(time) ? null : time / 1000;
  }

  /**
   * Guess which expiry preset an existing cookie matches, so the editor shows
   * "7 days" rather than "Custom…" for cookies that were set that way.
   */
  function expiryPreset(timestamp, now) {
    if (!timestamp) return { preset: "session", timestamp: null };
    const current = nowSeconds(now);
    for (const option of EXPIRY_PRESETS) {
      if (!option.seconds) continue;
      if (Math.abs(timestamp - (current + option.seconds)) < 60) {
        return { preset: option.value, timestamp };
      }
    }
    return { preset: "custom", timestamp };
  }

  /* ---------------------------------------------------------------- drafts */

  /** A draft describing a brand new cookie for the given site. */
  function blankDraft(site, storeId) {
    return {
      name: "",
      value: "",
      domain: site.host,
      hostOnly: true,
      path: "/",
      sameSite: "lax",
      secure: site.secure,
      httpOnly: false,
      expirationDate: null,
      partitionKey: null,
      storeId: storeId || "0",
    };
  }

  /** A draft pre-filled from an existing cookie, ready for editing. */
  function draftFromCookie(cookie) {
    return {
      name: cookie.name,
      value: cookie.value,
      domain: normalizeDomain(cookie.domain),
      hostOnly: cookie.hostOnly !== false,
      path: normalizePath(cookie.path),
      sameSite: cookie.sameSite || "unspecified",
      secure: !!cookie.secure,
      httpOnly: !!cookie.httpOnly,
      expirationDate: cookie.session ? null : cookie.expirationDate || null,
      partitionKey: cookie.partitionKey ? { topLevelSite: cookie.partitionKey.topLevelSite } : null,
      storeId: cookie.storeId,
    };
  }

  /**
   * Validate a draft. `site` is the parsed tab URL.
   * @returns {{errors: Array<{field: string, message: string}>,
   *            warnings: Array<{field: string, message: string}>}}
   */
  function validateDraft(draft, site) {
    const errors = [];
    const warnings = [];

    const name = String(draft.name || "");
    const value = String(draft.value || "");
    const domain = normalizeDomain(draft.domain);

    if (!name) {
      errors.push({ field: "name", message: "Give the cookie a name." });
    } else if (ILLEGAL_CHARS.test(name)) {
      errors.push({ field: "name", message: "Names can’t contain “;” or “,”." });
    }

    if (!domain) {
      errors.push({ field: "domain", message: "Give the cookie a domain." });
    } else if (!isDomainSuffix(domain, site.host)) {
      errors.push({
        field: "domain",
        message: `Must be ${site.host} or one of its parent domains.`,
      });
    }

    const path = normalizePath(draft.path);
    if (path !== String(draft.path || "").trim()) {
      warnings.push({ field: "path", message: "Paths have to start with “/”." });
    }

    if (draft.sameSite === "no_restriction" && !draft.secure) {
      errors.push({ field: "sameSite", message: "SameSite=None needs the Secure attribute." });
    }

    if (draft.partitionKey && !draft.partitionKey.topLevelSite) {
      errors.push({ field: "partition", message: "Enter the site this cookie is partitioned by." });
    } else if (draft.partitionKey && !draft.secure) {
      errors.push({ field: "partition", message: "Partitioned cookies need the Secure attribute." });
    }

    // The cookies API derives the scheme from the cookie's own Secure flag, so
    // this really does get stored -- it just never reaches the page the user is
    // looking at.
    if (draft.secure && !site.secure) {
      warnings.push({
        field: "secure",
        message: `${site.host} is served over HTTP, so the page will not receive this cookie.`,
      });
    }

    if (ILLEGAL_CHARS.test(value)) {
      warnings.push({
        field: "value",
        message: "Browsers reject values containing “;” or “,” — try URL-encoding them.",
      });
    }
    if (value.length > SOFT_VALUE_LIMIT) {
      warnings.push({
        field: "value",
        message: `Long values (over ${SOFT_VALUE_LIMIT} characters) may be truncated.`,
      });
    }
    if (draft.expirationDate && draft.expirationDate * 1000 <= Date.now()) {
      warnings.push({ field: "expiry", message: "That date has passed, so saving will delete the cookie." });
    }

    return { errors, warnings };
  }

  /**
   * Translate a draft into the argument for `cookies.set`.
   *
   * Note the asymmetry around host-only cookies: for those the domain is not
   * sent at all, and the URL host decides which host the cookie belongs to.
   */
  function buildDetails(draft, site) {
    const domain = normalizeDomain(draft.domain);
    const path = normalizePath(draft.path);
    const host = draft.hostOnly ? site.host : domain;

    const details = {
      url: `${draft.secure ? "https" : "http"}://${host}${path}`,
      name: String(draft.name || "").trim(),
      value: asText(draft.value),
      path,
      secure: !!draft.secure,
      httpOnly: !!draft.httpOnly,
      sameSite: draft.sameSite || "unspecified",
      storeId: draft.storeId,
    };

    if (!draft.hostOnly) details.domain = domain;
    if (draft.expirationDate) details.expirationDate = draft.expirationDate;
    if (draft.partitionKey) details.partitionKey = { topLevelSite: draft.partitionKey.topLevelSite };

    return details;
  }

  /** Rebuild the `cookies.set` arguments that would recreate a cookie as-is. */
  function detailsFromCookie(cookie) {
    return buildDetails(draftFromCookie(cookie), { host: normalizeDomain(cookie.domain) });
  }

  /**
   * Whether writing `details` overwrites `cookie`, or would create a *second*
   * cookie next to it. A cookie is identified by name + domain + path + store +
   * partition, so anything else needs the original removed first.
   */
  function isSameCookieIdentity(cookie, details) {
    const domain = normalizeDomain(details.domain || hostOfUrl(details.url));

    return (
      cookie.name === details.name &&
      normalizeDomain(cookie.domain) === domain &&
      normalizePath(cookie.path) === normalizePath(details.path) &&
      (cookie.hostOnly !== false) === !details.domain &&
      partitionSite(cookie) === partitionSite(details)
    );
  }

  /* ------------------------------------------------------- import/export */

  const EXPORT_FORMATS = [
    { value: "json", label: "JSON", extension: "json", lossless: true },
    { value: "header", label: "Cookie header string", extension: "txt", lossless: false },
  ];

  /** The export format called `value`, falling back to the first (JSON). */
  function findExportFormat(value) {
    return EXPORT_FORMATS.find((format) => format.value === value) || EXPORT_FORMATS[0];
  }

  /** Per-cookie fields worth keeping in a portable export. */
  const EXPORT_FIELDS = [
    "name",
    "value",
    "domain",
    "hostOnly",
    "path",
    "secure",
    "httpOnly",
    "sameSite",
    "session",
    "expirationDate",
  ];

  /**
   * A stored cookie as a plain object that can be written to a file and read
   * back, on this machine or another. `storeId` is deliberately left out: it
   * names a particular browser's private store and means nothing elsewhere.
   */
  function toExportable(cookie) {
    const exported = {};
    for (const field of EXPORT_FIELDS) {
      if (cookie[field] !== undefined) exported[field] = cookie[field];
    }
    // Browsers report expirations with a fractional part; whole seconds is all
    // that is meaningful, and it keeps a re-import from looking different.
    if (typeof exported.expirationDate === "number") {
      exported.expirationDate = Math.floor(exported.expirationDate);
    }
    // A session cookie is stored as the absence of an expiration, but the flag
    // is written out too so that reading the file back needs no convention.
    if (cookie.expirationDate === undefined) exported.session = cookie.session !== false;
    else delete exported.session;
    if (cookie.partitionKey) exported.partitionKey = { topLevelSite: cookie.partitionKey.topLevelSite };
    return exported;
  }

  /** The whole list, ready to be written out. */
  function toJson(cookies) {
    return JSON.stringify(cookies.map(toExportable), null, 2);
  }

  /**
   * The list as a `Cookie:` request header, which is what `document.cookie`
   * looks like. Only names and values survive: every attribute is dropped.
   */
  function toHeaderString(cookies) {
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  /** Render the list in the requested format. */
  function serializeCookies(cookies, format) {
    return findExportFormat(format).value === "header" ? toHeaderString(cookies) : toJson(cookies);
  }

  /** Unix seconds, accepting milliseconds from hand-written JSON. */
  function toUnixSeconds(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return null;
    return number > 1e11 ? Math.floor(number / 1000) : Math.floor(number);
  }

  /** Accept `None`/`Lax`/`Strict` as well as the API's own spelling. */
  function normalizeSameSite(value) {
    const text = asText(value).trim().toLowerCase();
    if (!text) return "unspecified";
    if (text === "none" || text === "no_restriction") return "no_restriction";
    if (text === "lax") return "lax";
    if (text === "strict") return "strict";
    return "unspecified";
  }

  /**
   * Turn one imported record into a draft for this site.
   *
   * @param {object} raw
   * @param {object} site parsed tab URL
   * @returns {{draft: object}|{error: string}}
   */
  function normalizeImportedCookie(raw, site) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { error: "Each cookie has to be an object." };
    }

    const name = asText(raw.name).trim();
    if (!name) return { error: "A cookie has no name." };

    const domain = normalizeDomain(raw.domain) || site.host;
    // A leading dot is how every other tool spells "this and its subdomains".
    const hostOnly = typeof raw.hostOnly === "boolean" ? raw.hostOnly : !asText(raw.domain).startsWith(".");

    const expirationDate = toUnixSeconds(raw.expirationDate);

    const draft = {
      name,
      value: raw.value == null ? "" : String(raw.value),
      domain,
      hostOnly,
      path: normalizePath(raw.path),
      // Absent attributes fall back to what "Add cookie" would have used, so a
      // pasted cookie behaves like a freshly created one on this page.
      sameSite: raw.sameSite == null ? "lax" : normalizeSameSite(raw.sameSite),
      secure: raw.secure == null ? site.secure : raw.secure === true,
      httpOnly: raw.httpOnly === true,
      expirationDate,
      partitionKey:
        raw.partitionKey && raw.partitionKey.topLevelSite
          ? { topLevelSite: String(raw.partitionKey.topLevelSite) }
          : null,
      storeId: "0",
    };

    // SameSite=None and partitioning both need Secure; honour the intent rather
    // than refusing the import.
    if (draft.sameSite === "no_restriction" || draft.partitionKey) draft.secure = true;

    return { draft };
  }

  /**
   * Split a header string such as `a=1; b=2` into name/value pairs. Values may
   * contain `=`; only the first one separates.
   */
  function parseHeaderString(text) {
    const cookies = [];
    for (const part of String(text).split(";")) {
      const pair = part.trim();
      if (!pair) continue;
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      cookies.push({ name: pair.slice(0, separator).trim(), value: pair.slice(separator + 1).trim() });
    }
    return cookies;
  }

  /**
   * Read pasted text as cookies.
   *
   * JSON is recognised by a leading `{` or `[`. Anything else is treated as a
   * header string. A JSON object is accepted either as a bare array, wrapped in
   * `{ "cookies": [...] }` (what several other cookie editors export), or as a
   * single cookie.
   *
   * @param {string} text
   * @param {object} site parsed tab URL
   * @returns {{format: string, entries: Array<{draft: object}|{error: string}>}}
   */
  function parseImport(text, site) {
    const trimmed = asText(text).trim();
    if (!trimmed) return { format: "none", entries: [], error: "There is nothing to import." };

    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      const entries = parseHeaderString(trimmed).map((raw) => normalizeImportedCookie(raw, site));
      if (!entries.length) return { format: "header", entries: [], error: "No “name=value” pairs were found." };
      return { format: "header", entries };
    }

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      return { format: "json", entries: [], error: `That is not valid JSON (${error.message}).` };
    }

    let list = parsed;
    if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.cookies)) list = parsed.cookies;
    else if (parsed && typeof parsed === "object" && parsed.name) list = [parsed];
    else if (!Array.isArray(list)) {
      return { format: "json", entries: [], error: 'Expected a cookie, a list of cookies, or { "cookies": [...] }.' };
    }

    if (!list.length) return { format: "json", entries: [], error: "That list is empty." };

    return { format: "json", entries: list.map((raw) => normalizeImportedCookie(raw, site)) };
  }

  /**
   * Cookies in `next` that are not already in `current`. Used to implement
   * "replace": everything imported is written, then whatever is left over goes.
   *
   * Drafts and stored cookies are both accepted, because `cookieKey` compares
   * exactly the fields the browser uses to tell them apart.
   */
  function cookiesMissingFrom(next, current) {
    const wanted = new Set(next.map(cookieKey));
    return current.filter((cookie) => !wanted.has(cookieKey(cookie)));
  }

  /* ----------------------------------------------------------------- lists */

  /** Deterministic ordering: by name, then by path. */
  function sortCookies(cookies) {
    return cookies.slice().sort((a, b) => {
      const byName = String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" });
      if (byName !== 0) return byName;
      return String(a.path).localeCompare(String(b.path));
    });
  }

  /** Fields that change what a listed cookie looks like or does. */
  const COMPARED_FIELDS = [
    "name",
    "value",
    "domain",
    "path",
    "expirationDate",
    "secure",
    "httpOnly",
    "sameSite",
    "session",
    "storeId",
  ];

  /** Whether two lists describe the same cookies in the same order. */
  function sameCookieList(a, b) {
    if (a.length !== b.length) return false;
    return a.every((cookie, index) => {
      const other = b[index];
      return (
        !!other &&
        COMPARED_FIELDS.every((field) => cookie[field] === other[field]) &&
        partitionSite(cookie) === partitionSite(other)
      );
    });
  }

  /** All whitespace separated terms must appear somewhere in the cookie. */
  function matchesFilter(cookie, query) {
    const terms = String(query || "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (!terms.length) return true;
    const haystack = [cookie.name, cookie.value, cookie.domain, cookie.path].join("\u0000").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  }

  global.CookieUtils = {
    EXPORT_FORMATS,
    EXPIRY_PRESETS,
    SAME_SITES,
    accessOrigins,
    blankDraft,
    buildDetails,
    cookieKey,
    cookieUrl,
    cookiesMissingFrom,
    detailsFromCookie,
    domainChain,
    draftFromCookie,
    expiryInfo,
    expiryPreset,
    findExportFormat,
    fromDateTimeInput,
    isDomainSuffix,
    isSameCookieIdentity,
    matchesFilter,
    normalizeSameSite,
    normalizeDomain,
    normalizePath,
    parseHeaderString,
    parseImport,
    parseSite,
    relativeTime,
    removeOptions,
    sameCookieList,
    serializeCookies,
    sortCookies,
    toDateTimeInput,
    toExportable,
    toHeaderString,
    toJson,
    toUnixSeconds,
    validateDraft,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
