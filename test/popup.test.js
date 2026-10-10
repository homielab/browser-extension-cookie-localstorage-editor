/**
 * DOM-level tests for the popup: rendered in jsdom against a mock cookies API
 * that follows the real store's rules (suffix matching, path scoping, Secure
 * scheme, public suffixes, and the reject-then-restore dance on replace).
 *
 *   npm install jsdom && node --test test/
 *
 * The pure cookie logic is covered by cookies.test.js, which needs no
 * dependencies; these DOM tests need jsdom (`npm install`).
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// POPUP_DIR points the suite at a build instead (see `npm run test:dist`).
const POPUP_DIR = process.env.POPUP_DIR
  ? path.resolve(process.env.POPUP_DIR)
  : path.join(__dirname, "..", "src", "popup");
const PUBLIC_SUFFIXES = new Set(["com", "net", "org", "co.uk", "github.io"]);

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch (_) {
  JSDOM = null;
}

/* ------------------------------------------------------------- mock API -- */

function makeStore() {
  const byKey = new Map();
  const keyOf = (c) =>
    [c.name, c.domain, c.path, c.storeId, c.partitionKey ? c.partitionKey.topLevelSite : ""].join("\u0000");

  function pathMatches(cookiePath, urlPath) {
    if (urlPath === cookiePath) return true;
    if (!urlPath.startsWith(cookiePath)) return false;
    return cookiePath.endsWith("/") || urlPath[cookiePath.length] === "/";
  }

  const store = {
    all: () => Array.from(byKey.values()),
    getAll({ url }) {
      const u = new URL(url);
      return Array.from(byKey.values()).filter((c) => {
        const domain = c.domain.replace(/^\./, "");
        const inScope = c.hostOnly ? domain === u.hostname : u.hostname === domain || u.hostname.endsWith("." + domain);
        if (!inScope) return false;
        if (c.secure && u.protocol !== "https:") return false;
        if (!pathMatches(c.path, u.pathname)) return false;
        return c.session || c.expirationDate * 1000 > Date.now();
      });
    },
    set(details) {
      const name = details.name;
      const value = details.value;
      if (/[;,]/.test(name)) throw new Error("Failed to set cookie: invalid cookie name.");
      if (/[;,]/.test(value)) throw new Error("Failed to set cookie: invalid cookie value.");
      if (details.sameSite === "no_restriction" && !details.secure) {
        throw new Error("Failed to set cookie: 'SameSite=None' requires Secure.");
      }

      const u = new URL(details.url);
      const hostOnly = details.domain === undefined;
      const domain = hostOnly ? u.hostname : details.domain.replace(/^\./, "");

      if (domain !== u.hostname && !u.hostname.endsWith("." + domain)) {
        throw new Error("Failed to set cookie: domain is not a suffix of the url.");
      }
      if (!hostOnly && PUBLIC_SUFFIXES.has(domain)) {
        throw new Error(`Failed to set cookie: "${domain}" is a public suffix.`);
      }

      const cookie = {
        name,
        value,
        domain,
        hostOnly,
        path: details.path,
        secure: !!details.secure,
        httpOnly: !!details.httpOnly,
        sameSite: details.sameSite,
        session: !details.expirationDate,
        storeId: details.storeId || "0",
      };
      if (details.expirationDate) cookie.expirationDate = details.expirationDate;
      if (details.partitionKey) cookie.partitionKey = { topLevelSite: details.partitionKey.topLevelSite };
      byKey.set(keyOf(cookie), cookie);
      return cookie;
    },
    remove({ url, name, storeId, partitionKey }) {
      const u = new URL(url);
      const matches = Array.from(byKey.values()).filter(
        (c) =>
          c.name === name &&
          (storeId === undefined || c.storeId === storeId) &&
          c.path === u.pathname &&
          (partitionKey ? c.partitionKey && c.partitionKey.topLevelSite === partitionKey.topLevelSite : !c.partitionKey)
      );
      const cookie = matches.find((c) => c.domain === u.hostname) || matches[0];
      if (!cookie) return null;
      byKey.delete(keyOf(cookie));
      return cookie;
    },
    raw: byKey,
  };
  return store;
}

/**
 * The page in the tab, as far as the storage tab can see it: its origin and a
 * localStorage that keeps insertion order, like the real one. `quota` caps
 * the stored characters to exercise the quota error.
 */
function makePage(url, items, quota) {
  const map = new Map(Object.entries(items || {}));
  const used = () => Array.from(map).reduce((sum, [k, v]) => sum + k.length + v.length, 0);
  const storage = {
    get length() {
      return map.size;
    },
    key: (i) => Array.from(map.keys())[i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem(k, v) {
      const before = map.get(String(k));
      map.set(String(k), String(v));
      if (quota && used() > quota) {
        if (before === undefined) map.delete(String(k));
        else map.set(String(k), before);
        const error = new Error("The quota has been exceeded.");
        error.name = "QuotaExceededError";
        throw error;
      }
    },
    removeItem: (k) => map.delete(String(k)),
    clear: () => map.clear(),
  };
  return { storage, location: { origin: new URL(url).origin }, items: () => Object.fromEntries(map) };
}

/** A stand-in for a real event, which exposes add/removeListener. */
function makeEvent() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const index = listeners.indexOf(fn);
      if (index >= 0) listeners.splice(index, 1);
    },
    emit: (...args) => listeners.slice().forEach((fn) => fn(...args)),
    size: () => listeners.length,
  };
}

function boot(options) {
  const settings = options || {};
  const store = settings.store || makeStore();
  const tab = settings.tab || { id: 1, url: "https://www.example.com/app", incognito: false };
  if (!settings.page) settings.page = makePage(tab.url || "https://www.example.com/");

  const html = fs
    .readFileSync(path.join(POPUP_DIR, "popup.html"), "utf8")
    .replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
      const code = fs.readFileSync(path.join(POPUP_DIR, src), "utf8");
      return `<script>${code}</script>`;
    });

  const dom = new JSDOM(html, {
    url: tab.url,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.browser = undefined;
      // Pages close themselves when done; record it, and keep the real
      // close for tearing the test window down.
      window.dispose = window.close.bind(window);
      window.close = () => {
        window.closed_ = true;
      };
      window.chrome = makeChrome(window, settings, store, tab);
      // The tab a previous popup was left on.
      if (settings.savedView) window.localStorage.setItem("cookie-editor.view", settings.savedView);
    },
  });

  const events = { tabs: dom.window.chrome.tabs };
  return { dom, window: dom.window, doc: dom.window.document, store, tab, events, page: settings.page };
}

/** The extension APIs as the popup and the access window see them. */
function makeChrome(window, settings, store, tab) {
  return {
    tabs: {
      query: async () => [settings.tabResolver ? settings.tabResolver() : tab],
      create: async (props) => {
        window.chrome.opened.push({ kind: "tab", ...props });
        return { id: 99 };
      },
      update: async (tabId, props) => {
        window.chrome.returnedTo.push({ tabId, ...props });
        return { id: tabId };
      },
      // Real events live as properties on the namespace and are the only
      // members that may carry addListener.
      onActivated: makeEvent(),
      onUpdated: makeEvent(),
    },
    windows: {
      create: async (props) => {
        window.chrome.opened.push({ kind: "window", ...props });
        return { id: 77 };
      },
      update: async (windowId, props) => {
        window.chrome.returnedTo.push({ windowId, ...props });
        return { id: windowId };
      },
    },
    action: {
      openPopup: async (options) => {
        if (settings.noOpenPopup) throw new Error("openPopup is not available");
        window.chrome.reopened.push(options);
      },
    },
    // What the page asked the browser to open, focus and reopen.
    opened: [],
    returnedTo: [],
    reopened: [],
    runtime: { getURL: (rel) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${rel}` },
    // Host access is granted unless a test says otherwise; `request`
    // grants it the way the user clicking "Allow" would.
    permissions: {
      granted: settings.granted === undefined ? true : settings.granted,
      requests: [],
      async contains() {
        return this.granted;
      },
      async request({ origins }) {
        this.requests.push(origins);
        if (settings.deny) return false;
        this.granted = true;
        return true;
      },
      onAdded: makeEvent(),
      onRemoved: makeEvent(),
    },
    // Runs the injected function against the mock page, with the page's
    // globals in place of the test window's.
    scripting: {
      calls: [],
      async executeScript({ target, func, args }) {
        window.chrome.scripting.calls.push({ tabId: target.tabId, args });
        if (settings.noScripting) throw new Error("Cannot access contents of the page.");
        const page = settings.page;
        const run = new Function("localStorage", "location", "args", `return (${func.toString()}).apply(null, args);`);
        return [{ result: run(page.storage, page.location, args || []) }];
      },
    },
    cookies: {
      getAll: (q) => store.getAll(q),
      set: (d) => store.set(d),
      remove: (o) => store.remove(o),
      getAllCookieStores: async () => settings.stores || [{ id: "0", tabIds: [tab.id], incognito: false }],
    },
  };
}

/** The access window, opened with `query` (as the popup builds it). */
function bootAccess(options) {
  const settings = options || {};
  const pageDir = path.join(POPUP_DIR, "..", "access");
  const html = fs
    .readFileSync(path.join(pageDir, "access.html"), "utf8")
    .replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
      const code = fs.readFileSync(path.join(pageDir, src), "utf8");
      return `<script>${code}</script>`;
    });
  const tab = { id: 1, windowId: 5, url: "https://www.example.com/", incognito: false };
  const dom = new JSDOM(html, {
    url: `chrome-extension://abcdefghijklmnopabcdefghijklmnop/access/access.html?${settings.query}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.browser = undefined;
      // Pages close themselves when done; record it, and keep the real
      // close for tearing the test window down.
      window.dispose = window.close.bind(window);
      window.close = () => {
        window.closed_ = true;
      };
      window.chrome = makeChrome(window, settings, makeStore(), tab);
    },
  });
  return { window: dom.window, doc: dom.window.document };
}

