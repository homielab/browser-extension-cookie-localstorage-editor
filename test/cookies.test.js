/**
 * Unit tests for lib/cookies.js — the pure logic. Run with:
 *
 *   node --test test/
 */
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

// lib/cookies.js assigns to globalThis when loaded as a classic script.
require(path.join(__dirname, "..", "src", "lib", "cookies.js"));
const U = globalThis.CookieUtils;

const NOW = 1_700_000_000;
const site = (host, secure = true) => ({ host, secure, url: `https://${host}/`, supported: true });

/* ------------------------------------------------------------ parseSite -- */

test("parseSite accepts http and https", () => {
  assert.deepStrictEqual(U.parseSite("https://www.example.com/a?b=1"), {
    supported: true,
    url: "https://www.example.com/a?b=1",
    host: "www.example.com",
    secure: true,
  });
  const insecure = U.parseSite("http://example.com/");
  assert.equal(insecure.supported, true);
  assert.equal(insecure.secure, false);
  assert.equal(insecure.host, "example.com");
});

test("parseSite rejects non-web protocols with a reason", () => {
  for (const url of ["chrome://settings/", "about:blank", "moz-extension://abc/x.html", "edge://flags"]) {
    const result = U.parseSite(url);
    assert.equal(result.supported, false, url);
    assert.match(result.reason, /cookies|file/i, url);
  }
});

test("parseSite explains the file:// case specifically", () => {
  assert.match(U.parseSite("file:///tmp/index.html").reason, /file URLs/);
});

test("parseSite survives a non-URL", () => {
  assert.equal(U.parseSite(undefined).supported, false);
  assert.equal(U.parseSite("").supported, false);
  assert.equal(U.parseSite("not a url").supported, false);
});

test("parseSite lower-cases the host", () => {
  assert.equal(U.parseSite("https://WWW.Example.COM/").host, "www.example.com");
});

/* ------------------------------------------------------------ domains --- */

test("normalizeDomain strips dots, case and whitespace", () => {
  assert.equal(U.normalizeDomain(".Example.COM. "), "example.com");
  assert.equal(U.normalizeDomain("..a..b.."), "a.b");
  assert.equal(U.normalizeDomain(null), "");
});

test("domainChain offers the host and its parents", () => {
  assert.deepStrictEqual(U.domainChain("www.example.com"), ["www.example.com", "example.com"]);
  // The public suffix is included too; the browser is the authority on which
  // domains it will actually accept.
  assert.deepStrictEqual(U.domainChain("a.b.c.example.co.uk"), [
    "a.b.c.example.co.uk",
    "b.c.example.co.uk",
    "c.example.co.uk",
    "example.co.uk",
    "co.uk",
  ]);
});

test("accessOrigins asks for the host and each parent, by exact host", () => {
  assert.deepStrictEqual(U.accessOrigins(U.parseSite("https://a.www.example.com/x")), [
    "*://a.www.example.com/*",
    "*://www.example.com/*",
    "*://example.com/*",
  ]);
  assert.deepStrictEqual(U.accessOrigins(U.parseSite("http://localhost:8080/")), ["*://localhost/*"]);
  assert.deepStrictEqual(U.accessOrigins(U.parseSite("http://127.0.0.1/")), ["*://127.0.0.1/*"]);
});

test("domainChain handles hosts that cannot have parents", () => {
  assert.deepStrictEqual(U.domainChain("localhost"), ["localhost"]);
  assert.deepStrictEqual(U.domainChain("127.0.0.1"), ["127.0.0.1"], "an IPv4 literal has no parents");
  assert.deepStrictEqual(U.domainChain(""), []);
});

test("isDomainSuffix allows the host and parents but not children or strangers", () => {
  const host = "www.example.com";
  for (const ok of ["www.example.com", "example.com", ".example.com"]) {
    assert.equal(U.isDomainSuffix(ok, host), true, ok);
  }
  for (const bad of ["sub.www.example.com", "example.org", "evilexample.com", ""]) {
    assert.equal(U.isDomainSuffix(bad, host), false, bad);
  }
});

