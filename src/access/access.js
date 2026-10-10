/**
 * Cookie Editor — access window.
 *
 * Opened by the popup to ask for host access. The browser's permission dialog
 * has to be requested from a page the user can see: asked for from the action
 * popup, it can open behind the popup and go unnoticed. Here it opens over a
 * window of our own, which also says up front what is being asked for.
 *
 * Query: `host` (the site), `scope` ("site" or "all"), and the `tab` and
 * `window` to take the user back to afterwards.
 */
(function () {
  "use strict";

  const U = CookieUtils;
  const $ = (selector) => document.querySelector(selector);

  const params = new URLSearchParams(location.search);
  const allSites = params.get("scope") === "all";
  const site = U.parseSite(`https://${params.get("host") || ""}/`);
  const tabId = toId(params.get("tab"));
  const windowId = toId(params.get("window"));

  function toId(value) {
    const id = Number(value);
    return value !== null && value !== "" && Number.isInteger(id) ? id : null;
  }

  function setStatus(text, kind) {
    const status = $("#status");
    status.textContent = text;
    status.className = `access-status${kind ? ` ${kind}` : ""}`;
    status.hidden = !text;
  }

  function render() {
    if (!allSites && !site.supported) {
      $("#title").textContent = "Nothing to allow";
      $("#lead").textContent = "This window was opened without a website to ask about.";
      $("#allow").hidden = true;
      $("#cancel").textContent = "Close";
      return null;
    }

    if (allSites) {
      $("#title").textContent = "Allow Cookie Editor on all sites";
      $("#lead").textContent =
        "Cookie Editor will be able to read and change cookies and local storage on every website, whenever you open it there.";
      return ["<all_urls>"];
    }

    $("#title").textContent = `Allow Cookie Editor on ${site.host}`;
    $("#lead").textContent =
      "Cookie Editor will be able to read and change the cookies and local storage of this site. Cookies a site shares with its parent domains need those too:";
    const origins = U.accessOrigins(site);
    $("#hosts").replaceChildren(
      ...U.domainChain(site.host).map((host) => {
        const item = document.createElement("li");
        item.textContent = host;
        return item;
      })
    );
    return origins;
  }

  /** Access is in place: hand the user back to the page they came from. */
  async function finish() {
    $("#buttons").hidden = true;
    setStatus("Access granted. Taking you back…", "ok");
    if (await Api.returnToTab(tabId, windowId)) {
      window.close();
      return;
    }
    // Where the browser cannot reopen the popup itself, say how to.
    setStatus(
      `Access granted. Click the Cookie Editor icon in the toolbar to manage the cookies and storage of ${
        allSites ? "any site" : site.host
      }.`,
      "ok"
    );
    $("#cancel").textContent = "Close";
    $("#allow").hidden = true;
    $("#buttons").hidden = false;
  }

  function init() {
    const origins = render();

    $("#cancel").addEventListener("click", () => window.close());
    if (!origins) return;

    const allow = $("#allow");
    allow.addEventListener("click", () => {
      allow.disabled = true;
      setStatus("");
      // Straight from the click, with nothing awaited first: browsers only
      // show the permission dialog in response to a user gesture.
      Api.requestAccess(origins)
        .then((granted) => {
          if (granted) return finish();
          allow.disabled = false;
          setStatus("Access was not granted. Click Allow access to try again, or Cancel.", "error");
        })
        .catch((error) => {
          allow.disabled = false;
          setStatus(`Could not ask for access: ${error.message}`, "error");
        });
    });

    // The site may already be allowed, e.g. from another window.
    Api.hasAccess(origins)
      .then((granted) => {
        if (granted) finish();
      })
      .catch(() => {});

    allow.focus();
  }

  init();
})();