/* --------------------------------------------------------------- helpers -- */

const flush = (win, times) => {
  let chain = Promise.resolve();
  for (let i = 0; i < (times || 8); i++) chain = chain.then(() => new Promise((r) => win.setTimeout(r, 0)));
  return chain;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tab events are debounced, so let the real clock pass before flushing. */
const settle = async (win, times) => {
  await new Promise((resolve) => setTimeout(resolve, 200));
  await flush(win, times || 8);
};

const $ = (doc, sel) => doc.querySelector(sel);
const $$ = (doc, sel) => Array.from(doc.querySelectorAll(sel));

function click(doc, node) {
  node.dispatchEvent(new doc.defaultView.MouseEvent("click", { bubbles: true }));
}

function setField(doc, node, value) {
  node.value = value;
  const view = doc.defaultView;
  node.dispatchEvent(new view.Event("input", { bubbles: true }));
  node.dispatchEvent(new view.Event("change", { bubbles: true }));
}

function setCheckbox(doc, node, checked) {
  node.checked = checked;
  const view = doc.defaultView;
  node.dispatchEvent(new view.Event("input", { bubbles: true }));
  node.dispatchEvent(new view.Event("change", { bubbles: true }));
}

function submitEditor(doc) {
  const form = $(doc, ".editor");
  form.dispatchEvent(new doc.defaultView.Event("submit", { bubbles: true, cancelable: true }));
  return form;
}

const rowsOf = (doc) => $$(doc, "#list .item").filter((item) => item.querySelector(".row"));
const rowNamed = (doc, name) => rowsOf(doc).find((item) => item.querySelector(".row-name").textContent === name);
const names = (doc) => rowsOf(doc).map((item) => item.querySelector(".row-name").textContent);
const field = (doc, name) => $(doc, `.editor [data-field="${name}"]`);

async function start(options) {
  const ctx = boot(options);
  await flush(ctx.window);
  return ctx;
}

/* ----------------------------------------------------------------- tests -- */

const maybe = JSDOM ? test : test.skip;

maybe("lists the cookies of the active tab, sorted by name", async () => {
  const store = makeStore();
  const base = { storeId: "0", sameSite: "lax" };
  store.set({ ...base, url: "https://www.example.com/", name: "zebra", value: "z", path: "/" });
  store.set({ ...base, url: "https://www.example.com/", name: "apple", value: "a", path: "/" });
  store.set({ ...base, url: "https://www.example.com/", name: "middle", value: "m", path: "/", domain: "example.com" });

  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });
  assert.strictEqual($(doc, "#host").textContent, "www.example.com");
  assert.deepStrictEqual(names(doc), ["apple", "middle", "zebra"]);
  assert.strictEqual($(doc, "#counts").textContent, "3 cookies");
  window.dispose();
});

maybe("only lists cookies that would actually reach the page", async () => {
  const store = makeStore();
  const base = { storeId: "0", sameSite: "lax" };
  store.set({ ...base, url: "https://www.example.com/", name: "for-other-path", value: "1", path: "/admin" });
  store.set({ ...base, url: "https://www.example.com/", name: "plain-cookie", value: "1", path: "/app" });

  const { doc, window } = await start({
    store,
    tab: { id: 1, url: "https://www.example.com/app/page", incognito: false },
  });
  assert.deepStrictEqual(names(doc), ["plain-cookie"]);
  window.dispose();
});

maybe("shows the attributes of a cookie", async () => {
  const store = makeStore();
  store.set({
    url: "https://www.example.com/",
    name: "sid",
    value: "abc",
    path: "/",
    storeId: "0",
    secure: true,
    httpOnly: true,
    sameSite: "strict",
    domain: "example.com",
  });

  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });
  const row = rowNamed(doc, "sid");
  const badges = Array.from(row.querySelectorAll(".badge"), (badge) => badge.textContent);
  assert.deepStrictEqual(badges, ["HttpOnly", "Secure", "Strict"]);
  assert.strictEqual(row.querySelector(".row-domain").textContent, ".example.com");
  assert.match(row.querySelector(".row-domain").title, /also sent to subdomains/);
  assert.strictEqual(row.querySelector(".row-value").textContent, "abc");
  assert.strictEqual(row.querySelector(".row-expiry").textContent, "Session");
  window.dispose();
});

maybe("filters on name, value and domain, and every term must match", async () => {
  const store = makeStore();
  const base = { storeId: "0", sameSite: "lax" };
  store.set({ ...base, url: "https://www.example.com/", name: "session", value: "abc123", path: "/" });
  store.set({
    ...base,
    url: "https://www.example.com/",
    name: "theme",
    value: "dark",
    path: "/",
    domain: "example.com",
  });

  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  const filter = $(doc, "#filter");
  const visible = () =>
    rowsOf(doc)
      .filter((row) => !row.hidden)
      .map((r) => r.querySelector(".row-name").textContent);

  setField(doc, filter, "sess");
  await flush(window, 2);
  assert.deepStrictEqual(visible(), ["session"]);

  setField(doc, filter, "dark");
  await flush(window, 2);
  assert.deepStrictEqual(visible(), ["theme"]);

  setField(doc, filter, "theme example.com");
  await flush(window, 2);
  assert.deepStrictEqual(visible(), ["theme"], "terms may match different fields");

  setField(doc, filter, "theme nope");
  await flush(window, 2);
  assert.deepStrictEqual(visible(), []);
  assert.strictEqual($(doc, "#counts").textContent, "0 of 2 cookies");
  assert.strictEqual($(doc, "#no-matches").hidden, false);

  // Escape clears the filter.
  $(doc, "#filter").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await flush(window, 2);
  assert.strictEqual($(doc, "#filter").value, "");
  assert.strictEqual(visible().length, 2);
  window.dispose();
});

maybe("edits an existing cookie", async () => {
  const store = makeStore();
  store.set({
    url: "https://www.example.com/",
    name: "theme",
    value: "dark",
    path: "/",
    storeId: "0",
    sameSite: "lax",
  });

  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, rowNamed(doc, "theme").querySelector(".row"));
  await flush(window, 2);

  assert.strictEqual($(doc, ".editor-title").textContent, "Edit cookie");
  assert.strictEqual(field(doc, "name").value, "theme");
  assert.strictEqual(field(doc, "value").value, "dark");
  assert.strictEqual(field(doc, "domain").disabled, true, "host-only cookies take the domain from the URL");

  setField(doc, field(doc, "value"), "light");
  setField(doc, field(doc, "expiry"), "7d");
  submitEditor(doc);
  await flush(window, 8);

  const saved = store.all().find((c) => c.name === "theme");
  assert.strictEqual(saved.value, "light");
  assert.strictEqual(saved.session, false);
  assert.ok(Math.abs(saved.expirationDate - (Date.now() / 1000 + 7 * 86400)) < 5);
  assert.strictEqual($(doc, ".editor"), null, "the editor closes after saving");
  assert.strictEqual($(doc, "#notice").className, "notice ok");
  window.dispose();
});

maybe("replacing a cookie does not leave the old one behind", async () => {
  const store = makeStore();
  store.set({ url: "https://www.example.com/", name: "old", value: "1", path: "/", storeId: "0", sameSite: "lax" });

  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });
  const before = store.all().length;

  click(doc, rowNamed(doc, "old").querySelector(".row"));
  await flush(window, 2);
  setField(doc, field(doc, "name"), "new");
  submitEditor(doc);
  await flush(window, 8);

  assert.strictEqual(store.all().length, before, "no duplicate was created");
  assert.strictEqual(store.all()[0].name, "new");
  window.dispose();
});

maybe("restores the original cookie when the replacement is rejected", async () => {
  const store = makeStore();
  store.set({
    url: "https://www.example.com/",
    name: "keepme",
    value: "original",
    path: "/",
    storeId: "0",
    sameSite: "lax",
  });

  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, rowNamed(doc, "keepme").querySelector(".row"));
  await flush(window, 2);
  // A new path makes this a different cookie, so the original is removed first.
  setField(doc, field(doc, "path"), "/moved");
  // A comma in the value passes our own validation (it is only a warning) but
  // the browser rejects it, which is what exercises the restore path.
  setField(doc, field(doc, "value"), "a,b");
  submitEditor(doc);
  await flush(window, 8);

  assert.strictEqual(store.all().length, 1, "the original was put back");
  assert.strictEqual(store.all()[0].name, "keepme");
  assert.strictEqual(store.all()[0].value, "original");
  assert.strictEqual(store.all()[0].path, "/");
  assert.strictEqual($(doc, "#notice").className, "notice error");
  window.dispose();
});

maybe("turns a host-only cookie into a domain cookie on a parent domain", async () => {
  const store = makeStore();
  store.set({ url: "https://www.example.com/", name: "ho", value: "1", path: "/", storeId: "0", sameSite: "lax" });

  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, rowNamed(doc, "ho").querySelector(".row"));
  await flush(window, 2);
  setCheckbox(doc, field(doc, "subdomains"), true);
  assert.strictEqual(field(doc, "domain").disabled, false);
  setField(doc, field(doc, "domain"), "example.com");
  submitEditor(doc);
  await flush(window, 8);

  assert.strictEqual(store.all().length, 1, "still exactly one cookie, not a pair");
  assert.strictEqual(store.all()[0].hostOnly, false);
  assert.strictEqual(store.all()[0].domain, "example.com");
  window.dispose();
});

maybe("applying to subdomains keeps the domain that is in the field", async () => {
  const store = makeStore();
  store.set({ url: "https://www.example.com/", name: "ho", value: "1", path: "/", storeId: "0", sameSite: "lax" });

  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, rowNamed(doc, "ho").querySelector(".row"));
  await flush(window, 2);
  // Toggling the switch changes how the domain applies, not which domain it is,
  // so the value in the field is carried over.
  setCheckbox(doc, field(doc, "subdomains"), true);
  assert.strictEqual(field(doc, "domain").value, "www.example.com");
  submitEditor(doc);
  await flush(window, 8);

  assert.strictEqual(store.all()[0].hostOnly, false);
  assert.strictEqual(store.all()[0].domain, "www.example.com");
  window.dispose();
});