/* -------------------------------------------------------------- urls ---- */

test("cookieUrl derives scheme from Secure and keeps the path", () => {
  assert.equal(U.cookieUrl({ domain: ".example.com", path: "/api", secure: true }), "https://example.com/api");
  assert.equal(U.cookieUrl({ domain: "example.com", path: "/", secure: false }), "http://example.com/");
});

test("cookieUrl repairs a path with no leading slash", () => {
  assert.equal(U.cookieUrl({ domain: "example.com", path: "api", secure: true }), "https://example.com/api");
  assert.equal(U.cookieUrl({ domain: "example.com", path: "", secure: true }), "https://example.com/");
});

test("removeOptions carries the store and partition key", () => {
  assert.deepStrictEqual(U.removeOptions({ name: "a", domain: "example.com", path: "/", secure: true, storeId: "0" }), {
    url: "https://example.com/",
    name: "a",
    storeId: "0",
  });
  assert.deepStrictEqual(
    U.removeOptions({
      name: "a",
      domain: "example.com",
      path: "/",
      secure: true,
      storeId: "firefox-private",
      partitionKey: { topLevelSite: "https://top.example" },
    }),
    {
      url: "https://example.com/",
      name: "a",
      storeId: "firefox-private",
      partitionKey: { topLevelSite: "https://top.example" },
    }
  );
});

test("cookieKey distinguishes cookies that only differ in path or partition", () => {
  const base = { name: "a", domain: "example.com", path: "/", storeId: "0" };
  assert.equal(U.cookieKey(base), U.cookieKey({ ...base }));
  assert.notEqual(U.cookieKey(base), U.cookieKey({ ...base, path: "/x" }));
  assert.notEqual(U.cookieKey(base), U.cookieKey({ ...base, partitionKey: { topLevelSite: "https://t.example" } }));
  // The fields are joined with a NUL, so a cookie whose name contains one
  // still cannot be confused with a different name and path.
  assert.notEqual(U.cookieKey({ ...base, name: "a\u0000b" }), U.cookieKey({ ...base, name: "a", path: "b" }));
});

/* ------------------------------------------------------------- expiry --- */

test("expiryInfo reports session cookies", () => {
  const info = U.expiryInfo({ session: true }, NOW);
  assert.equal(info.session, true);
  assert.equal(info.display, "Session");
});

test("expiryInfo formats a fixed expiry and adds a relative hint when soon", () => {
  const soon = U.expiryInfo({ expirationDate: NOW + 3600 }, NOW);
  assert.match(soon.display, /in 1 h/);
  assert.equal(soon.session, false);

  const later = U.expiryInfo({ expirationDate: NOW + 400 * 86400 }, NOW);
  assert.doesNotMatch(later.display, /in /);
  assert.match(later.label, /\d{4}/);
});

test("expiryInfo marks past expiry", () => {
  const info = U.expiryInfo({ expirationDate: NOW - 60 }, NOW);
  assert.equal(info.relative, "expired");
});

test("relativeTime picks a sensible unit", () => {
  assert.deepStrictEqual(U.relativeTime(NOW + 30, NOW), { expired: false, text: "in 30 s" });
  assert.deepStrictEqual(U.relativeTime(NOW + 90, NOW), { expired: false, text: "in 1 min" });
  assert.deepStrictEqual(U.relativeTime(NOW + 3 * 86400, NOW), { expired: false, text: "in 3 d" });
  assert.deepStrictEqual(U.relativeTime(NOW + 5 * 2592000, NOW), { expired: false, text: "in 5 mo" });
  assert.deepStrictEqual(U.relativeTime(NOW - 1, NOW), { expired: true, text: "expired" });
});

test("expiryPreset recognises the presets it offers", () => {
  assert.equal(U.expiryPreset(null, NOW).preset, "session");
  assert.equal(U.expiryPreset(NOW + 7 * 86400, NOW).preset, "7d");
  assert.equal(U.expiryPreset(NOW + 3600, NOW).preset, "1h");
  assert.equal(U.expiryPreset(NOW + 1234567, NOW).preset, "custom");
});

