/**
 * Thin, promise-based wrapper around the WebExtension APIs this add-on needs.
 *
 * Firefox exposes the promise-based `browser` namespace; Chromium only has
 * `chrome`, which is promise-based under MV3. Preferring `browser` when it is
 * present means a single code path for both.
 *
 * Depends on the pure helpers in lib/cookies.js.
 */
(function (global) {
  "use strict";

  const ns = global.browser && global.browser.cookies ? global.browser : global.chrome;

  const Api = {
    /**
     * The tab the user is currently looking at.
     *
     * A popup runs inside a short-lived window of its own, so `currentWindow`
     * can resolve to that window and come back empty while the popup is still
     * starting up. Fall back to the focused window, and retry briefly, rather
     * than telling the user the tab has no address.
     *
     * @returns {Promise<{id: number, windowId: number, url: string, incognito: boolean}|null>}
     */
    async activeTab(attempts = 6) {
      // A popup can briefly appear as the active tab of its own window. Asking
      // about cookies for our own extension page is never what the user meant,
      // so those tabs are skipped.
      const isSelf = (url) => typeof url === "string" && url.startsWith(ns.runtime.getURL(""));
      const usable = (tab) => tab && tab.url && !isSelf(tab.url);

      const queries = [
        { active: true, currentWindow: true },
        { active: true, lastFocusedWindow: true },
      ];
      const query = async (q) => {
        try {
          return (await ns.tabs.query(q)) || [];
        } catch (_) {
          return [];
        }
      };

      for (let attempt = 0; attempt < attempts; attempt++) {
        for (const q of queries) {
          const found = (await query(q)).find(usable);
          if (found) return found;
        }
        if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 60));
      }

      // Nothing usable: hand back the best shape we have so the caller can
      // report why it is unusable.
      for (const q of queries) {
        const [first] = await query(q);
        if (first) return first;
      }
      return null;
    },

    /**
     * Whether the extension may already read and write cookies for all of
     * `origins` (match patterns).
     * @param {string[]} origins
     */
    hasAccess(origins) {
      return ns.permissions.contains({ origins });
    },

    /**
     * Ask the user for host access. Browsers only show the prompt in response
     * to a user gesture, so call this straight from a click handler, with no
     * `await` before it.
     * @param {string[]} origins
     * @returns {Promise<boolean>} whether access was granted
     */
    requestAccess(origins) {
      return ns.permissions.request({ origins });
    },

    /**
     * Open one of the extension's own pages (`path` relative to the package
     * root) in a small window of its own, focused, or in a tab where windows
     * are not available.
     *
     * The access prompt needs this: requested from the action popup, the
     * browser's permission dialog can open *behind* the popup, where nobody
     * sees it. From a window of our own it has nothing to hide behind.
     * @param {string} path
     */
    openWindow(path, width = 480, height = 440) {
      const url = ns.runtime.getURL(path);
      if (ns.windows && typeof ns.windows.create === "function") {
        return ns.windows.create({ url, type: "popup", width, height, focused: true });
      }
      return ns.tabs.create({ url });
    },

    /**
     * Bring the user back to `tabId` in `windowId` and reopen the action popup
     * there, where the browser allows that (`action.openPopup`, Chrome 127+).
     * @returns {Promise<boolean>} whether the popup was reopened
     */
    async returnToTab(tabId, windowId) {
      try {
        if (Number.isInteger(tabId)) await ns.tabs.update(tabId, { active: true });
        if (Number.isInteger(windowId)) await ns.windows.update(windowId, { focused: true });
      } catch (_) {
        /* the tab or window has gone; nothing to return to */
        return false;
      }
      if (!ns.action || typeof ns.action.openPopup !== "function" || !Number.isInteger(windowId)) return false;
      try {
        await ns.action.openPopup({ windowId });
        return true;
      } catch (_) {
        return false;
      }
    },

    /**
     * Every cookie the browser would send to `url`. That includes cookies set
     * on parent domains and HttpOnly cookies that page scripts cannot see.
     * @param {string} url
     */
    getCookies(url) {
      return ns.cookies.getAll({ url });
    },

    /**
     * Create or overwrite a cookie. Resolves with the cookie as actually stored
     * by the browser (normalised domain, hostOnly flag, expiration, ...).
     * @param {object} details
     */
    setCookie(details) {
      return ns.cookies.set(details);
    },

    /**
     * Delete a cookie, identified by a cookie object as returned by
     * `getCookies`.
     * @param {object} cookie
     */
    async removeCookie(cookie) {
      const removed = await ns.cookies.remove(CookieUtils.removeOptions(cookie));
      if (!removed) throw new Error(`Could not delete the cookie "${cookie.name}".`);
      return removed;
    },

    /**
     * The id of the cookie store a tab belongs to, which differs between normal
     * and private windows ("0"/"1" on Chromium, "firefox-container-2" and
     * friends on Firefox). Needed when creating cookies on a tab that has none.
     * @param {number} tabId
     */
    async cookieStoreForTab(tabId) {
      let stores;
      try {
        stores = await ns.cookies.getAllCookieStores();
      } catch (_) {
        return null;
      }
      if (!stores.length) return null;
      const match = stores.find((store) => Array.isArray(store.tabIds) && store.tabIds.includes(tabId));
      if (match) return match.id;
      const fallback = stores.find((store) => store.incognito) || stores[0];
      return fallback ? fallback.id : null;
    },

    /**
     * The page's origin and localStorage, as `{origin, pairs: [[key, value]]}`.
     * Runs in the tab's top frame, which needs the same host access as its
     * cookies.
     * @param {number} tabId
     */
    readStorage(tabId) {
      return inPage(tabId, pageReadStorage, []);
    },

    /**
     * Apply `ops` (`{op: "set", key, value}`, `{op: "remove", key}` or
     * `{op: "clear"}`) to the page's localStorage, all or nothing, and only if
     * the page is still on `origin`: a tab that navigated since it was read
     * must not get the old page's items.
     */
    writeStorage(tabId, origin, ops) {
      return inPage(tabId, pageWriteStorage, [origin, ops]);
    },

    /**
     * Subscribe to an event, e.g. `on("tabs", "onUpdated", fn)`.
     *
     * Events are properties of their namespace (`chrome.tabs.onUpdated`), not
     * methods on it, so they cannot be subscribed to generically.
     * @returns {Function} unsubscribe
     */
    on(target, event, listener) {
      const emitter = ns[target] && ns[target][event];
      if (!emitter || typeof emitter.addListener !== "function") {
        throw new Error(`The ${target}.${event} event is not available.`);
      }
      emitter.addListener(listener);
      return () => emitter.removeListener(listener);
    },
  };

  /**
   * Run `func(...args)` in the tab's top frame and return what it returns.
   * The injected functions report their own failures as `{error}`, because a
   * throw inside the page does not reliably reach the caller.
   */
  async function inPage(tabId, func, args) {
    if (!ns.scripting || typeof ns.scripting.executeScript !== "function") {
      throw new Error("This browser cannot reach the page's storage.");
    }
    const [injection] = await ns.scripting.executeScript({ target: { tabId }, func, args });
    const result = injection && injection.result;
    if (!result) throw new Error("The page did not answer. Reload it and try again.");
    if (result.error) throw new Error(result.error);
    return result;
  }

  // The two functions below are serialised and run inside the page, so they
  // may only use what the page has: no closures, no helpers from this file.

  function pageReadStorage() {
    try {
      const pairs = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        pairs.push([key, localStorage.getItem(key)]);
      }
      return { origin: location.origin, pairs };
    } catch (error) {
      return { error: `The page's storage is not available (${error.message}).` };
    }
  }

  function pageWriteStorage(origin, ops) {
    if (location.origin !== origin) {
      return { error: "The page has changed since its storage was read. Reload and try again." };
    }
    const backup = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        backup.push([key, localStorage.getItem(key)]);
      }
      for (const op of ops) {
        if (op.op === "set") localStorage.setItem(op.key, op.value);
        else if (op.op === "remove") localStorage.removeItem(op.key);
        else if (op.op === "clear") localStorage.clear();
      }
      return { ok: true };
    } catch (error) {
      // Typically the quota. Put everything back as it was.
      try {
        localStorage.clear();
        for (const [key, value] of backup) localStorage.setItem(key, value);
      } catch (_) {
        /* nothing more can be done from here */
      }
      const quota = error && (error.name === "QuotaExceededError" || error.code === 22);
      return { error: quota ? "The site's storage is full (quota exceeded)." : error.message };
    }
  }

  global.Api = Api;
})(typeof globalThis !== "undefined" ? globalThis : window);