maybe("creates a cookie from scratch", async () => {
  const store = makeStore();
  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, $(doc, "#add"));
  await flush(window, 2);

  assert.strictEqual($(doc, ".editor-title").textContent, "New cookie");
  assert.strictEqual(field(doc, "name").value, "");
  assert.strictEqual(field(doc, "domain").value, "www.example.com");
  assert.strictEqual(field(doc, "secure").checked, true, "defaults to matching the page");
  assert.strictEqual($(doc, '.editor [data-act="delete"]').hidden, true);

  setField(doc, field(doc, "name"), "feature");
  setField(doc, field(doc, "value"), "on");
  submitEditor(doc);
  await flush(window, 8);

  assert.strictEqual(store.all().length, 1);
  assert.strictEqual(store.all()[0].name, "feature");
  assert.strictEqual(store.all()[0].hostOnly, true);
  window.dispose();
});

maybe("does not mark Secure on a plain-http page", async () => {
  const store = makeStore();
  const { doc, window } = await start({ store, tab: { id: 1, url: "http://localhost:3000/", incognito: false } });

  assert.strictEqual($(doc, "#host").textContent, "localhost");
  assert.strictEqual($(doc, "#host-sub").textContent, "HTTP (insecure)");
  click(doc, $(doc, "#add"));
  await flush(window, 2);
  assert.strictEqual(field(doc, "secure").checked, false);
  window.dispose();
});

maybe("warns that a Secure cookie will not reach an http page", async () => {
  const store = makeStore();
  const { doc, window } = await start({ store, tab: { id: 1, url: "http://insecure.example.org/", incognito: false } });

  click(doc, $(doc, "#add"));
  await flush(window, 2);
  setField(doc, field(doc, "name"), "sec");
  setCheckbox(doc, field(doc, "secure"), true);
  // A value the browser rejects keeps the editor open, so the warning stays
  // visible for inspection.
  setField(doc, field(doc, "value"), "a,b");
  submitEditor(doc);
  await flush(window, 4);

  const warning = $(doc, '[data-msg="secure"]');
  assert.strictEqual(warning.className, "msg show warn", "a warning, not an error");
  assert.match(warning.textContent, /insecure\.example\.org/);
  assert.strictEqual($(doc, '[data-msg="secure"]').closest(".field").classList.contains("invalid"), false);

  // Fix the value: the warning alone must not block the save.
  setField(doc, field(doc, "value"), "fine");
  submitEditor(doc);
  await flush(window, 8);
  assert.strictEqual(store.all().length, 1);
  assert.strictEqual(store.all()[0].secure, true);
  assert.strictEqual(store.all()[0].name, "sec");
  window.dispose();
});

maybe("turns on Secure for SameSite=None and for partitioned cookies", async () => {
  const store = makeStore();
  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, $(doc, "#add"));
  await flush(window, 2);

  setCheckbox(doc, field(doc, "secure"), false);
  setField(doc, field(doc, "sameSite"), "no_restriction");
  assert.strictEqual(field(doc, "secure").checked, true, "SameSite=None implies Secure");

  setCheckbox(doc, field(doc, "secure"), false);
  setCheckbox(doc, field(doc, "partition"), true);
  assert.strictEqual(field(doc, "secure").checked, true, "partitioned implies Secure");
  window.dispose();
});

maybe("creates a partitioned cookie", async () => {
  const store = makeStore();
  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, $(doc, "#add"));
  await flush(window, 2);
  assert.strictEqual($(doc, "[data-partition]").hidden, true);

  setField(doc, field(doc, "name"), "chunk");
  setCheckbox(doc, field(doc, "partition"), true);
  assert.strictEqual($(doc, "[data-partition]").hidden, false);
  assert.strictEqual(field(doc, "partitionSite").value, "https://www.example.com");

  submitEditor(doc);
  await flush(window, 8);
  assert.strictEqual(store.all()[0].partitionKey.topLevelSite, "https://www.example.com");
  window.dispose();
});

maybe("rejects an invalid domain before calling the browser", async () => {
  const store = makeStore();
  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, $(doc, "#add"));
  await flush(window, 2);
  setField(doc, field(doc, "name"), "bad");
  setCheckbox(doc, field(doc, "subdomains"), true);
  setField(doc, field(doc, "domain"), "evil.com");
  submitEditor(doc);
  await flush(window, 4);

  assert.match($(doc, '[data-msg="domain"]').textContent, /www\.example\.com or one of its parent domains/);
  assert.strictEqual(store.all().length, 0);
  assert.ok($(doc, '[data-msg="domain"]').closest(".field").classList.contains("invalid"));
  window.dispose();
});

maybe("reports a browser rejection as a notice", async () => {
  const store = makeStore();
  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, $(doc, "#add"));
  await flush(window, 2);
  setField(doc, field(doc, "name"), "csv");
  setField(doc, field(doc, "value"), "a,b");
  submitEditor(doc);
  await flush(window, 6);

  assert.match($(doc, '[data-msg="value"]').textContent, /URL-encoding/, "warned up front");
  assert.strictEqual($(doc, "#notice").className, "notice error", "the browser's error is shown");
  assert.strictEqual(store.all().length, 0);
  window.dispose();
});

maybe("requires a name", async () => {
  const store = makeStore();
  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, $(doc, "#add"));
  await flush(window, 2);
  submitEditor(doc);
  await flush(window, 3);

  assert.strictEqual($(doc, '[data-msg="name"]').textContent, "Give the cookie a name.");
  assert.strictEqual(store.all().length, 0);
  window.dispose();
});

maybe("duplicates a cookie", async () => {
  const store = makeStore();
  store.set({
    url: "https://www.example.com/",
    name: "theme",
    value: "dark",
    path: "/",
    storeId: "0",
    sameSite: "lax",
  });

  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, rowNamed(doc, "theme").querySelector('[data-act="edit"]'));
  await flush(window, 2);
  click(doc, $(doc, '.editor [data-act="duplicate"]'));
  await flush(window, 2);

  assert.strictEqual(field(doc, "name").value, "theme-copy");
  assert.strictEqual(field(doc, "value").value, "dark");
  submitEditor(doc);
  await flush(window, 8);

  assert.deepStrictEqual(names(doc), ["theme", "theme-copy"]);
  window.dispose();
});

maybe("deletes a single cookie after confirmation", async () => {
  const store = makeStore();
  const base = { storeId: "0", sameSite: "lax" };
  store.set({ ...base, url: "https://www.example.com/", name: "keep", value: "1", path: "/" });
  store.set({ ...base, url: "https://www.example.com/", name: "drop", value: "1", path: "/" });

  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, rowNamed(doc, "drop").querySelector('[data-act="delete"]'));
  await flush(window, 2);
  assert.strictEqual($(doc, "#confirm").hidden, false);
  assert.match($(doc, "#confirm-text").textContent, /drop/);

  click(doc, $(doc, "#confirm-ok"));
  await flush(window, 8);

  assert.deepStrictEqual(names(doc), ["keep"]);
  assert.strictEqual($(doc, "#confirm").hidden, true);
  window.dispose();
});

maybe("deletes all cookies after confirmation, and cancel does nothing", async () => {
  const store = makeStore();
  const base = { storeId: "0", sameSite: "lax" };
  store.set({ ...base, url: "https://www.example.com/", name: "a", value: "1", path: "/" });
  store.set({ ...base, url: "https://www.example.com/", name: "b", value: "1", path: "/" });
  store.set({ ...base, url: "https://www.example.com/", name: "c", value: "1", path: "/" });

  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, $(doc, "#delete-all"));
  await flush(window, 2);
  assert.match($(doc, "#confirm-text").textContent, /all 3 cookies for www\.example\.com/);

  click(doc, $(doc, "#confirm-cancel"));
  await flush(window, 2);
  assert.strictEqual(store.all().length, 3, "cancel changes nothing");

  click(doc, $(doc, "#delete-all"));
  await flush(window, 2);
  click(doc, $(doc, "#confirm-ok"));
  await flush(window, 10);

  assert.strictEqual(store.all().length, 0);
  assert.strictEqual(rowsOf(doc).length, 0);
  assert.match($(doc, "#list").textContent, /No cookies yet/);
  window.dispose();
});

maybe("creates cookies in the private-window store", async () => {
  const store = makeStore();
  const { doc, window } = await start({
    store,
    tab: { id: 5, url: "https://private.example.com/", incognito: true },
    stores: [
      { id: "0", tabIds: [99], incognito: false },
      { id: "firefox-private", tabIds: [5], incognito: true },
    ],
  });

  assert.match($(doc, "#host-sub").textContent, /private window/);
  click(doc, $(doc, "#add"));
  await flush(window, 2);
  setField(doc, field(doc, "name"), "priv");
  submitEditor(doc);
  await flush(window, 8);

  assert.strictEqual(store.all()[0].storeId, "firefox-private");
  window.dispose();
});

maybe("explains pages that cannot have cookies", async () => {
  const { doc, window } = await start({ tab: { id: 1, url: "chrome://settings/", incognito: false } });
  assert.match($(doc, "#list").textContent, /can’t have cookies/);
  assert.strictEqual(rowsOf(doc).length, 0);
  assert.ok($(doc, "body").classList.contains("blocked"));
  assert.strictEqual($(doc, "#add").disabled, true);
  assert.strictEqual($(doc, "#delete-all").disabled, true);
  window.dispose();
});