test("datetime round-trips through the input value", () => {
  const stamp = 1_700_000_000;
  const value = U.toDateTimeInput(stamp);
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  const back = U.fromDateTimeInput(value);
  assert.equal(back, Math.floor(stamp / 60) * 60);
});

test("fromDateTimeInput returns null for nonsense", () => {
  assert.equal(U.fromDateTimeInput(""), null);
  assert.equal(U.fromDateTimeInput("not-a-date"), null);
});

/* ------------------------------------------------------------ drafts ---- */

test("blankDraft starts from the site, session, no path restrictions", () => {
  const draft = U.blankDraft(site("www.example.com", true), "0");
  assert.deepStrictEqual(draft, {
    name: "",
    value: "",
    domain: "www.example.com",
    hostOnly: true,
    path: "/",
    sameSite: "lax",
    secure: true,
    httpOnly: false,
    expirationDate: null,
    partitionKey: null,
    storeId: "0",
  });
});

test("blankDraft does not claim Secure on an http page", () => {
  assert.equal(U.blankDraft(site("example.com", false), "0").secure, false);
});

test("draftFromCookie captures every attribute", () => {
  const draft = U.draftFromCookie({
    name: "sid",
    value: "abc",
    domain: ".example.com",
    path: "/app",
    hostOnly: false,
    secure: true,
    httpOnly: true,
    sameSite: "strict",
    session: false,
    expirationDate: NOW,
    partitionKey: { topLevelSite: "https://top.example" },
    storeId: "0",
  });
  assert.deepStrictEqual(draft, {
    name: "sid",
    value: "abc",
    domain: "example.com",
    hostOnly: false,
    path: "/app",
    sameSite: "strict",
    secure: true,
    httpOnly: true,
    expirationDate: NOW,
    partitionKey: { topLevelSite: "https://top.example" },
    storeId: "0",
  });
});

test("draftFromCookie turns a missing hostOnly into true", () => {
  assert.equal(U.draftFromCookie({ name: "a", domain: "example.com", path: "/" }).hostOnly, true);
});

/* ------------------------------------------------------ buildDetails ---- */

test("buildDetails omits domain for host-only cookies", () => {
  const details = U.buildDetails(
    { ...U.blankDraft(site("www.example.com"), "0"), name: "a", value: "v" },
    site("www.example.com")
  );
  assert.deepStrictEqual(details, {
    url: "https://www.example.com/",
    name: "a",
    value: "v",
    path: "/",
    secure: true,
    httpOnly: false,
    sameSite: "lax",
    storeId: "0",
  });
  assert.ok(!("domain" in details));
});

test("buildDetails sends domain for cookies that cover subdomains", () => {
  const draft = { ...U.blankDraft(site("www.example.com"), "0"), name: "a", hostOnly: false, domain: "example.com" };
  const details = U.buildDetails(draft, site("www.example.com"));
  assert.equal(details.domain, "example.com");
  assert.equal(details.url, "https://example.com/");
});

test("buildDetails follows the Secure flag for the scheme", () => {
  const draft = { ...U.blankDraft(site("www.example.com", false), "0"), name: "a", secure: true };
  assert.equal(U.buildDetails(draft, site("www.example.com", false)).url, "https://www.example.com/");
});

test("buildDetails only sends an expirationDate when there is one", () => {
  const base = { ...U.blankDraft(site("www.example.com"), "0"), name: "a" };
  assert.ok(!("expirationDate" in U.buildDetails(base, site("www.example.com"))));
  const withExpiry = { ...base, expirationDate: NOW };
  assert.equal(U.buildDetails(withExpiry, site("www.example.com")).expirationDate, NOW);
});

test("buildDetails sends a bare partition key", () => {
  const draft = {
    ...U.blankDraft(site("www.example.com"), "0"),
    name: "a",
    secure: true,
    partitionKey: { topLevelSite: "https://top.example", hasCrossSiteAncestor: true },
  };
  assert.deepStrictEqual(U.buildDetails(draft, site("www.example.com")).partitionKey, {
    topLevelSite: "https://top.example",
  });
});

test("buildDetails keeps an empty value and trims the name", () => {
  const draft = { ...U.blankDraft(site("www.example.com"), "0"), name: "  a  ", value: "" };
  const details = U.buildDetails(draft, site("www.example.com"));
  assert.equal(details.name, "a");
  assert.equal(details.value, "");
});

test("detailsFromCookie round-trips a stored cookie", () => {
  const cookie = {
    name: "sid",
    value: "v1",
    domain: ".example.com",
    path: "/app",
    hostOnly: false,
    secure: true,
    httpOnly: true,
    sameSite: "no_restriction",
    session: false,
    expirationDate: NOW,
    storeId: "3",
  };
  assert.deepStrictEqual(
    U.detailsFromCookie(cookie),
    U.buildDetails(U.draftFromCookie(cookie), { host: "example.com" })
  );
  assert.deepStrictEqual(U.detailsFromCookie(cookie), {
    url: "https://example.com/app",
    name: "sid",
    value: "v1",
    domain: "example.com",
    path: "/app",
    secure: true,
    httpOnly: true,
    sameSite: "no_restriction",
    expirationDate: NOW,
    storeId: "3",
  });
});

/* ------------------------------------------------- cookie identity ------ */

test("isSameCookieIdentity matches an in-place edit", () => {
  const cookie = {
    name: "a",
    value: "1",
    domain: "example.com",
    path: "/",
    hostOnly: true,
    secure: true,
    storeId: "0",
  };
  const details = U.buildDetails({ ...U.draftFromCookie(cookie), value: "2" }, site("example.com"));
  assert.equal(U.isSameCookieIdentity(cookie, details), true);
});

test("isSameCookieIdentity spots a change of name, domain, path or host-only-ness", () => {
  const cookie = {
    name: "a",
    value: "1",
    domain: "example.com",
    path: "/",
    hostOnly: true,
    secure: true,
    storeId: "0",
  };
  const ctx = site("example.com");
  const variant = (changes) => U.buildDetails({ ...U.draftFromCookie(cookie), ...changes }, ctx);

  assert.equal(U.isSameCookieIdentity(cookie, variant({ name: "b" })), false);
  assert.equal(U.isSameCookieIdentity(cookie, variant({ path: "/x" })), false);
  assert.equal(
    U.isSameCookieIdentity(cookie, variant({ hostOnly: false, domain: "example.com" })),
    false,
    "host-only -> domain cookie is a different cookie"
  );
  assert.equal(
    U.isSameCookieIdentity(
      { ...cookie, hostOnly: false, domain: ".example.com" },
      variant({ hostOnly: false, domain: "example.com" })
    ),
    true,
    "the same domain cookie is the same cookie"
  );
});

test("isSameCookieIdentity compares the partition key", () => {
  const cookie = {
    name: "a",
    value: "1",
    domain: "example.com",
    path: "/",
    hostOnly: true,
    secure: true,
    storeId: "0",
  };
  const plain = U.buildDetails(U.draftFromCookie(cookie), site("example.com"));
  const partitioned = U.buildDetails(
    { ...U.draftFromCookie(cookie), secure: true, partitionKey: { topLevelSite: "https://top.example" } },
    site("example.com")
  );
  assert.equal(U.isSameCookieIdentity(cookie, plain), true);
  assert.equal(U.isSameCookieIdentity(cookie, partitioned), false);
  assert.equal(
    U.isSameCookieIdentity({ ...cookie, partitionKey: { topLevelSite: "https://top.example" } }, partitioned),
    true
  );
});

test("isSameCookieIdentity treats a leading dot as the same domain", () => {
  const cookie = {
    name: "a",
    value: "1",
    domain: "example.com",
    path: "/",
    hostOnly: false,
    secure: true,
    storeId: "0",
  };
  const details = U.buildDetails({ ...U.draftFromCookie(cookie), domain: ".example.com" }, site("example.com"));
  assert.equal(U.isSameCookieIdentity(cookie, details), true);
});

/* ------------------------------------------------------- validation ----- */