maybe("re-enables the controls once the tab is back on a web page", async () => {
  const store = makeStore();
  store.set({ url: "https://back.example.com/", name: "a", value: "1", path: "/", storeId: "0", sameSite: "lax" });

  let tab = { id: 1, url: "chrome://settings/", incognito: false };
  const { doc, window } = await start({
    store,
    tabResolver: () => tab,
    tab,
  });
  assert.strictEqual($(doc, "#add").disabled, true);

  tab = { id: 1, url: "https://back.example.com/", incognito: false };
  click(doc, $(doc, "#refresh"));
  await flush(window, 8);

  assert.ok(!$(doc, "body").classList.contains("blocked"));
  assert.strictEqual($(doc, "#add").disabled, false);
  assert.strictEqual($(doc, "#delete-all").disabled, false);
  assert.strictEqual($(doc, "#host").textContent, "back.example.com");
  assert.deepStrictEqual(names(doc), ["a"]);
  window.dispose();
});

maybe("opens the editor for the row under the keyboard", async () => {
  const store = makeStore();
  store.set({
    url: "https://www.example.com/",
    name: "theme",
    value: "dark",
    path: "/",
    storeId: "0",
    sameSite: "lax",
  });

  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  const row = rowNamed(doc, "theme").querySelector(".row");
  row.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush(window, 2);
  assert.ok($(doc, ".editor"));
  window.dispose();
});

maybe("closing and reopening the editor keeps the list intact", async () => {
  const store = makeStore();
  const base = { storeId: "0", sameSite: "lax" };
  store.set({ ...base, url: "https://www.example.com/", name: "a", value: "1", path: "/" });
  store.set({ ...base, url: "https://www.example.com/", name: "b", value: "1", path: "/" });

  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, rowNamed(doc, "a").querySelector(".row"));
  await flush(window, 2);
  assert.ok($(doc, ".editor"));

  $(doc, "#list").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await flush(window, 2);
  assert.strictEqual($(doc, ".editor"), null);
  assert.deepStrictEqual(names(doc), ["a", "b"]);
  window.dispose();
});

maybe("shows a notice after copying a value", async () => {
  const store = makeStore();
  store.set({
    url: "https://www.example.com/",
    name: "sid",
    value: "copied-value",
    path: "/",
    storeId: "0",
    sameSite: "lax",
  });

  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  const copied = [];
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => copied.push(text) },
  });

  click(doc, rowNamed(doc, "sid").querySelector('[data-act="copy"]'));
  await flush(window, 3);
  assert.deepStrictEqual(copied, ["copied-value"]);
  assert.match($(doc, "#notice").textContent, /Copied/);
  window.dispose();
});
maybe("never treats its own popup page as the active tab", async () => {
  const store = makeStore();
  store.set({ url: "https://real.example.com/", name: "a", value: "1", path: "/", storeId: "0", sameSite: "lax" });

  const selfUrl = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html";
  const real = { id: 1, url: "https://real.example.com/", incognito: false };
  const self = { id: 2, url: selfUrl, incognito: false };
  const { doc, window } = await start({ store, tab: real });

  // Model what a real popup sees: its own page is the active tab of its own
  // window, while the page the user clicked on is in the focused window.
  window.chrome.tabs.query = async (query) => (query.currentWindow ? [self] : [real]);

  click(doc, $(doc, "#refresh"));
  await settle(window, 4);

  assert.strictEqual($(doc, "#host").textContent, "real.example.com");
  assert.ok(!$(doc, "body").classList.contains("blocked"), "not blocked on the real page");
  assert.deepStrictEqual(names(doc), ["a"]);
  window.dispose();
});

maybe("reports its own page as unusable when there is nothing else", async () => {
  const selfUrl = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html";
  const self = { id: 2, url: selfUrl, incognito: false };
  const { doc, window } = await start({ tab: { id: 1, url: "https://real.example.com/", incognito: false } });

  window.chrome.tabs.query = async () => [self];
  click(doc, $(doc, "#refresh"));

  // activeTab() spends its retries before falling back, so poll for the result.
  for (let i = 0; i < 60 && !/can.t have cookies/.test(doc.querySelector("#list").textContent); i++) await sleep(20);
  assert.match($(doc, "#list").textContent, /can’t have cookies/);
  window.dispose();
});

maybe("retries while the active tab has not committed a URL", async () => {
  const store = makeStore();
  store.set({ url: "https://slow.example.com/", name: "a", value: "1", path: "/", storeId: "0", sameSite: "lax" });

  let tab = { id: 1, url: undefined, incognito: false };
  const { doc, window } = await start({
    store,
    tabResolver: () => tab,
    tab,
  });
  // activeTab() retries for ~300ms before giving up, so wait it out.
  for (let i = 0; i < 40 && !/no address yet/.test(doc.querySelector("#list").textContent); i++) await sleep(20);

  // While the URL is missing the popup says so rather than claiming the page
  // cannot have cookies.
  assert.match($(doc, "#list").textContent, /no address yet/);

  tab = { id: 1, url: "https://slow.example.com/", incognito: false };

  // The first query of each refresh still sees no committed URL; the retry
  // inside activeTab() is what recovers.
  let unresolvedOnce = true;
  window.chrome.tabs.query = async () => {
    if (unresolvedOnce) {
      unresolvedOnce = false;
      return [{ id: 1, url: undefined, incognito: false }];
    }
    return [tab];
  };

  click(doc, $(doc, "#refresh"));
  await flush(window, 20);

  assert.strictEqual($(doc, "#host").textContent, "slow.example.com");
  assert.deepStrictEqual(names(doc), ["a"]);
  window.dispose();
});

maybe("subscribes to the tab events it needs", async () => {
  const { window, events } = await start({});
  assert.ok(events.tabs.onActivated.size() > 0, "listens for tab switches");
  assert.ok(events.tabs.onUpdated.size() > 0, "listens for navigations");
  window.dispose();
});

maybe("ignores events for other tabs", async () => {
  const store = makeStore();
  store.set({ url: "https://mine.example.com/", name: "mine", value: "1", path: "/", storeId: "0", sameSite: "lax" });

  const { doc, window, events } = await start({
    store,
    tab: { id: 1, url: "https://mine.example.com/", incognito: false },
  });
  assert.deepStrictEqual(names(doc), ["mine"]);

  events.tabs.onUpdated.emit(999, { status: "loading" }, {});
  events.tabs.onActivated.emit({ tabId: 999 });
  await settle(window, 4);
  assert.deepStrictEqual(names(doc), ["mine"], "another tab's events change nothing");

  events.tabs.onUpdated.emit(1, { status: "loading" }, {});
  await settle(window, 6);
  assert.deepStrictEqual(names(doc), ["mine"]);
  window.dispose();
});

maybe("reloads when the tab navigates to another site", async () => {
  const store = makeStore();
  store.set({ url: "https://one.example.com/", name: "one", value: "1", path: "/", storeId: "0", sameSite: "lax" });
  store.set({ url: "https://two.example.com/", name: "two", value: "1", path: "/", storeId: "0", sameSite: "lax" });

  let tab = { id: 1, url: "https://one.example.com/", incognito: false };
  const { doc, window, events } = await start({ store, tabResolver: () => tab, tab });
  assert.strictEqual($(doc, "#host").textContent, "one.example.com");
  assert.deepStrictEqual(names(doc), ["one"]);

  // An open editor must not survive the move to a different site.
  click(doc, rowNamed(doc, "one").querySelector(".row"));
  await settle(window, 2);
  assert.ok($(doc, ".editor"));

  tab = { id: 1, url: "https://two.example.com/", incognito: false };
  events.tabs.onUpdated.emit(1, { status: "loading", url: tab.url }, tab);
  await settle(window, 8);

  assert.strictEqual($(doc, "#host").textContent, "two.example.com");
  assert.deepStrictEqual(names(doc), ["two"]);
  assert.strictEqual($(doc, ".editor"), null, "the editor was closed");
  window.dispose();
});

maybe("keeps the editor open while the same page is still open", async () => {
  const store = makeStore();
  store.set({ url: "https://site.example.com/", name: "a", value: "1", path: "/", storeId: "0", sameSite: "lax" });

  const tab = { id: 1, url: "https://site.example.com/page", incognito: false };
  const { doc, window, events } = await start({ store, tab });

  click(doc, rowNamed(doc, "a").querySelector(".row"));
  await settle(window, 2);
  setField(doc, field(doc, "value"), "in-progress");

  events.tabs.onUpdated.emit(1, { status: "loading", url: tab.url }, tab);
  await settle(window, 8);

  assert.ok($(doc, ".editor"), "the editor is still open");
  assert.strictEqual(field(doc, "value").value, "in-progress", "and still holds what was typed");
  window.dispose();
});

maybe("a slow background load does not close an open editor", async () => {
  const store = makeStore();
  store.set({ url: "https://race.example.com/", name: "a", value: "1", path: "/", storeId: "0", sameSite: "lax" });

  const { doc, window, events } = await start({
    store,
    tab: { id: 1, url: "https://race.example.com/", incognito: false },
  });

  // Hold every cookies.getAll until released, so a load started now is still
  // in flight when the user opens the editor.
  let release = () => {};
  const held = new Promise((resolve) => (release = resolve));
  const realGetAll = window.chrome.cookies.getAll;
  window.chrome.cookies.getAll = async (query) => {
    await held;
    return realGetAll(query);
  };

  events.tabs.onUpdated.emit(1, { status: "loading" }, {});
  await sleep(200); // the debounced load has started but not finished

  // The list is still on screen from the previous render.
  const row = rowNamed(doc, "a").querySelector(".row");
  row.click();
  await flush(window, 3);
  assert.ok($(doc, ".editor"), "editor is open while the load is pending");

  release();
  await settle(window, 6);

  assert.strictEqual($(doc, "#host").textContent, "race.example.com");
  assert.ok($(doc, ".editor"), "the editor survived the load that finished afterwards");
  assert.strictEqual(field(doc, "value").value, "1", "and still shows the cookie");
  window.dispose();
});

maybe("closing the editor when the site really did change", async () => {
  const store = makeStore();
  store.set({ url: "https://one.example.com/", name: "one", value: "1", path: "/", storeId: "0", sameSite: "lax" });
  store.set({ url: "https://two.example.com/", name: "two", value: "1", path: "/", storeId: "0", sameSite: "lax" });

  let tab = { id: 1, url: "https://one.example.com/", incognito: false };
  const { doc, window, events } = await start({ store, tabResolver: () => tab, tab });

  rowNamed(doc, "one").querySelector(".row").click();
  await flush(window, 2);
  assert.ok($(doc, ".editor"));

  tab = { id: 1, url: "https://two.example.com/", incognito: false };
  events.tabs.onUpdated.emit(1, { status: "loading", url: tab.url }, tab);
  await settle(window, 8);

  assert.strictEqual($(doc, "#host").textContent, "two.example.com");
  assert.strictEqual($(doc, ".editor"), null);
  window.dispose();
});

maybe("a background refresh that finds nothing new leaves the rows alone", async () => {
  const store = makeStore();
  store.set({ url: "https://stable.example.com/", name: "a", value: "1", path: "/", storeId: "0", sameSite: "lax" });

  const { doc, window, events } = await start({
    store,
    tab: { id: 1, url: "https://stable.example.com/", incognito: false },
  });

  const before = rowNamed(doc, "a").querySelector(".row");
  assert.ok(before);

  // Focus and a text selection on the row: re-rendering would drop both.
  before.focus();
  events.tabs.onUpdated.emit(1, { status: "loading" }, {});
  await settle(window, 8);

  assert.strictEqual(rowNamed(doc, "a").querySelector(".row"), before, "the same row element survived");
  assert.strictEqual(doc.activeElement, before, "and still has focus");
  window.dispose();
});

maybe("a refresh that finds a change does rebuild the list", async () => {
  const store = makeStore();
  store.set({ url: "https://changing.example.com/", name: "a", value: "1", path: "/", storeId: "0", sameSite: "lax" });

  const { doc, window, events } = await start({
    store,
    tab: { id: 1, url: "https://changing.example.com/", incognito: false },
  });
  const before = rowNamed(doc, "a").querySelector(".row");

  store.set({ url: "https://changing.example.com/", name: "b", value: "2", path: "/", storeId: "0", sameSite: "lax" });
  events.tabs.onUpdated.emit(1, { status: "loading" }, {});
  await settle(window, 8);

  assert.deepStrictEqual(names(doc), ["a", "b"]);
  assert.notStrictEqual(rowNamed(doc, "a").querySelector(".row"), before);
  window.dispose();
});

maybe("shows the empty state on a site with no cookies", async () => {
  const { doc, window } = await start({ tab: { id: 1, url: "https://nothing.example.com/", incognito: false } });
  assert.match($(doc, "#list").textContent, /No cookies yet/);
  assert.match($(doc, "#list").textContent, /nothing\.example\.com/);
  assert.strictEqual($(doc, "#counts").textContent, "0 cookies");
  window.dispose();
});

maybe("keeps showing the empty state after a refresh", async () => {
  const { doc, window, events } = await start({
    tab: { id: 1, url: "https://nothing.example.com/", incognito: false },
  });
  assert.match($(doc, "#list").textContent, /No cookies yet/);
  events.tabs.onUpdated.emit(1, { status: "loading" }, {});
  await settle(window, 8);
  assert.match($(doc, "#list").textContent, /No cookies yet/, "it did not get wiped by the refresh");
  window.dispose();
});

maybe("clicking a field does not close the editor", async () => {
  const store = makeStore();
  store.set({
    url: "https://www.example.com/",
    name: "theme",
    value: "dark",
    path: "/",
    storeId: "0",
    sameSite: "lax",
  });

  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, rowNamed(doc, "theme").querySelector(".row"));
  await flush(window, 2);
  assert.ok($(doc, ".editor"), "the editor is open");

  // Every control in the form, clicked the way a user would.
  for (const name of ["name", "value", "path", "expiry", "sameSite", "partitionSite"]) {
    const control = $(doc, `.editor [data-field="${name}"]`);
    if (!control) continue;
    click(doc, control);
    await flush(window, 2);
    assert.ok($(doc, ".editor"), `the editor survived a click on the ${name} field`);
  }

  for (const flag of ["secure", "httpOnly", "subdomains", "partition"]) {
    click(doc, field(doc, flag));
    await flush(window, 2);
    assert.ok($(doc, ".editor"), `the editor survived a click on the ${flag} switch`);
  }

  assert.strictEqual(field(doc, "name").value, "theme", "and still holds the cookie");
  window.dispose();
});

maybe("clicking Save saves the cookie and closes the editor", async () => {
  const store = makeStore();
  store.set({
    url: "https://www.example.com/",
    name: "theme",
    value: "dark",
    path: "/",
    storeId: "0",
    sameSite: "lax",
  });

  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, rowNamed(doc, "theme").querySelector(".row"));
  await flush(window, 2);

  setField(doc, field(doc, "value"), "light");
  // A real click on the submit button, not a synthesised submit event.
  click(doc, $(doc, ".editor button[type=submit]"));
  await flush(window, 10);

  assert.strictEqual(store.all().find((c) => c.name === "theme").value, "light");
  assert.strictEqual($(doc, ".editor"), null, "the editor closed after saving");
  window.dispose();
});

/* ------------------------------------------------------- import/export --- */

const panel = (doc) => $(doc, "#panel");
const exportText = (doc) => $(doc, "#export-text").value;

function seedJar(store) {
  store.set({
    url: "https://www.example.com/",
    name: "session",
    value: "abc",
    path: "/",
    storeId: "0",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
  });
  store.set({
    url: "https://www.example.com/",
    name: "theme",
    value: "dark",
    path: "/",
    storeId: "0",
    sameSite: "lax",
  });
  store.set({
    url: "https://www.example.com/",
    name: "wide",
    value: "1",
    path: "/",
    domain: "example.com",
    storeId: "0",
    sameSite: "strict",
  });
}

maybe("the panel is closed until it is asked for", async () => {
  const store = makeStore();
  seedJar(store);
  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  assert.strictEqual(panel(doc).hidden, true);
  assert.ok(!$(doc, "#transfer").classList.contains("on"));

  click(doc, $(doc, "#transfer"));
  await flush(window, 2);
  assert.strictEqual(panel(doc).hidden, false);
  assert.ok($(doc, "#transfer").classList.contains("on"));

  // Escape closes it again.
  doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await flush(window, 2);
  assert.strictEqual(panel(doc).hidden, true);
  assert.ok(!$(doc, "#transfer").classList.contains("on"));
  window.dispose();
});

maybe("the panel's close button closes it and gives the list its room back", async () => {
  const store = makeStore();
  seedJar(store);
  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, $(doc, "#transfer"));
  await flush(window, 2);
  assert.strictEqual(panel(doc).hidden, false);
  assert.ok(doc.body.classList.contains("panel-open"));

  click(doc, $(doc, '[data-act="close-panel"]'));
  await flush(window, 2);
  assert.strictEqual(panel(doc).hidden, true);
  assert.ok(!doc.body.classList.contains("panel-open"));
  window.dispose();
});

maybe("the clear button shows while filtering and empties the filter", async () => {
  const store = makeStore();
  seedJar(store);
  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });
  const clear = $(doc, "#filter-clear");
  const visible = () => rowsOf(doc).filter((item) => !item.hidden).length;
  const all = visible();
  assert.strictEqual(clear.hidden, true);

  setField(doc, $(doc, "#filter"), "theme");
  await flush(window, 2);
  assert.strictEqual(clear.hidden, false);
  assert.ok(visible() < all);

  click(doc, clear);
  await flush(window, 2);
  assert.strictEqual($(doc, "#filter").value, "");
  assert.strictEqual(clear.hidden, true);
  assert.strictEqual(visible(), all);
  window.dispose();
});

maybe("shortcuts with a modifier held are left to the browser", async () => {
  const store = makeStore();
  seedJar(store);
  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  for (const modifier of ["ctrlKey", "metaKey", "altKey"]) {
    doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "e", [modifier]: true, bubbles: true }));
    doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "n", [modifier]: true, bubbles: true }));
  }
  await flush(window, 2);
  assert.strictEqual(panel(doc).hidden, true);
  assert.strictEqual($(doc, ".editor"), null);
  window.dispose();
});

maybe("E opens the export tab and I opens the import tab", async () => {
  const store = makeStore();
  seedJar(store);
  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "e", bubbles: true }));
  await flush(window, 2);
  assert.strictEqual(panel(doc).hidden, false);
  assert.strictEqual($(doc, '[data-panel="export"]', doc).hidden, false);

  click(doc, $(doc, '[data-tab="import"]'));
  await flush(window, 2);
  assert.strictEqual($(doc, '[data-panel="import"]').hidden, false);
  assert.strictEqual($(doc, '[data-panel="export"]').hidden, true);
  assert.strictEqual($(doc, '[data-tab="import"]').getAttribute("aria-selected"), "true");
  window.dispose();
});

maybe("exports the cookies as JSON", async () => {
  const store = makeStore();
  seedJar(store);
  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, $(doc, "#transfer"));
  await flush(window, 2);

  const parsed = JSON.parse(exportText(doc));
  assert.deepStrictEqual(
    parsed.map((c) => c.name),
    ["session", "theme", "wide"]
  );
  const session = parsed.find((c) => c.name === "session");
  assert.strictEqual(session.value, "abc");
  assert.strictEqual(session.secure, true);
  assert.strictEqual(session.httpOnly, true);
  assert.strictEqual(session.sameSite, "lax");
  assert.strictEqual(session.session, true);
  assert.equal("storeId" in session, false);
  assert.match($(doc, "#export-note").textContent, /with every attribute/);
  window.dispose();
});

maybe("exports the cookies as a header string", async () => {
  const store = makeStore();
  seedJar(store);
  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, $(doc, "#transfer"));
  await flush(window, 2);

  setField(doc, $(doc, "#export-format"), "header");
  assert.strictEqual(exportText(doc), "session=abc; theme=dark; wide=1");
  assert.match($(doc, "#export-note").textContent, /Only names and values/);
  window.dispose();
});