test("validateDraft accepts a well-formed cookie", () => {
  const draft = { ...U.blankDraft(site("www.example.com"), "0"), name: "a", value: "v" };
  assert.deepStrictEqual(U.validateDraft(draft, site("www.example.com")), { errors: [], warnings: [] });
});

test("validateDraft requires a name", () => {
  const { errors } = U.validateDraft(U.blankDraft(site("www.example.com"), "0"), site("www.example.com"));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "name");
});

test("validateDraft rejects names and warns about values with , or ;", () => {
  const ctx = site("www.example.com");
  const { errors } = U.validateDraft({ ...U.blankDraft(ctx, "0"), name: "a;b" }, ctx);
  assert.equal(errors[0].field, "name");

  const value = U.validateDraft({ ...U.blankDraft(ctx, "0"), name: "a", value: "x,y" }, ctx);
  assert.equal(value.errors.length, 0);
  assert.match(value.warnings.find((w) => w.field === "value").message, /URL-encoding/);
});

test("validateDraft rejects a domain outside the site", () => {
  const ctx = site("www.example.com");
  const { errors } = U.validateDraft({ ...U.blankDraft(ctx, "0"), name: "a", domain: "evil.com" }, ctx);
  assert.equal(errors[0].field, "domain");
  assert.match(errors[0].message, /www\.example\.com or one of its parent domains/);
});

test("validateDraft flags SameSite=None without Secure", () => {
  const ctx = site("www.example.com");
  const { errors } = U.validateDraft(
    { ...U.blankDraft(ctx, "0"), name: "a", sameSite: "no_restriction", secure: false },
    ctx
  );
  assert.ok(errors.some((e) => e.field === "sameSite"));
});

test("validateDraft flags a partitioned cookie without Secure", () => {
  const ctx = site("www.example.com");
  const { errors } = U.validateDraft(
    { ...U.blankDraft(ctx, "0"), name: "a", secure: false, partitionKey: { topLevelSite: "https://t.example" } },
    ctx
  );
  assert.ok(errors.some((e) => e.field === "partition"));
});

test("validateDraft warns that Secure is useless on an http page", () => {
  const insecure = site("example.com", false);
  const { errors, warnings } = U.validateDraft({ ...U.blankDraft(insecure, "0"), name: "a", secure: true }, insecure);
  assert.equal(errors.length, 0);
  assert.ok(warnings.some((w) => w.field === "secure"));
});

test("validateDraft warns about a path without a leading slash and an expired date", () => {
  const ctx = site("www.example.com");
  const { warnings } = U.validateDraft({ ...U.blankDraft(ctx, "0"), name: "a", path: "app", expirationDate: 1 }, ctx);
  assert.ok(warnings.some((w) => w.field === "path"));
  assert.ok(warnings.some((w) => w.field === "expiry"));
});

test("validateDraft warns about a very long value", () => {
  const ctx = site("www.example.com");
  const { warnings } = U.validateDraft({ ...U.blankDraft(ctx, "0"), name: "a", value: "x".repeat(5000) }, ctx);
  assert.ok(warnings.some((w) => w.field === "value" && /truncated/.test(w.message)));
});

/* ------------------------------------------------------------- lists ---- */

test("sortCookies orders by name then path, case-insensitively", () => {
  const list = [
    { name: "b", path: "/" },
    { name: "A", path: "/z" },
    { name: "a", path: "/a" },
  ];
  assert.deepStrictEqual(
    U.sortCookies(list).map((c) => `${c.name}${c.path}`),
    ["a/a", "A/z", "b/"]
  );
});

test("sortCookies does not mutate its input", () => {
  const list = [
    { name: "b", path: "/" },
    { name: "a", path: "/" },
  ];
  U.sortCookies(list);
  assert.equal(list[0].name, "b");
});