maybe("says so when there is nothing to export", async () => {
  const { doc, window } = await start({ tab: { id: 1, url: "https://empty.example.com/", incognito: false } });
  click(doc, $(doc, "#transfer"));
  await flush(window, 2);
  assert.strictEqual(exportText(doc), "");
  assert.match($(doc, "#export-note").textContent, /no cookies/);
  window.dispose();
});

maybe("copies the export to the clipboard", async () => {
  const store = makeStore();
  seedJar(store);
  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  const copied = [];
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => copied.push(text) },
  });

  click(doc, $(doc, "#transfer"));
  await flush(window, 2);
  click(doc, $(doc, "#export-copy"));
  await flush(window, 3);

  assert.strictEqual(copied.length, 1);
  assert.deepStrictEqual(
    JSON.parse(copied[0]).map((c) => c.name),
    ["session", "theme", "wide"]
  );
  assert.match($(doc, "#export-note").textContent, /Copied/);
  window.dispose();
});

maybe("imports a header string into the store", async () => {
  const store = makeStore();
  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, $(doc, "#transfer"));
  await flush(window, 2);
  click(doc, $(doc, '[data-tab="import"]'));
  await flush(window, 2);

  setField(doc, $(doc, "#import-text"), "session=abc; theme=dark");
  setCheckbox(doc, $(doc, "#import-replace"), false);
  click(doc, $(doc, "#import-go"));
  await flush(window, 12);

  assert.deepStrictEqual(
    store
      .all()
      .map((c) => c.name)
      .sort(),
    ["session", "theme"]
  );
  const session = store.all().find((c) => c.name === "session");
  assert.strictEqual(session.value, "abc");
  assert.strictEqual(session.hostOnly, true);
  assert.strictEqual(session.path, "/");
  assert.strictEqual(session.secure, true, "follows the page, like Add cookie");
  assert.match($(doc, "#notice").textContent, /Imported 2 cookies/);
  assert.strictEqual(panel(doc).hidden, true, "the panel closes when it is done");
  window.dispose();
});

maybe("a full export round-trips back into the store", async () => {
  const store = makeStore();
  seedJar(store);
  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, $(doc, "#transfer"));
  await flush(window, 2);
  const exported = exportText(doc);

  click(doc, $(doc, '[data-tab="import"]'));
  await flush(window, 2);
  setField(doc, $(doc, "#import-text"), exported);
  setCheckbox(doc, $(doc, "#import-replace"), true);
  click(doc, $(doc, "#import-go"));
  await flush(window, 16);

  assert.deepStrictEqual(
    store
      .all()
      .map((c) => c.name)
      .sort(),
    ["session", "theme", "wide"]
  );
  const wide = store.all().find((c) => c.name === "wide");
  assert.strictEqual(wide.hostOnly, false, "a domain cookie stayed a domain cookie");
  assert.strictEqual(wide.sameSite, "strict");
  assert.strictEqual(store.all().find((c) => c.name === "session").httpOnly, true);
  window.dispose();
});

maybe("replace clears cookies that were not imported", async () => {
  const store = makeStore();
  seedJar(store);
  store.set({ url: "https://www.example.com/", name: "stray", value: "x", path: "/", storeId: "0", sameSite: "lax" });
  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, $(doc, "#transfer"));
  await flush(window, 2);
  click(doc, $(doc, '[data-tab="import"]'));
  await flush(window, 2);
  setField(doc, $(doc, "#import-text"), '[{"name":"only","value":"1"}]');
  setCheckbox(doc, $(doc, "#import-replace"), true);
  click(doc, $(doc, "#import-go"));
  await flush(window, 16);

  assert.deepStrictEqual(
    store.all().map((c) => c.name),
    ["only"]
  );
  assert.match($(doc, "#notice").textContent, /removed 4 cookies/);
  window.dispose();
});

maybe("replace keeps an imported cookie when a namesake fails", async () => {
  const store = makeStore();
  store.set({ url: "https://www.example.com/", name: "dup", value: "old", path: "/", storeId: "0", sameSite: "lax" });
  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, $(doc, "#transfer"));
  await flush(window, 2);
  click(doc, $(doc, '[data-tab="import"]'));
  await flush(window, 2);
  // Same name twice: the first lands, the second is a public suffix the browser refuses.
  setField(
    doc,
    $(doc, "#import-text"),
    '[{"name":"dup","value":"new"},{"name":"dup","value":"x","domain":".com","hostOnly":false}]'
  );
  setCheckbox(doc, $(doc, "#import-replace"), true);
  click(doc, $(doc, "#import-go"));
  await flush(window, 16);

  assert.deepStrictEqual(
    store.all().map((c) => `${c.name}=${c.value}`),
    ["dup=new"]
  );
  assert.match($(doc, "#notice").textContent, /Imported 1 cookie/);
  window.dispose();
});

maybe("without replace, unrelated cookies are kept", async () => {
  const store = makeStore();
  seedJar(store);
  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, $(doc, "#transfer"));
  await flush(window, 2);
  click(doc, $(doc, '[data-tab="import"]'));
  await flush(window, 2);
  setField(doc, $(doc, "#import-text"), '[{"name":"added","value":"1"}]');
  setCheckbox(doc, $(doc, "#import-replace"), false);
  click(doc, $(doc, "#import-go"));
  await flush(window, 14);

  assert.deepStrictEqual(
    store
      .all()
      .map((c) => c.name)
      .sort(),
    ["added", "session", "theme", "wide"]
  );
  window.dispose();
});

maybe("one bad cookie refuses the whole paste, whatever replace says", async () => {
  const store = makeStore();
  seedJar(store);
  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });
  const before = store
    .all()
    .map((c) => c.name)
    .sort();

  click(doc, $(doc, "#transfer"));
  await flush(window, 2);
  click(doc, $(doc, '[data-tab="import"]'));
  await flush(window, 2);
  setField(doc, $(doc, "#import-text"), '[{"name":"fine","value":"1"},{"name":"","value":"2"}]');
  setCheckbox(doc, $(doc, "#import-replace"), true);
  click(doc, $(doc, "#import-go"));
  await flush(window, 14);

  // Applying the good half and skipping the bad one would quietly empty the jar,
  // so nothing is applied at all.
  assert.deepStrictEqual(
    store
      .all()
      .map((c) => c.name)
      .sort(),
    before
  );
  assert.match($(doc, "#import-note").className, /error/);
  assert.match($(doc, "#import-note").textContent, /nothing was imported/);
  assert.strictEqual(panel(doc).hidden, false, "the panel stays open to fix the text");

  // Correcting the paste then works.
  setField(doc, $(doc, "#import-text"), '[{"name":"fine","value":"1"}]');
  click(doc, $(doc, "#import-go"));
  await flush(window, 14);
  assert.deepStrictEqual(
    store.all().map((c) => c.name),
    ["fine"]
  );
  window.dispose();
});

maybe("importing nothing leaves the jar alone and says why", async () => {
  const store = makeStore();
  seedJar(store);
  const before = store.all().length;
  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, $(doc, "#transfer"));
  await flush(window, 2);
  click(doc, $(doc, '[data-tab="import"]'));
  await flush(window, 2);
  click(doc, $(doc, "#import-go"));
  await flush(window, 8);

  assert.strictEqual(store.all().length, before);
  assert.match($(doc, "#import-note").className, /error/);
  assert.match($(doc, "#import-note").textContent, /nothing to import/i);
  assert.strictEqual(panel(doc).hidden, false, "the panel stays open so the paste can be fixed");

  // Editing the text clears the complaint.
  setField(doc, $(doc, "#import-text"), "a=1");
  assert.doesNotMatch($(doc, "#import-note").className, /error/);
  window.dispose();
});

maybe("cookies for another domain are refused with an explanation", async () => {
  const store = makeStore();
  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });

  click(doc, $(doc, "#transfer"));
  await flush(window, 2);
  click(doc, $(doc, '[data-tab="import"]'));
  await flush(window, 2);
  setField(doc, $(doc, "#import-text"), '[{"name":"evil","value":"1","domain":"other.com"}]');
  click(doc, $(doc, "#import-go"));
  await flush(window, 10);

  assert.strictEqual(store.all().length, 0);
  assert.match($(doc, "#import-note").className, /error/);
  assert.match($(doc, "#import-note").textContent, /nothing was imported/);
  assert.match($(doc, "#import-note").textContent, /parent domains/);
  window.dispose();
});

maybe("the panel closes when the popup moves to another site", async () => {
  const store = makeStore();
  seedJar(store);
  store.set({
    url: "https://elsewhere.example.com/",
    name: "other",
    value: "1",
    path: "/",
    storeId: "0",
    sameSite: "lax",
  });

  let tab = { id: 1, url: "https://www.example.com/", incognito: false };
  const { doc, window, events } = await start({ store, tabResolver: () => tab, tab });

  click(doc, $(doc, "#transfer"));
  await flush(window, 2);
  assert.strictEqual(panel(doc).hidden, false);

  tab = { id: 1, url: "https://elsewhere.example.com/", incognito: false };
  events.tabs.onUpdated.emit(1, { status: "loading", url: tab.url }, tab);
  await settle(window, 8);

  assert.strictEqual(panel(doc).hidden, true);
  window.dispose();
});

maybe("import and export are unavailable on a page with no cookies", async () => {
  const { doc, window } = await start({ tab: { id: 1, url: "chrome://settings/", incognito: false } });
  await settle(window, 2);
  assert.strictEqual($(doc, "#transfer").disabled, true);
  window.dispose();
});

/* -------------------------------------------------------- site access -- */