test("matchesFilter requires every term to match somewhere", () => {
  const cookie = { name: "session", value: "abc123", domain: ".example.com", path: "/api" };
  assert.equal(U.matchesFilter(cookie, ""), true);
  assert.equal(U.matchesFilter(cookie, "   "), true);
  assert.equal(U.matchesFilter(cookie, "SESSION"), true);
  assert.equal(U.matchesFilter(cookie, "sess abc"), true, "terms may match different fields");
  assert.equal(U.matchesFilter(cookie, "sess nope"), false);
  assert.equal(U.matchesFilter(cookie, ".example.com /api"), true);
});

test("matchesFilter lets separate terms match separate fields but not span one", () => {
  const cookie = { name: "ab", value: "cd", domain: "example.com", path: "/" };
  // "a" and "c" each match somewhere, so the cookie matches...
  assert.equal(U.matchesFilter(cookie, "a c"), true);
  // ...but a single term may not run across the end of one field into the next.
  assert.equal(U.matchesFilter(cookie, "abc"), false);
});
/* ------------------------------------------------------- import/export --- */

const jar = [
  {
    name: "session",
    value: "abc",
    domain: "www.example.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    session: true,
    storeId: "0",
  },
  {
    name: "wide",
    value: "1",
    domain: ".example.com",
    hostOnly: false,
    path: "/api",
    secure: false,
    sameSite: "strict",
    session: false,
    expirationDate: 1_700_000_000,
    storeId: "0",
  },
];

test("toExportable keeps the attributes that matter and drops the store id", () => {
  assert.deepStrictEqual(U.toExportable(jar[0]), {
    name: "session",
    value: "abc",
    domain: "www.example.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    session: true,
  });
  assert.equal("storeId" in U.toExportable(jar[0]), false);
});

test("toExportable spells out session rather than relying on an absent expiry", () => {
  assert.equal(U.toExportable({ name: "a", value: "1", domain: "example.com", path: "/" }).session, true);
  const dated = U.toExportable({ name: "a", value: "1", domain: "example.com", path: "/", expirationDate: 5 });
  assert.equal("session" in dated, false);
  assert.equal(dated.expirationDate, 5);
});

test("toExportable keeps the partition key", () => {
  const exported = U.toExportable({
    name: "a",
    value: "1",
    domain: "example.com",
    path: "/",
    secure: true,
    partitionKey: { topLevelSite: "https://top.example" },
  });
  assert.deepStrictEqual(exported.partitionKey, { topLevelSite: "https://top.example" });
});

test("toJson produces parseable JSON that round-trips", () => {
  const text = U.toJson(jar);
  assert.deepStrictEqual(JSON.parse(text).length, 2);

  const site = U.parseSite("https://www.example.com/app");
  const parsed = U.parseImport(text, site);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.format, "json");
  assert.deepStrictEqual(
    parsed.entries.map((entry) => entry.draft),
    [
      {
        name: "session",
        value: "abc",
        domain: "www.example.com",
        hostOnly: true,
        path: "/",
        sameSite: "lax",
        secure: true,
        httpOnly: true,
        expirationDate: null,
        partitionKey: null,
        storeId: "0",
      },
      {
        name: "wide",
        value: "1",
        domain: "example.com",
        hostOnly: false,
        path: "/api",
        sameSite: "strict",
        secure: false,
        httpOnly: false,
        expirationDate: 1_700_000_000,
        partitionKey: null,
        storeId: "0",
      },
    ]
  );
});

test("toHeaderString is the Cookie: header form", () => {
  assert.strictEqual(U.toHeaderString(jar), "session=abc; wide=1");
  assert.strictEqual(U.toHeaderString([]), "");
});

test("serializeCookies picks the requested format", () => {
  assert.strictEqual(U.serializeCookies(jar, "header"), "session=abc; wide=1");
  assert.strictEqual(JSON.parse(U.serializeCookies(jar, "json")).length, 2);
  // Anything unknown falls back to the lossless one.
  assert.strictEqual(JSON.parse(U.serializeCookies(jar, "nonsense")).length, 2);
});

test("parseHeaderString splits on the first = and skips junk", () => {
  assert.deepStrictEqual(U.parseHeaderString("a=1; b=has=equals; ; =orphan; c="), [
    { name: "a", value: "1" },
    { name: "b", value: "has=equals" },
    { name: "c", value: "" },
  ]);
});