maybe("without access, the popup asks for it instead of listing cookies", async () => {
  const store = makeStore();
  seedJar(store);
  const { doc, window } = await start({
    store,
    granted: false,
    tab: { id: 1, url: "https://www.example.com/", incognito: false },
  });

  assert.strictEqual($(doc, "#host").textContent, "www.example.com");
  assert.strictEqual($(doc, "#host-sub").textContent, "No access yet");
  assert.match($(doc, ".access").textContent, /Allow access to www\.example\.com/);
  assert.deepStrictEqual(names(doc), []);
  assert.strictEqual($(doc, "#add").disabled, true);
  assert.strictEqual($(doc, "#transfer").disabled, true);
  assert.ok(doc.body.classList.contains("blocked"));
  window.dispose();
});

maybe("allowing access opens the access window for this site, and the popup steps aside", async () => {
  const { doc, window } = await start({
    granted: false,
    tab: { id: 3, windowId: 8, url: "https://www.example.com/", incognito: false },
  });

  click(doc, $(doc, '[data-act="grant-site"]'));
  await flush(window, 8);

  // Not requested from the popup itself: there the browser's dialog can open
  // behind it, unseen.
  assert.deepStrictEqual(window.chrome.permissions.requests, []);
  assert.strictEqual(window.chrome.opened.length, 1);
  const opened = window.chrome.opened[0];
  assert.strictEqual(opened.kind, "window");
  assert.strictEqual(opened.type, "popup");
  assert.strictEqual(opened.focused, true);
  const url = new URL(opened.url);
  assert.strictEqual(url.pathname, "/access/access.html");
  assert.strictEqual(url.searchParams.get("host"), "www.example.com");
  assert.strictEqual(url.searchParams.get("scope"), "site");
  assert.strictEqual(url.searchParams.get("tab"), "3");
  assert.strictEqual(url.searchParams.get("window"), "8");
  assert.ok(window.closed_, "the popup closes so the access window has the stage");
  window.dispose();
});

maybe("allowing all sites opens the access window for every site", async () => {
  const { doc, window } = await start({
    granted: false,
    tab: { id: 1, url: "https://www.example.com/", incognito: false },
  });

  click(doc, $(doc, '[data-act="grant-all"]'));
  await flush(window, 8);

  assert.strictEqual(new URL(window.chrome.opened[0].url).searchParams.get("scope"), "all");
  window.dispose();
});

/* ------------------------------------------------------ access window -- */

const SITE_QUERY = "host=www.example.com&scope=site&tab=3&window=8";

maybe("the access window names the site and every host it will ask for", async () => {
  const { doc, window } = bootAccess({ granted: false, query: SITE_QUERY });
  await flush(window);

  assert.strictEqual($(doc, "#title").textContent, "Allow Cookie Editor on www.example.com");
  assert.deepStrictEqual(
    $$(doc, "#hosts li").map((item) => item.textContent),
    ["www.example.com", "example.com"]
  );
  assert.strictEqual(doc.activeElement, $(doc, "#allow"));
  window.dispose();
});

maybe("allowing in the access window asks the browser, then returns to the tab and reopens the popup", async () => {
  const { doc, window } = bootAccess({ granted: false, query: SITE_QUERY });
  await flush(window);

  click(doc, $(doc, "#allow"));
  await flush(window, 12);

  assert.strictEqual(
    JSON.stringify(window.chrome.permissions.requests),
    JSON.stringify([["*://www.example.com/*", "*://example.com/*"]])
  );
  assert.strictEqual(
    JSON.stringify(window.chrome.returnedTo),
    JSON.stringify([
      { tabId: 3, active: true },
      { windowId: 8, focused: true },
    ])
  );
  assert.strictEqual(JSON.stringify(window.chrome.reopened), JSON.stringify([{ windowId: 8 }]));
  assert.ok(window.closed_);
  window.dispose();
});

maybe("where the popup cannot be reopened, the access window says how to get back", async () => {
  const { doc, window } = bootAccess({ granted: false, noOpenPopup: true, query: SITE_QUERY });
  await flush(window);

  click(doc, $(doc, "#allow"));
  await flush(window, 12);

  assert.ok(!window.closed_);
  assert.match($(doc, "#status").textContent, /Click the Cookie Editor icon in the toolbar/);
  assert.strictEqual($(doc, "#allow").hidden, true);
  assert.strictEqual($(doc, "#cancel").textContent, "Close");
  window.dispose();
});

maybe("declining in the access window keeps it open to try again", async () => {
  const { doc, window } = bootAccess({ granted: false, deny: true, query: SITE_QUERY });
  await flush(window);

  click(doc, $(doc, "#allow"));
  await flush(window, 12);

  assert.ok(!window.closed_);
  assert.match($(doc, "#status").textContent, /not granted/);
  assert.strictEqual($(doc, "#allow").disabled, false);
  window.dispose();
});

maybe("the access window asks for every host when all sites were chosen", async () => {
  const { doc, window } = bootAccess({ granted: false, query: "host=www.example.com&scope=all&tab=3&window=8" });
  await flush(window);

  assert.match($(doc, "#title").textContent, /on all sites/);
  click(doc, $(doc, "#allow"));
  await flush(window, 12);
  assert.strictEqual(JSON.stringify(window.chrome.permissions.requests), JSON.stringify([["<all_urls>"]]));
  window.dispose();
});

maybe("an access window for a site already allowed just returns to it", async () => {
  const { window } = bootAccess({ granted: true, query: SITE_QUERY });
  await flush(window, 12);

  assert.deepStrictEqual(window.chrome.permissions.requests, []);
  assert.ok(window.closed_);
  window.dispose();
});

maybe("an access window without a site has nothing to allow", async () => {
  const { doc, window } = bootAccess({ granted: false, query: "scope=site" });
  await flush(window);

  assert.strictEqual($(doc, "#title").textContent, "Nothing to allow");
  assert.strictEqual($(doc, "#allow").hidden, true);
  window.dispose();
});

maybe("taking access back from the browser hides the cookies again", async () => {
  const store = makeStore();
  seedJar(store);
  const { doc, window } = await start({ store, tab: { id: 1, url: "https://www.example.com/", incognito: false } });
  assert.ok(names(doc).length > 0);

  window.chrome.permissions.granted = false;
  window.chrome.permissions.onRemoved.emit({ origins: ["*://www.example.com/*"] });
  await settle(window, 16);

  assert.ok($(doc, ".access"));
  assert.deepStrictEqual(names(doc), []);
  window.dispose();
});

/* ------------------------------------------------------- local storage -- */

const storageRows = (doc) => $$(doc, "#storage-list .item").filter((item) => item.querySelector(".row"));
const storageKeys = (doc) => storageRows(doc).map((item) => item.querySelector(".row-name").textContent);
const storageRow = (doc, key) => storageRows(doc).find((item) => item.dataset.key === key);
const storageField = (doc, name) => $(doc, `#storage-list .editor [data-field="${name}"]`);

function key(doc, keyName, extra) {
  doc.activeElement.dispatchEvent(
    new doc.defaultView.KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true, ...extra })
  );
}

async function startStorage(items, options) {
  const tab = { id: 1, url: "https://www.example.com/app", incognito: false };
  const ctx = await start({ tab, page: makePage(tab.url, items, options && options.quota), ...options });
  click(ctx.doc, $(ctx.doc, "#view-tab-storage"));
  await flush(ctx.window);
  return ctx;
}

maybe("the popup has a Cookies and a Local storage tab, with counts", async () => {
  const store = makeStore();
  store.set({ url: "https://www.example.com/", name: "sid", value: "1", path: "/", sameSite: "lax" });
  const tab = { id: 1, url: "https://www.example.com/app", incognito: false };
  const { window, doc } = await start({ store, tab, page: makePage(tab.url, { a: "1", b: "2" }) });

  assert.strictEqual($(doc, "#view-tab-cookies").getAttribute("aria-selected"), "true");
  assert.ok(!$(doc, "#view-cookies").hidden);
  assert.ok($(doc, "#view-storage").hidden);
  assert.strictEqual($(doc, "#count-cookies").textContent, "1");
  assert.strictEqual($(doc, "#count-storage").textContent, "2", "storage is read up front for its count");

  click(doc, $(doc, "#view-tab-storage"));
  await flush(window);
  assert.ok($(doc, "#view-cookies").hidden);
  assert.ok(!$(doc, "#view-storage").hidden);
  assert.strictEqual($(doc, "#view-tab-storage").getAttribute("aria-selected"), "true");
  window.dispose();
});

maybe("the number keys switch tabs, and the popup reopens on the last one", async () => {
  const { window, doc } = await start();
  doc.body.focus();
  key(doc, "2");
  await flush(window);
  assert.ok(!$(doc, "#view-storage").hidden);
  key(doc, "1");
  assert.ok(!$(doc, "#view-cookies").hidden);
  key(doc, "2");
  await flush(window);
  assert.strictEqual(window.localStorage.getItem("cookie-editor.view"), "storage");
  window.dispose();

  const again = await start({ savedView: "storage" });
  assert.ok(!$(again.doc, "#view-storage").hidden);
  assert.ok($(again.doc, "#view-cookies").hidden);
  again.window.dispose();
});

maybe("lists local storage sorted by key, with sizes and a JSON badge", async () => {
  const { window, doc } = await startStorage({ zeta: "z", alpha: '{"a":1}', item10: "x", item2: "y" });
  assert.deepStrictEqual(storageKeys(doc), ["alpha", "item2", "item10", "zeta"]);
  const alpha = storageRow(doc, "alpha");
  assert.strictEqual($(alpha, ".badge").textContent, "JSON");
  assert.strictEqual($(alpha, ".row-size").textContent, "24 B");
  assert.match($(doc, "#storage-counts").textContent, /^4 items · \d+ B$/);
  window.dispose();
});

maybe("filters local storage on key and value", async () => {
  const { window, doc } = await startStorage({ theme: "dark", lang: "en", token: "abc-dark" });
  setField(doc, $(doc, "#storage-filter"), "dark");
  const visible = storageRows(doc)
    .filter((item) => !item.hidden)
    .map((item) => item.dataset.key);
  assert.deepStrictEqual(visible, ["theme", "token"]);
  assert.strictEqual($(doc, "#storage-counts").textContent, "2 of 3 items");
  window.dispose();
});