test("a header string becomes the same cookie 'Add cookie' would have made", () => {
  const site = U.parseSite("https://www.example.com/");
  const parsed = U.parseImport("session=abc; theme=dark", site);
  assert.equal(parsed.format, "header");
  // No attributes come with a header string, so the defaults are the editor's.
  assert.deepStrictEqual(
    parsed.entries.map((entry) => entry.draft),
    [
      { ...U.blankDraft(site, "0"), name: "session", value: "abc" },
      { ...U.blankDraft(site, "0"), name: "theme", value: "dark" },
    ]
  );
});

test("an imported cookie honours explicit attributes over the defaults", () => {
  const site = U.parseSite("https://www.example.com/");
  const draft = U.parseImport(`[{"name":"a","value":"1","secure":false,"sameSite":"strict"}]`, site).entries[0].draft;
  assert.equal(draft.secure, false);
  assert.equal(draft.sameSite, "strict");
});

test("parseImport ignores a leading Cookie: prefix", () => {
  const site = U.parseSite("https://www.example.com/");
  assert.equal(U.parseImport("Cookie: a=1; b=2", site).format, "header");
  assert.equal(U.parseImport("  a=1  ", site).format, "header");
});

test("parseImport accepts the shapes other cookie editors export", () => {
  const site = U.parseSite("https://www.example.com/");
  const expected = "a";

  for (const text of [
    `[{"name":"a","value":"1"}]`,
    `{"cookies":[{"name":"a","value":"1"}]}`,
    `{"name":"a","value":"1"}`,
    `  [ { "name" : "a" } ]  `,
  ]) {
    const parsed = U.parseImport(text, site);
    assert.equal(parsed.format, "json", text);
    assert.equal(parsed.entries[0].draft.name, expected, text);
  }
});

test("parseImport explains what it cannot read", () => {
  const site = U.parseSite("https://www.example.com/");
  assert.match(U.parseImport("", site).error, /nothing to import/);
  assert.match(U.parseImport("   ", site).error, /nothing to import/);
  assert.match(U.parseImport(`[{"name":`, site).error, /not valid JSON/);
  assert.match(U.parseImport("[]", site).error, /empty/);
  assert.match(U.parseImport('{"foo":1}', site).error, /Expected a cookie/);
  assert.match(U.parseImport("no equals sign here", site).error, /name=value/);
});

test("parseImport reports a cookie with no name instead of dropping it", () => {
  const site = U.parseSite("https://www.example.com/");
  const parsed = U.parseImport(`[{"value":"1"}]`, site);
  assert.match(parsed.entries[0].error, /no name/);
});

test("imported cookies take a leading dot as 'and subdomains'", () => {
  const site = U.parseSite("https://www.example.com/");
  assert.equal(U.parseImport(`[{"name":"a","domain":".example.com"}]`, site).entries[0].draft.hostOnly, false);
  assert.equal(U.parseImport(`[{"name":"a","domain":"www.example.com"}]`, site).entries[0].draft.hostOnly, true);
});

test("an explicit hostOnly wins over the leading-dot convention", () => {
  const site = U.parseSite("https://www.example.com/");
  const parsed = U.parseImport(`[{"name":"a","domain":".example.com","hostOnly":true}]`, site);
  assert.equal(parsed.entries[0].draft.hostOnly, true);
});

test("imported SameSite is normalised and forces Secure", () => {
  const site = U.parseSite("https://www.example.com/");
  assert.equal(U.normalizeSameSite("None"), "no_restriction");
  assert.equal(U.normalizeSameSite("LAX"), "lax");
  assert.equal(U.normalizeSameSite("strict"), "strict");
  assert.equal(U.normalizeSameSite(""), "unspecified");
  assert.equal(U.normalizeSameSite(undefined), "unspecified");
  assert.equal(U.normalizeSameSite("nonsense"), "unspecified");

  const draft = U.parseImport(`[{"name":"a","sameSite":"None"}]`, site).entries[0].draft;
  assert.equal(draft.sameSite, "no_restriction");
  assert.equal(draft.secure, true, "SameSite=None implies Secure");
});

test("an imported partition key forces Secure", () => {
  const site = U.parseSite("https://www.example.com/");
  const draft = U.parseImport(`[{"name":"a","partitionKey":{"topLevelSite":"https://top.example"}}]`, site).entries[0]
    .draft;
  assert.deepStrictEqual(draft.partitionKey, { topLevelSite: "https://top.example" });
  assert.equal(draft.secure, true);
});

test("toUnixSeconds accepts both seconds and milliseconds", () => {
  assert.equal(U.toUnixSeconds(1_700_000_000), 1_700_000_000);
  assert.equal(U.toUnixSeconds(1_700_000_000_000), 1_700_000_000);
  assert.equal(U.toUnixSeconds("1700000000"), 1_700_000_000);
  assert.equal(U.toUnixSeconds(0), null);
  assert.equal(U.toUnixSeconds(-1), null);
  assert.equal(U.toUnixSeconds("soon"), null);
});

test("an imported path is repaired the same way as an edited one", () => {
  const site = U.parseSite("https://www.example.com/");
  assert.equal(U.parseImport(`[{"name":"a","path":"api"}]`, site).entries[0].draft.path, "/api");
  assert.equal(U.parseImport(`[{"name":"a"}]`, site).entries[0].draft.path, "/");
});

test("imported cookies validate against the site like any other", () => {
  const site = U.parseSite("https://www.example.com/");
  const draft = U.parseImport(`[{"name":"a","domain":"evil.com"}]`, site).entries[0].draft;
  const { errors } = U.validateDraft(draft, site);
  assert.ok(errors.some((error) => error.field === "domain"));
});

test("cookiesMissingFrom compares drafts with stored cookies", () => {
  const stored = jar;
  const site = U.parseSite("https://www.example.com/app");
  const drafts = U.parseImport(U.toJson(stored), site).entries.map((entry) => entry.draft);

  assert.deepStrictEqual(U.cookiesMissingFrom(drafts, stored), [], "nothing is left over after a full import");

  const extra = { ...stored[0], name: "stray" };
  assert.deepStrictEqual(
    U.cookiesMissingFrom(drafts, [...stored, extra]).map((cookie) => cookie.name),
    ["stray"]
  );
});

test("cookiesMissingFrom does not confuse a host-only cookie with a domain cookie", () => {
  const hostOnly = { name: "a", value: "1", domain: "www.example.com", path: "/", hostOnly: true, storeId: "0" };
  const domainWide = { ...hostOnly, hostOnly: false };
  // The browser stores these as two separate cookies, so importing one has to
  // leave the other behind rather than treat it as already imported.
  assert.deepStrictEqual(
    U.cookiesMissingFrom([domainWide], [hostOnly]).map((c) => c.name),
    ["a"]
  );
  assert.deepStrictEqual(
    U.cookiesMissingFrom([hostOnly], [domainWide]).map((c) => c.name),
    ["a"]
  );
  assert.deepStrictEqual(U.cookiesMissingFrom([hostOnly], [hostOnly]), []);
});

test("cookieKey tells a host-only cookie from a domain cookie on the same host", () => {
  const hostOnly = { name: "a", value: "1", domain: "www.example.com", path: "/", hostOnly: true, storeId: "0" };
  assert.notEqual(U.cookieKey(hostOnly), U.cookieKey({ ...hostOnly, hostOnly: false }));
  // A missing hostOnly means host-only, and the dotted spelling is the same domain.
  assert.equal(U.cookieKey(hostOnly), U.cookieKey({ ...hostOnly, hostOnly: undefined, domain: ".www.example.com" }));
});

test("toExportable rounds the fractional expiration browsers report", () => {
  const exported = U.toExportable({
    name: "a",
    value: "1",
    domain: "example.com",
    path: "/",
    expirationDate: 1_791_276_133.056,
  });
  assert.strictEqual(exported.expirationDate, 1_791_276_133);
  assert.equal(Number.isInteger(exported.expirationDate), true);
  assert.equal("session" in exported, false);
});