maybe("quick edit: a click opens the item on its value, and Ctrl+Enter saves it", async () => {
  const { window, doc, page } = await startStorage({ theme: "dark" });
  click(doc, $(storageRow(doc, "theme"), ".row"));
  const value = storageField(doc, "value");
  assert.strictEqual(doc.activeElement, value, "the value has focus");
  assert.strictEqual(value.selectionStart, 0);
  assert.strictEqual(value.selectionEnd, 4, "and is selected, ready to type over");

  setField(doc, value, "light");
  key(doc, "Enter", { ctrlKey: true });
  await flush(window);
  assert.deepStrictEqual(page.items(), { theme: "light" });
  assert.ok(!$(doc, "#storage-list .editor"), "the editor closes");
  assert.strictEqual($(storageRow(doc, "theme"), ".row-value").textContent, "light");
  assert.match($(doc, "#notice").textContent, /saved/i);
  window.dispose();
});

maybe("renaming an item moves it rather than copying it", async () => {
  const { window, doc, page } = await startStorage({ old: "v", other: "o" });
  click(doc, $(storageRow(doc, "old"), ".row"));
  setField(doc, storageField(doc, "key"), "new");
  submitStorage(doc);
  await flush(window);
  assert.deepStrictEqual(page.items(), { other: "o", new: "v" });
  window.dispose();
});

function submitStorage(doc) {
  const form = $(doc, "#storage-list .editor");
  form.dispatchEvent(new doc.defaultView.Event("submit", { bubbles: true, cancelable: true }));
}

maybe("adds an item, and refuses a key that is already taken", async () => {
  const { window, doc, page } = await startStorage({ taken: "1" });
  click(doc, $(doc, "#storage-add"));
  assert.strictEqual(doc.activeElement, storageField(doc, "key"));

  setField(doc, storageField(doc, "key"), "taken");
  setField(doc, storageField(doc, "value"), "2");
  submitStorage(doc);
  await flush(window);
  assert.match($(doc, '#storage-list [data-msg="key"]').textContent, /already exists/);
  assert.deepStrictEqual(page.items(), { taken: "1" }, "nothing written");

  setField(doc, storageField(doc, "key"), "fresh");
  submitStorage(doc);
  await flush(window);
  assert.deepStrictEqual(page.items(), { taken: "1", fresh: "2" });
  assert.deepStrictEqual(storageKeys(doc), ["fresh", "taken"]);
  window.dispose();
});

maybe("an empty key is refused", async () => {
  const { window, doc, page } = await startStorage({});
  click(doc, $(doc, "#storage-add"));
  submitStorage(doc);
  await flush(window);
  assert.match($(doc, '#storage-list [data-msg="key"]').textContent, /Give the item a key/);
  assert.deepStrictEqual(page.items(), {});
  window.dispose();
});

maybe("Format JSON switches a value between formatted and one line", async () => {
  const { window, doc } = await startStorage({ cfg: '{"a":1,"b":[1,2]}', plain: "text" });
  click(doc, $(storageRow(doc, "plain"), ".row"));
  assert.ok($(doc, '#storage-list [data-act="format"]').hidden, "no button for plain text");

  click(doc, $(storageRow(doc, "cfg"), ".row"));
  const button = $(doc, '#storage-list [data-act="format"]');
  assert.ok(!button.hidden);
  click(doc, button);
  assert.strictEqual(storageField(doc, "value").value, '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
  click(doc, button);
  assert.strictEqual(storageField(doc, "value").value, '{"a":1,"b":[1,2]}');
  window.dispose();
});

maybe("deleting an item asks first", async () => {
  const { window, doc, page } = await startStorage({ a: "1", b: "2" });
  click(doc, $(storageRow(doc, "a"), '[data-act="delete"]'));
  assert.ok(!$(doc, "#confirm").hidden);
  assert.match($(doc, "#confirm-text").textContent, /“a”/);
  assert.deepStrictEqual(page.items(), { a: "1", b: "2" });
  click(doc, $(doc, "#confirm-ok"));
  await flush(window);
  assert.deepStrictEqual(page.items(), { b: "2" });
  assert.deepStrictEqual(storageKeys(doc), ["b"]);
  window.dispose();
});

maybe("Delete all on the Local storage tab clears storage and leaves cookies alone", async () => {
  const store = makeStore();
  store.set({ url: "https://www.example.com/", name: "sid", value: "1", path: "/", sameSite: "lax" });
  const { window, doc, page } = await startStorage({ a: "1", b: "2" }, { store });
  click(doc, $(doc, "#delete-all"));
  assert.match($(doc, "#confirm-text").textContent, /2 items in local storage for https:\/\/www\.example\.com/);
  click(doc, $(doc, "#confirm-ok"));
  await flush(window);
  assert.deepStrictEqual(page.items(), {});
  assert.strictEqual(store.all().length, 1, "the cookie is still there");
  assert.strictEqual($(doc, "#count-storage").textContent, "0");
  window.dispose();
});

maybe("exports local storage as a JSON object", async () => {
  const { window, doc } = await startStorage({ b: "2", a: '{"x":1}' });
  doc.body.focus();
  key(doc, "e");
  assert.ok(!$(doc, "#storage-panel").hidden);
  assert.deepStrictEqual(JSON.parse($(doc, "#storage-export-text").value), { a: '{"x":1}', b: "2" });
  window.dispose();
});

maybe("imports merge by default, or replace everything when asked", async () => {
  const { window, doc, page } = await startStorage({ keep: "1", over: "old" });
  click(doc, $(doc, "#storage-transfer"));
  click(doc, $(doc, '#storage-panel [data-tab="import"]'));
  setField(doc, $(doc, "#storage-import-text"), '{"over": "new", "obj": {"n": 1}}');
  click(doc, $(doc, "#storage-import-go"));
  await flush(window);
  assert.deepStrictEqual(page.items(), { keep: "1", over: "new", obj: '{"n":1}' });
  assert.ok($(doc, "#storage-panel").hidden, "a clean import closes the panel");

  click(doc, $(doc, "#storage-transfer"));
  click(doc, $(doc, '#storage-panel [data-tab="import"]'));
  setField(doc, $(doc, "#storage-import-text"), '{"only": "me"}');
  setCheckbox(doc, $(doc, "#storage-import-replace"), true);
  click(doc, $(doc, "#storage-import-go"));
  await flush(window);
  assert.deepStrictEqual(page.items(), { only: "me" });
  window.dispose();
});

maybe("an import that is not a JSON object writes nothing", async () => {
  const { window, doc, page } = await startStorage({ a: "1" });
  click(doc, $(doc, "#storage-transfer"));
  click(doc, $(doc, '#storage-panel [data-tab="import"]'));
  setField(doc, $(doc, "#storage-import-text"), "[1, 2]");
  click(doc, $(doc, "#storage-import-go"));
  await flush(window);
  assert.match($(doc, "#storage-import-note").textContent, /JSON object/);
  assert.deepStrictEqual(page.items(), { a: "1" });
  window.dispose();
});

maybe("a write that runs out of quota is rolled back and reported", async () => {
  const { window, doc, page } = await startStorage({ a: "1" }, { quota: 20 });
  click(doc, $(doc, "#storage-transfer"));
  click(doc, $(doc, '#storage-panel [data-tab="import"]'));
  setField(doc, $(doc, "#storage-import-text"), '{"b": "2", "big": "0123456789012345"}');
  click(doc, $(doc, "#storage-import-go"));
  await flush(window);
  assert.match($(doc, "#storage-import-note").textContent, /Nothing was imported: .*quota/);
  assert.deepStrictEqual(page.items(), { a: "1" }, "the half-done import is undone");
  window.dispose();
});

maybe("a write is refused once the tab has moved to another origin", async () => {
  const { window, doc, page } = await startStorage({ a: "1" });
  page.location.origin = "https://elsewhere.example";
  click(doc, $(storageRow(doc, "a"), ".row"));
  setField(doc, storageField(doc, "value"), "2");
  submitStorage(doc);
  await flush(window);
  assert.match($(doc, "#notice").textContent, /page has changed/);
  assert.deepStrictEqual(page.items(), { a: "1" });
  window.dispose();
});

maybe("a page whose storage cannot be reached says so", async () => {
  const { window, doc } = await startStorage({}, { noScripting: true });
  assert.match($(doc, "#storage-list").textContent, /Local storage is not available here/);
  assert.match($(doc, "#storage-list").textContent, /Cannot access contents of the page/);
  assert.ok($(doc, "#storage-add").disabled);
  window.dispose();
});

maybe("storage is read from the active tab, in its top frame", async () => {
  const { window, doc } = await startStorage({ a: "1" });
  // Reads take no arguments; writes take the origin and the changes. (The
  // functions' own names do not survive minifying.)
  const reads = window.chrome.scripting.calls.filter((call) => call.args.length === 0);
  assert.ok(reads.length >= 1);
  assert.ok(reads.every((call) => call.tabId === 1));
  assert.ok(doc);
  window.dispose();
});

maybe("without access, the access prompt shows even when Local storage was the last tab", async () => {
  const { window, doc } = await start({ granted: false, savedView: "storage" });
  assert.ok($(doc, "#list .empty.access"), "the prompt is in the list on show");
  assert.ok(!$(doc, "#view-cookies").hidden);
  assert.ok($(doc, "#view-storage").hidden);
  assert.ok(doc.body.classList.contains("blocked"), "which also hides the tab strip");
  window.dispose();
});

maybe("quick edit for cookies too: opening a cookie focuses its value", async () => {
  const store = makeStore();
  store.set({ url: "https://www.example.com/", name: "sid", value: "abc", path: "/", sameSite: "lax" });
  const { window, doc } = await start({ store });
  click(doc, $(rowNamed(doc, "sid"), ".row"));
  assert.strictEqual(doc.activeElement, field(doc, "value"));
  window.dispose();
});
