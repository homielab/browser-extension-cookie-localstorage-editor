/**
 * Cookie Editor — popup controller.
 *
 * Owns the header, the Cookies / Local storage tabs, notices and the confirm
 * bar, and runs the Cookies tab: renders the cookies of the active tab and
 * turns edits into `cookies.set` / `cookies.remove` calls. The cookie plumbing
 * lives in lib/cookies.js; the Local storage tab is storage-view.js.
 */
(function () {
  "use strict";

  const U = CookieUtils;

  /* ------------------------------------------------------------- helpers -- */

  const $ = (selector, root) => (root || document).querySelector(selector);

  /** The editor control bound to a draft field, e.g. `fieldOf(form, "name")`. */
  const fieldOf = (form, name) => $(`[data-field="${name}"]`, form);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const isTypingTarget = (node) =>
    !!node &&
    (node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.tagName === "SELECT" || node.isContentEditable);

  const pluralize = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

  /** Run `fn` at most once per `wait` ms, always with the latest arguments. */
  function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  /** Fields that `validateEditor` is able to move focus to. */
  const FOCUSABLE_FIELDS = ["name", "domain", "path", "expiry", "sameSite", "partition", "value"];

  /* --------------------------------------------------------------- state -- */

  const VIEWS = ["cookies", "storage"];
  const VIEW_KEY = "cookie-editor.view";

  const state = {
    /** The tab on show: "cookies" or "storage". */
    view: "cookies",
    tabId: null,
    incognito: false,
    storeId: "0",
    site: null,
    cookies: [],
    /** key -> cookie, and key -> row element, both in render order. */
    byKey: new Map(),
    items: new Map(),
    filter: "",
    /** Whether the list has been built at least once. */
    rendered: false,
    /** @type {{mode: "create"|"edit", cookie: object|null, key: string|null, draft: object}} */
    editor: null,
    /** @type {{onConfirm: Function}|null} */
    confirm: null,
    /** @type {{host: string, tabId: number, windowId: number}|null} the site waiting for access */
    pendingAccess: null,
    /** @type {{tab: "export"|"import"}|null} the open import/export panel */
    transfer: null,
    busy: false,
  };

  const dom = {};

  /** The live <form> for the editor, kept out of the state object. */
  let editorForm = null;
  /** Wrapper element used to host the editor while creating a cookie. */
  let editorHolder = null;
  /** Hides the current notice; replaced each time a notice is shown. */
  let noticeTimer = null;

  /** The Local storage tab, created in init(). */
  let storageView = null;

  /** The Cookies tab, in the shape the shortcuts and header buttons use. */
  const cookieView = {
    focusFilter() {
      dom.filter.focus();
      dom.filter.select();
    },
    openCreate: () => openCreate(),
    openPanel: (tab) => openPanel(tab),
    askDeleteAll: () => askDeleteAll(),
    save: () => saveEditor(),
    hasEditor: () => Boolean(state.editor),
    escape() {
      if (state.transfer) return (closePanel(), true);
      if (state.editor) return (closeEditor(), true);
      if (dom.filter.value) return (clearFilter(), true);
      return false;
    },
  };

  const activeView = () => (state.view === "storage" && storageView ? storageView : cookieView);

  /** Single-key shortcuts, ignored while typing or with a modifier held. */
  const SHORTCUTS = {
    "/": () => activeView().focusFilter(),
    n: () => activeView().openCreate(),
    e: () => activeView().openPanel("export"),
    i: () => activeView().openPanel("import"),
    1: () => showView("cookies"),
    2: () => showView("storage"),
  };

  /* ---------------------------------------------------------------- boot -- */

  function cacheDom() {
    dom.body = document.body;
    dom.host = $("#host");
    dom.hostSub = $("#host-sub");
    dom.filter = $("#filter");
    dom.filterClear = $("#filter-clear");
    dom.counts = $("#counts");
    dom.list = $("#list");
    dom.notice = $("#notice");
    dom.confirm = $("#confirm");
    dom.confirmText = $("#confirm-text");
    dom.confirmOk = $("#confirm-ok");
    dom.add = $("#add");
    dom.transfer = $("#transfer");
    dom.panel = $("#panel");
    dom.exportFormat = $("#export-format");
    dom.exportText = $("#export-text");
    dom.exportNote = $("#export-note");
    dom.importText = $("#import-text");
    dom.importNote = $("#import-note");
    dom.importReplace = $("#import-replace");
    dom.deleteAll = $("#delete-all");
    dom.refresh = $("#refresh");
    dom.domainOptions = $("#domain-options");
    dom.itemTemplate = $("#tpl-item");
    dom.editorTemplate = $("#tpl-editor");
    dom.accessTemplate = $("#tpl-access");
    dom.viewTabs = Array.from(document.querySelectorAll(".view-tab"));
    dom.views = { cookies: $("#view-cookies"), storage: $("#view-storage") };
    dom.viewCounts = { cookies: $("#count-cookies"), storage: $("#count-storage") };
  }

  function buildStaticControls() {
    const select = (name, options) =>
      fieldOf(dom.editorTemplate.content, name).append(
        ...options.map((option) => new Option(option.label, option.value))
      );
    select("expiry", U.EXPIRY_PRESETS);
    select("sameSite", U.SAME_SITES);

    dom.exportFormat.append(...U.EXPORT_FORMATS.map((format) => new Option(format.label, format.value)));
    dom.exportFormat.value = "json";
  }

  function wireEvents() {
    dom.filter.addEventListener("input", () => {
      state.filter = dom.filter.value;
      applyFilter();
    });
    dom.filterClear.addEventListener("click", () => {
      clearFilter();
      dom.filter.focus();
    });
    dom.notice.addEventListener("click", hideNotice);

    dom.add.addEventListener("click", openCreate);
    dom.transfer.addEventListener("click", () => togglePanel());
    // Re-read the tab as well as the cookies: that is what rescues the popup after
    // navigating away from a page that cannot have cookies.
    dom.refresh.addEventListener("click", () => load());
    dom.deleteAll.addEventListener("click", () => activeView().askDeleteAll());

    for (const tab of dom.viewTabs) {
      tab.addEventListener("click", () => showView(tab.dataset.view));
      // Arrow keys move between the tabs, as in any tab strip.
      tab.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const next = VIEWS[(VIEWS.indexOf(state.view) + 1) % VIEWS.length];
        showView(next);
        dom.viewTabs.find((node) => node.dataset.view === next).focus();
      });
    }

    for (const tab of dom.panel.querySelectorAll("[data-tab]")) {
      tab.addEventListener("click", () => showPanel(tab.dataset.tab));
    }
    $('[data-act="close-panel"]', dom.panel).addEventListener("click", closePanel);
    dom.exportFormat.addEventListener("change", renderExport);
    $("#export-copy").addEventListener("click", copyExport);
    $("#export-download").addEventListener("click", downloadExport);
    $("#import-go").addEventListener("click", runImport);
    $("#import-clear").addEventListener("click", () => {
      dom.importText.value = "";
      setImportNote("");
      dom.importText.focus();
    });
    dom.panel.addEventListener("input", () => setImportNote(""));

    dom.confirmOk.addEventListener("click", () => {
      const pending = state.confirm;
      closeConfirm();
      if (pending) pending.onConfirm();
    });
    $("#confirm-cancel").addEventListener("click", closeConfirm);

    dom.list.addEventListener("click", onListClick);
    dom.list.addEventListener("keydown", onListKeydown);
    dom.list.addEventListener("input", onEditorInput);
    dom.list.addEventListener("change", onEditorChange);
    dom.list.addEventListener("submit", onEditorSubmit);

    document.addEventListener("keydown", onGlobalKeydown);
  }

  function watchTab() {
    // Follow the active tab while the popup is open: a tab switch or a
    // navigation has to change which site's cookies are listed. The listeners
    // live exactly as long as the popup document, so there is nothing to tear
    // down on close.
    //
    // Any activation is worth re-reading, because a read that came back without
    // a URL is only the page being mid-load; this is where that gets a retry.
    Api.on("tabs", "onActivated", () => scheduleLoad());

    Api.on("tabs", "onUpdated", (tabId, changeInfo) => {
      // While there is still no site we do not know which tab to watch.
      if (state.tabId !== null && tabId !== state.tabId) return;
      if (changeInfo.url || changeInfo.status === "loading") scheduleLoad();
    });

    // Access granted or taken back, here or from the browser's own menu.
    Api.on("permissions", "onAdded", () => scheduleLoad());
    Api.on("permissions", "onRemoved", () => scheduleLoad());
  }

  const scheduleLoad = debounce(() => load(), 120);

  /* ---------------------------------------------------------------- load -- */

  async function load() {
    let tab;
    try {
      tab = await Api.activeTab();
    } catch (error) {
      return renderBlocked(`Could not read the active tab (${error.message}).`);
    }

    if (!tab || !tab.url) {
      // A tab that has not committed a URL yet (still loading, or a new tab)
      // reports none. So does a tab on a site with no access yet, once the
      // temporary access from clicking the toolbar button has lapsed (after
      // navigating to another site). Say so, and let the tab events above
      // retry as soon as it settles.
      state.tabId = tab ? tab.id : null;
      renderBlocked(
        "This tab has no address yet. If the page has already loaded, reopen Cookie Editor from the toolbar to manage its cookies."
      );
      return;
    }

    const site = U.parseSite(tab.url);
    const previousHost = state.site && state.site.host;

    state.tabId = tab.id;
    state.incognito = Boolean(tab.incognito);

    if (!site.supported) return showSiteBlocked(null, blockedState(site.reason));

    const origins = U.accessOrigins(site);
    let granted = false;
    try {
      granted = await Api.hasAccess(origins);
    } catch (_) {
      /* treat as not granted: the prompt below will say what is needed */
    }
    if (!granted) return showSiteBlocked(site, accessState(site, tab));

    state.storeId = (await Api.cookieStoreForTab(tab.id)) || "0";
    state.site = site;
    state.pendingAccess = null;
    dom.body.classList.remove("blocked");

    if (state.site.host !== previousHost) closeOverlays();
    setActionsEnabled(true);

    dom.host.textContent = site.host;
    dom.host.title = site.url;
    dom.hostSub.textContent = [site.secure ? "HTTPS" : "HTTP (insecure)", state.incognito && "private window"]
      .filter(Boolean)
      .join(" · ");

    dom.domainOptions.replaceChildren(...U.domainChain(site.host).map((domain) => new Option(domain, domain)));

    paintViews();
    const cookiesLoaded = refreshCookies();
    storageView.load({ tabId: tab.id, site });
    await cookiesLoaded;
  }

  /* --------------------------------------------------------------- views -- */

  /** Switch to the Cookies or the Local storage tab, and remember the choice. */
  function showView(view) {
    if (!VIEWS.includes(view)) return;
    const changed = state.view !== view;
    state.view = view;
    closeConfirm();
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch (_) {
      /* only a convenience */
    }
    paintViews();
    // The page may have changed its storage since it was last read.
    if (changed && view === "storage" && state.site) storageView.refresh();
  }

  function rememberedView() {
    try {
      const view = localStorage.getItem(VIEW_KEY);
      return VIEWS.includes(view) ? view : "cookies";
    } catch (_) {
      return "cookies";
    }
  }

  /**
   * Show the chosen tab. A page that cannot be managed shows its message in
   * the Cookies tab whichever tab was chosen, and hides the tabs altogether.
   */
  function paintViews() {
    const shown = dom.body.classList.contains("blocked") ? "cookies" : state.view;
    for (const tab of dom.viewTabs) {
      const selected = tab.dataset.view === shown;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const view of VIEWS) dom.views[view].hidden = view !== shown;
    dom.deleteAll.title =
      shown === "storage" ? "Delete every local storage item of this site" : "Delete every cookie of this site";
  }

  /** The count shown on a tab; "" hides it. */
  function setCount(view, text) {
    dom.viewCounts[view].textContent = text;
  }

  /**
   * Show `content` in place of the list, for a page whose cookies cannot be
   * managed: one that cannot have any (`site` is null), or one the user has
   * not given access to yet.
   */
  function showSiteBlocked(site, content) {
    // openCreate() and askDeleteAll() both bail out on a null site, so the
    // buttons left in the chrome would only be dead weight.
    state.site = null;
    if (!site) state.pendingAccess = null;
    dom.body.classList.add("blocked");
    setActionsEnabled(false);
    closeOverlays();
    state.cookies = [];
    state.byKey = new Map();
    state.items = new Map();
    state.rendered = false;
    storageView.reset();
    setCount("cookies", "");
    paintViews();
    dom.host.textContent = site ? site.host : "Cookie Editor";
    dom.host.title = site ? site.url : "";
    dom.hostSub.textContent = site ? "No access yet" : "";
    dom.counts.textContent = "";
    dom.list.replaceChildren(content);
  }

  /** The prompt asking for access to `site`. */
  function accessState(site, tab) {
    state.pendingAccess = { host: site.host, tabId: tab.id, windowId: tab.windowId };
    const box = dom.accessTemplate.content.firstElementChild.cloneNode(true);
    $("[data-host]", box).textContent = site.host;
    return box;
  }

  /**
   * Ask for access to the shown site, or to every site, from the access
   * window rather than from here: the browser's permission dialog can open
   * behind the action popup, where the user never sees it.
   */
  function requestAccess(allSites) {
    const pending = state.pendingAccess;
    if (!pending) return;
    const params = new URLSearchParams({ host: pending.host, scope: allSites ? "all" : "site" });
    if (Number.isInteger(pending.tabId)) params.set("tab", String(pending.tabId));
    if (Number.isInteger(pending.windowId)) params.set("window", String(pending.windowId));
    Api.openWindow(`access/access.html?${params}`)
      // Focus moves to the new window, which closes the popup anyway.
      .then(() => window.close())
      .catch((error) => showNotice(`Could not ask for access: ${error.message}`, "error"));
  }

  /** Toggle the toolbar actions that need a site (and an idle popup). */
  function setActionsEnabled(enabled) {
    dom.add.disabled = !enabled;
    dom.deleteAll.disabled = !enabled;
    dom.transfer.disabled = !enabled;
  }

  /** Close everything that belongs to the site being shown. */
  function closeOverlays() {
    closeEditor();
    closeConfirm();
    closePanel();
  }

  function renderBlocked(reason) {
    dom.body.classList.add("blocked");
    storageView.reset();
    paintViews();
    dom.list.replaceChildren(blockedState(reason));
  }

  function blockedState(reason) {
    const box = el("div", "empty");
    box.append(el("strong", null, "Nothing to manage here"), el("span", null, reason));
    return box;
  }

  async function refreshCookies() {
    if (!state.site) return;
    dom.refresh.disabled = true;
    try {
      const cookies = U.sortCookies(await Api.getCookies(state.site.url));

      // Rebuilding the list throws away the DOM the user's pointer and selection
      // are on, so a background refresh that finds nothing new leaves the rows
      // alone. That keeps a click from landing on a row that has just been
      // detached. The first load always renders, empty state and all.
      if (state.rendered && U.sameCookieList(cookies, state.cookies)) {
        updateCounts();
        return;
      }
      state.cookies = cookies;
      state.rendered = true;
      renderList();
      if (state.transfer) renderExport();
    } catch (error) {
      showNotice(`Could not read cookies: ${error.message}`, "error");
    } finally {
      dom.refresh.disabled = false;
    }
  }

  /* ---------------------------------------------------------------- list -- */

  function renderList() {
    // A refresh rebuilds the editor from `state.editor.draft`, so take a copy of
    // what is currently in the form first. Without this, a background refresh
    // (a navigation elsewhere, the reload button) would silently throw away
    // unsaved edits.
    if (state.editor && editorForm) {
      state.editor.draft = readDraft(editorForm);
    }

    const focus = captureFocus(editorForm);
    unmountEditor();

    state.byKey = new Map();
    state.items = new Map();

    const fragment = document.createDocumentFragment();
    for (const cookie of state.cookies) {
      const key = U.cookieKey(cookie);
      const item = dom.itemTemplate.content.firstElementChild.cloneNode(true);
      item.dataset.key = key;
      paintRow(item, cookie);
      fragment.append(item);
      state.byKey.set(key, cookie);
      state.items.set(key, item);
    }

    if (!state.cookies.length) fragment.append(quietState());

    const noMatches = el("div", "empty");
    noMatches.id = "no-matches";
    noMatches.hidden = true;
    fragment.append(noMatches);

    dom.list.replaceChildren(fragment);

    if (state.editor) mountEditor();
    restoreFocus(editorForm, focus);
    applyFilter();
  }

  function quietState() {
    const box = el("div", "empty");
    box.append(el("strong", null, "No cookies yet"), el("span", null, `Nothing is stored for ${state.site.host}.`));
    return box;
  }

  function paintRow(item, cookie) {
    $(".row", item).setAttribute("aria-expanded", "false");

    const name = $(".row-name", item);
    name.textContent = cookie.name;
    name.title = cookie.name;

    const value = $(".row-value", item);
    value.textContent = cookie.value === "" ? "empty value" : cookie.value;
    value.classList.toggle("blank", cookie.value === "");
    value.title = cookie.value;

    const expiry = U.expiryInfo(cookie);
    const expiryNode = $(".row-expiry", item);
    expiryNode.textContent = expiry.display;
    expiryNode.classList.toggle("expired", !expiry.session && expiry.relative === "expired");
    expiryNode.classList.toggle("urgent", expiry.urgent);
    expiryNode.title = expiry.session ? "Deleted when the browser closes" : `Expires ${expiry.label}`;

    $(".row-flags", item).replaceChildren(...flagBadges(cookie));

    const domain = $(".row-domain", item);
    if (cookie.hostOnly === false) {
      domain.textContent = `.${U.normalizeDomain(cookie.domain)}`;
      domain.title = `${domain.textContent} — also sent to subdomains`;
    } else {
      domain.textContent = cookie.domain;
      domain.title = `${cookie.domain} only`;
    }

    $(".row-path", item).textContent = cookie.path;
  }

  /** Short text badges for the attributes that change who gets a cookie. */
  function flagBadges(cookie) {
    const badge = (text, title, tone) => {
      const node = el("span", tone ? `badge ${tone}` : "badge", text);
      node.title = title;
      return node;
    };
    const badges = [];
    if (cookie.httpOnly) badges.push(badge("HttpOnly", "Hidden from page scripts (document.cookie)"));
    if (cookie.secure) badges.push(badge("Secure", "Only sent over HTTPS"));
    if (cookie.sameSite === "no_restriction") {
      badges.push(badge("SameSite=None", "Also sent with cross-site requests", "warn"));
    } else if (cookie.sameSite === "strict") {
      badges.push(badge("Strict", "SameSite=Strict: never sent with cross-site requests"));
    }
    if (cookie.partitionKey) {
      badges.push(badge("Partitioned", `Only sent when embedded in ${cookie.partitionKey.topLevelSite}`, "info"));
    }
    return badges;
  }

  function clearFilter() {
    dom.filter.value = "";
    state.filter = "";
    applyFilter();
  }

  function applyFilter() {
    dom.filterClear.hidden = !state.filter;
    let shown = 0;
    for (const [key, item] of state.items) {
      const match = U.matchesFilter(state.byKey.get(key), state.filter);
      item.hidden = !match;
      if (match) shown += 1;
    }

    const noMatches = $("#no-matches");
    if (noMatches) {
      noMatches.hidden = !(shown === 0 && state.cookies.length > 0);
      if (!noMatches.hidden) {
        noMatches.replaceChildren(
          el("strong", null, "No matches"),
          el("span", null, `Nothing matches “${state.filter.trim()}”.`)
        );
      }
    }

    updateCounts(shown);
  }

  function updateCounts(shown) {
    const total = state.cookies.length;
    const visible = typeof shown === "number" ? shown : total;
    dom.counts.textContent = state.filter.trim()
      ? `${visible} of ${pluralize(total, "cookie")}`
      : pluralize(visible, "cookie");
    setCount("cookies", String(total));
  }

  /* -------------------------------------------------------------- events -- */

  function onListClick(event) {
    const grant = event.target.closest('[data-act="grant-site"], [data-act="grant-all"]');
    if (grant) return requestAccess(grant.dataset.act === "grant-all");

    const item = event.target.closest(".item");
    if (!item) return;

    const action = event.target.closest("[data-act]");
    const cookie = state.byKey.get(item.dataset.key);

    if (action) {
      event.stopPropagation();
      switch (action.dataset.act) {
        case "close":
          return closeEditor();
        case "copy":
          if (cookie) copyValue(cookie, action);
          return;
        case "duplicate":
          if (cookie) duplicate(cookie);
          return;
        case "delete":
          if (cookie) {
            openEditor(cookie);
            askDeleteOne(cookie);
          }
          return;
        case "edit":
          if (cookie) openEditor(cookie);
          return;
      }
    }

    // Clicks inside the open editor belong to the form, not to the row: the editor
    // is mounted inside the row's item, so without this every click on a field
    // would bubble up here and toggle the editor shut. It also swallows the
    // click on the Save button, which would otherwise close the form before the
    // browser could submit it.
    if (event.target.closest(".editor")) return;

    if (!cookie) return;
    // Clicking the summary of the open row closes it again.
    if (state.editor && state.editor.key === item.dataset.key) closeEditor();
    else openEditor(cookie);
  }

  function onListKeydown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest(".row");
    if (!row || event.target !== row) return;
    event.preventDefault();
    const cookie = state.byKey.get(row.closest(".item").dataset.key);
    if (cookie) openEditor(cookie);
  }

  function onEditorInput(event) {
    const form = event.target.closest(".editor");
    if (form) syncEditor(form);
  }

  function onEditorChange(event) {
    const form = event.target.closest(".editor");
    if (!form) return;
    const name = event.target.getAttribute("data-field");

    if (name === "path") event.target.value = U.normalizePath(event.target.value);
    if (name === "domain") event.target.value = U.normalizeDomain(event.target.value);

    // Remember the domain across toggling "apply to subdomains", so a host-only
    // cookie can be flipped back to a domain cookie without retyping it.
    if (name === "subdomains") {
      const domain = fieldOf(form, "domain");
      if (event.target.checked) {
        domain.value = domain.dataset.previous || domain.value;
      } else {
        domain.dataset.previous = domain.value;
        domain.value = state.site.host;
      }
    }

    syncEditor(form);
  }

  function onEditorSubmit(event) {
    if (!event.target.closest(".editor")) return;
    event.preventDefault();
    saveEditor();
  }

  function onGlobalKeydown(event) {
    // Ctrl+S, or Ctrl+Enter from the value box: save without reaching for the mouse.
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && (key === "s" || key === "enter")) {
      const view = activeView();
      if (view.hasEditor()) {
        event.preventDefault();
        view.save();
      }
      return;
    }

    if (event.key === "Escape") {
      if (state.confirm) return closeConfirm();
      activeView().escape();
      return;
    }

    if (isTypingTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;

    const shortcut = SHORTCUTS[event.key.toLowerCase()];
    if (shortcut) {
      event.preventDefault();
      shortcut();
    }
  }

  /* -------------------------------------------------------------- editor -- */

  function openEditor(cookie) {
    const key = U.cookieKey(cookie);
    if (!startEditor({ mode: "edit", cookie, key, draft: U.draftFromCookie(cookie) })) return;
    scrollToItem(key);
    // Quick edit: most edits change the value, so start there.
    focusField("value", true);
  }

  function openCreate() {
    if (!state.site) return;
    startEditor({ mode: "create", cookie: null, key: null, draft: U.blankDraft(state.site, currentStoreId()) });
    dom.list.scrollTop = 0;
    focusField("name");
  }

  function duplicate(cookie) {
    const draft = U.draftFromCookie(cookie);
    draft.name = `${cookie.name}-copy`;
    if (!startEditor({ mode: "create", cookie: null, key: null, draft })) return;
    dom.list.scrollTop = 0;
    focusField("name", true);
  }

  /** Show `editor` in place of whatever editor was open. */
  function startEditor(editor) {
    if (!state.site) return false;
    closeConfirm();
    state.editor = editor;
    mountEditor();
    return true;
  }

  function closeEditor() {
    if (!state.editor) return;
    state.editor = null;
    unmountEditor();
  }

  /** Detach the editor from the DOM, leaving `state.editor` alone. */
  function unmountEditor() {
    if (editorForm) editorForm.remove();
    if (editorHolder) editorHolder.remove();
    editorForm = null;
    editorHolder = null;
    markOpenRow(null);
  }

  function mountEditor() {
    unmountEditor();

    editorForm = dom.editorTemplate.content.firstElementChild.cloneNode(true);
    $(".editor-title", editorForm).textContent = state.editor.mode === "create" ? "New cookie" : "Edit cookie";

    // Nothing to delete or duplicate while creating.
    for (const act of editorForm.querySelectorAll('[data-act="delete"], [data-act="duplicate"]')) {
      act.hidden = !state.editor.cookie;
    }

    fillEditor(editorForm, state.editor.draft);

    const item = state.editor.key && state.items.get(state.editor.key);
    if (item) {
      item.append(editorForm);
      markOpenRow(state.editor.key);
    } else {
      editorHolder = el("div", "item");
      editorHolder.setAttribute("role", "listitem");
      editorHolder.append(editorForm);
      dom.list.prepend(editorHolder);
    }
  }

  function markOpenRow(key) {
    for (const [itemKey, item] of state.items) {
      const row = $(":scope > .row", item);
      if (!row) continue;
      row.classList.toggle("open", itemKey === key);
      row.setAttribute("aria-expanded", String(itemKey === key));
    }
  }

  function fillEditor(form, draft) {
    const field = (name) => fieldOf(form, name);

    field("name").value = draft.name;
    field("value").value = draft.value;
    field("domain").value = draft.domain;
    field("domain").dataset.previous = draft.domain;
    field("path").value = draft.path;
    field("sameSite").value = draft.sameSite;
    field("subdomains").checked = !draft.hostOnly;
    field("secure").checked = draft.secure;
    field("httpOnly").checked = draft.httpOnly;
    field("partition").checked = Boolean(draft.partitionKey);
    field("partitionSite").value = draft.partitionKey ? draft.partitionKey.topLevelSite : defaultTopLevelSite();

    const preset = U.expiryPreset(draft.expirationDate);
    field("expiry").value = preset.preset;
    field("expiryDate").value = U.toDateTimeInput(preset.timestamp || Date.now() / 1000 + 3600);

    syncEditor(form);
  }

  /** Keep dependent controls consistent with the current field values. */
  function syncEditor(form) {
    const field = (name) => fieldOf(form, name);

    const sameSite = field("sameSite").value;
    const partitioned = field("partition").checked;
    const subdomains = field("subdomains").checked;

    // Browsers reject SameSite=None and partitioned cookies without Secure, so
    // turn it on rather than letting the save fail later.
    if ((sameSite === "no_restriction" || partitioned) && !field("secure").checked) {
      field("secure").checked = true;
    }

    field("expiryDate").hidden = field("expiry").value !== "custom";
    $("[data-partition]", form).hidden = !partitioned;

    // A host-only cookie's domain comes from the URL, not from this field.
    field("domain").disabled = !subdomains;

    const counter = $("[data-counter]", form);
    if (counter) {
      const length = field("value").value.length;
      counter.textContent = length ? `${length} chars` : "";
    }
  }

  function focusField(name, selectAll) {
    if (!editorForm) return;
    const node = fieldOf(editorForm, name);
    if (!node) return;
    node.focus();
    if (selectAll && node.select) node.select();
  }

  /** Bring the row that owns the open editor fully into view. */
  function scrollToItem(key) {
    const item = state.items.get(key);
    if (!item) return;
    // `nearest` alone can leave the editor's own Save row off-screen.
    if (item.scrollIntoView) item.scrollIntoView({ block: "nearest" });
    if (editorForm && editorForm.scrollIntoView) {
      editorForm.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  /** Remember the caret so a re-render (a refresh, or opening another row)
   *  does not throw away what was being typed. */
  function captureFocus(root) {
    const active = document.activeElement;
    if (!root || !active || !root.contains(active)) return null;
    const name = active.getAttribute && active.getAttribute("data-field");
    if (!name) return null;
    try {
      return { name, start: active.selectionStart, end: active.selectionEnd };
    } catch (_) {
      return { name, start: null, end: null };
    }
  }

  function restoreFocus(root, snapshot) {
    if (!root || !snapshot) return;
    const node = fieldOf(root, snapshot.name);
    if (!node) return;
    node.focus();
    if (snapshot.start != null && node.setSelectionRange) {
      try {
        node.setSelectionRange(snapshot.start, snapshot.end);
      } catch (_) {
        /* not a text control */
      }
    }
  }

  /** Turn the current form contents into a draft. */
  function readDraft(form) {
    const field = (name) => fieldOf(form, name);
    const hostOnly = !field("subdomains").checked;
    const preset = field("expiry").value;

    let expirationDate;
    if (preset === "custom") {
      expirationDate = U.fromDateTimeInput(field("expiryDate").value);
    } else {
      const option = U.EXPIRY_PRESETS.find((entry) => entry.value === preset);
      expirationDate = option && option.seconds ? Math.floor(Date.now() / 1000) + option.seconds : null;
    }

    return {
      name: field("name").value.trim(),
      value: field("value").value,
      domain: hostOnly ? state.site.host : field("domain").value,
      hostOnly,
      path: field("path").value.trim(),
      sameSite: field("sameSite").value,
      secure: field("secure").checked,
      httpOnly: field("httpOnly").checked,
      expirationDate,
      partitionKey: field("partition").checked ? { topLevelSite: field("partitionSite").value.trim() } : null,
      storeId: state.editor.draft.storeId,
    };
  }

  function clearMessages(form) {
    for (const node of form.querySelectorAll(".msg")) node.className = "msg";
    for (const node of form.querySelectorAll(".field.invalid")) node.classList.remove("invalid");
  }

  function showMessage(form, field, text, kind) {
    const node = $(`[data-msg="${field}"]`, form);
    if (!node) return;
    node.className = `msg show ${kind}`;
    node.textContent = text;
    if (kind === "error") {
      const container = node.closest(".field");
      if (container) container.classList.add("invalid");
    }
  }

  /**
   * Validate the draft and paint messages next to the offending fields.
   * @returns {boolean} whether the save may go ahead
   */
  function validateEditor(form, draft) {
    clearMessages(form);

    const { errors, warnings } = U.validateDraft(draft, state.site);
    for (const warning of warnings) showMessage(form, warning.field, warning.message, "warn");

    if (fieldOf(form, "expiry").value === "custom" && draft.expirationDate === null) {
      errors.push({ field: "expiry", message: "Pick a date and time." });
    }

    for (const error of errors) showMessage(form, error.field, error.message, "error");
    if (errors.length) focusField(FOCUSABLE_FIELDS.includes(errors[0].field) ? errors[0].field : "value");
    return errors.length === 0;
  }

  /* --------------------------------------------------------------- saving -- */

  function setBusy(busy) {
    state.busy = busy;
    dom.body.classList.toggle("busy", busy);
    setActionsEnabled(!busy && !!state.site);
  }

  async function saveEditor() {
    const form = editorForm;
    if (!form || state.busy) return;

    const draft = readDraft(form);
    if (!validateEditor(form, draft)) return;

    const details = U.buildDetails(draft, state.site);
    const original = state.editor.cookie;

    setBusy(true);
    try {
      if (original && !U.isSameCookieIdentity(original, details)) {
        // Name, domain, path or partition changed: the browser would keep both
        // the old and the new cookie, so replace it (and roll back on failure).
        await Api.removeCookie(original);
        try {
          await Api.setCookie(details);
        } catch (error) {
          await Api.setCookie(U.detailsFromCookie(original)).catch(() => {});
          throw error;
        }
      } else {
        await Api.setCookie(details);
      }

      state.editor = null;
      showNotice("Cookie saved.", "ok");
      await refreshCookies();
    } catch (error) {
      showNotice(`Could not save the cookie: ${error.message}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function deleteCookie(cookie) {
    if (state.busy) return;
    setBusy(true);
    try {
      await Api.removeCookie(cookie);
      state.editor = null;
      showNotice(`Deleted “${cookie.name}”.`, "ok");
      await refreshCookies();
    } catch (error) {
      showNotice(`Could not delete the cookie: ${error.message}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function deleteAllCookies() {
    if (state.busy) return;
    const targets = state.cookies.slice();
    if (!targets.length) return;

    setBusy(true);
    showNotice(`Deleting ${pluralize(targets.length, "cookie")}…`, "neutral");

    const results = await Promise.allSettled(targets.map((cookie) => Api.removeCookie(cookie)));
    const failures = results.filter((result) => result.status === "rejected");

    setBusy(false);
    await refreshCookies();

    if (!failures.length) {
      showNotice(`Deleted ${pluralize(targets.length, "cookie")} for ${state.site.host}.`, "ok");
    } else if (failures.length < targets.length) {
      showNotice(
        `Deleted ${targets.length - failures.length} of ${targets.length} cookies; ${failures.length} failed.`,
        "error"
      );
    } else {
      showNotice(`Nothing could be deleted: ${failures[0].reason.message}`, "error");
    }
  }

  async function copyValue(cookie, button) {
    try {
      await navigator.clipboard.writeText(cookie.value);
      showNotice(`Copied the value of “${cookie.name}”.`, "ok");
      if (button) flashDone(button);
    } catch (_) {
      showNotice("The clipboard is not available here.", "error");
    }
  }

  /** Briefly turn an icon button into a check mark to confirm it worked. */
  function flashDone(button) {
    const use = $("use", button);
    if (!use) return;
    const original = button.dataset.icon || use.getAttribute("href");
    button.dataset.icon = original;
    use.setAttribute("href", "#i-check");
    button.classList.add("done");
    clearTimeout(button._doneTimer);
    button._doneTimer = setTimeout(() => {
      use.setAttribute("href", original);
      button.classList.remove("done");
    }, 1200);
  }

  /* ------------------------------------------------- notices and confirms -- */

  function showNotice(text, kind) {
    clearTimeout(noticeTimer);
    dom.notice.textContent = text;
    dom.notice.className = `notice ${kind || "neutral"}`;
    dom.notice.hidden = false;
    // The notice floats over the list, so even errors go away on their own;
    // they just stay long enough to be read. A click dismisses it early.
    noticeTimer = setTimeout(hideNotice, kind === "error" ? 9000 : 3500);
  }

  function hideNotice() {
    clearTimeout(noticeTimer);
    dom.notice.hidden = true;
  }

  function askConfirm(lead, detail, onConfirm) {
    state.confirm = { onConfirm };
    dom.confirmText.replaceChildren(lead);
    if (detail) dom.confirmText.append(el("strong", null, ` ${detail}`));
    dom.confirm.hidden = false;
    dom.confirmOk.focus();
  }

  function askDeleteOne(cookie) {
    const lasting = U.expiryInfo(cookie).session ? " It lasts only until the browser closes." : "";
    askConfirm("Delete the cookie", `“${cookie.name}”?${lasting}`, () => deleteCookie(cookie));
  }

  function askDeleteAll() {
    const count = state.cookies.length;
    if (!count) return showNotice("There are no cookies for this page.", "neutral");
    askConfirm(`Delete all ${pluralize(count, "cookie")} for ${state.site.host}?`, null, deleteAllCookies);
  }

  function closeConfirm() {
    state.confirm = null;
    dom.confirm.hidden = true;
  }

  /* ------------------------------------------------- import and export --- */

  function togglePanel() {
    if (state.transfer) closePanel();
    else openPanel("export");
  }

  function openPanel(tab) {
    if (!state.site || state.busy) return;
    closeConfirm();
    state.transfer = { tab };
    dom.panel.hidden = false;
    dom.body.classList.add("panel-open");
    dom.transfer.classList.add("on");
    showPanel(tab);
  }

  function showPanel(tab) {
    if (!state.transfer) state.transfer = { tab };
    state.transfer.tab = tab;
    for (const button of dom.panel.querySelectorAll("[data-tab]")) {
      button.setAttribute("aria-selected", String(button.dataset.tab === tab));
    }
    for (const body of dom.panel.querySelectorAll("[data-panel]")) {
      body.hidden = body.dataset.panel !== tab;
    }
    if (tab === "export") {
      renderExport();
      // Start at the top: focusing a textarea can leave it scrolled to the
      // end, which for JSON is a lone "]".
      dom.exportText.focus();
      dom.exportText.setSelectionRange(0, 0);
      dom.exportText.scrollTop = 0;
    } else {
      dom.importText.focus();
    }
  }

  function closePanel() {
    state.transfer = null;
    dom.panel.hidden = true;
    dom.body.classList.remove("panel-open");
    dom.transfer.classList.remove("on");
  }

  function renderExport() {
    if (!state.transfer) return;
    if (!state.cookies.length) {
      dom.exportText.value = "";
      dom.exportNote.className = "panel-note";
      dom.exportNote.textContent = `There are no cookies for ${state.site.host} to export.`;
      return;
    }

    const format = U.findExportFormat(dom.exportFormat.value);
    dom.exportText.value = U.serializeCookies(state.cookies, format.value);
    dom.exportNote.className = "panel-note";
    dom.exportNote.textContent = format.lossless
      ? `${pluralize(state.cookies.length, "cookie")}, with every attribute. Paste this back in to restore them.`
      : `${pluralize(state.cookies.length, "cookie")} as a Cookie: header. Only names and values; Secure, expiry, SameSite and the rest are not included.`;
  }

  async function copyExport() {
    if (!dom.exportText.value) return;
    try {
      await navigator.clipboard.writeText(dom.exportText.value);
      dom.exportNote.className = "panel-note ok";
      dom.exportNote.textContent = `Copied ${pluralize(state.cookies.length, "cookie")} to the clipboard.`;
    } catch (_) {
      dom.exportNote.className = "panel-note error";
      dom.exportNote.textContent = "The clipboard is not available here.";
    }
  }

  function downloadExport() {
    const text = dom.exportText.value;
    if (!text) return;
    const format = U.findExportFormat(dom.exportFormat.value);
    const host = state.site.host.replace(/[^\w.-]+/g, "_");

    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = el("a");
    link.href = url;
    link.download = `${host}.cookies.${format.extension}`;
    document.body.append(link);
    link.click();
    link.remove();
    // Give the browser a moment to start the download before dropping the URL.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function setImportNote(text, kind) {
    dom.importNote.className = `panel-note${kind ? ` ${kind}` : ""}`;
    dom.importNote.textContent = text;
  }

  async function runImport() {
    if (!state.transfer || !state.site || state.busy) return;

    const parsed = U.parseImport(dom.importText.value, state.site);
    if (parsed.error) {
      return setImportNote(
        `${parsed.error} Paste exported JSON, or a Cookie: header string such as session=abc; theme=dark.`,
        "error"
      );
    }

    // Everything is validated before anything is written. A paste with one bad
    // cookie is refused as a whole: applying the rest and skipping the bad one
    // would quietly drop cookies, especially with "replace" ticked.
    const drafts = [];
    const problems = [];
    for (const entry of parsed.entries) {
      if (entry.error) {
        problems.push(entry.error);
        continue;
      }
      const { errors } = U.validateDraft(entry.draft, state.site);
      if (errors.length) problems.push(`${entry.draft.name || "(unnamed)"}: ${errors[0].message}`);
      else drafts.push(entry.draft);
    }

    if (problems.length) {
      const others = problems.length - 1;
      return setImportNote(
        `${pluralize(problems.length, "problem")} in that text, so nothing was imported. ${problems[0]}${
          others ? ` (and ${others} more)` : ""
        }`,
        "error"
      );
    }

    setBusy(true);
    const imported = [];
    const failed = [];
    let removed = 0;
    try {
      // Anything the browser refused is not counted as imported, and is left
      // alone by the replace step below.
      for (const draft of drafts) {
        try {
          await Api.setCookie(U.buildDetails(draft, state.site));
          imported.push(draft);
        } catch (error) {
          failed.push(`${draft.name}: ${error.message}`);
        }
      }

      // "Replace" only removes what is left over once everything is in place,
      // so a failure part way through cannot empty the jar.
      if (dom.importReplace.checked) {
        for (const cookie of U.cookiesMissingFrom(imported, state.cookies)) {
          try {
            await Api.removeCookie(cookie);
            removed += 1;
          } catch (error) {
            failed.push(`${cookie.name}: could not be removed (${error.message})`);
          }
        }
      }

      await refreshCookies();

      const summary = [`Imported ${pluralize(imported.length, "cookie")}`];
      if (removed) summary.push(`removed ${pluralize(removed, "cookie")}`);
      if (failed.length) summary.push(`${failed.length} failed: ${failed[0]}`);

      // Only a fully clean run closes the panel; anything to read stays on screen.
      if (failed.length) {
        showNotice(`${summary.join(", ")}.`, "error");
        setImportNote(summary.join(", "), "error");
      } else {
        closePanel();
        showNotice(`${summary.join(", ")}.`, "ok");
      }
    } finally {
      setBusy(false);
    }
  }

  /* ----------------------------------------------------------------- misc -- */

  function defaultTopLevelSite() {
    try {
      return new URL(state.site.url).origin;
    } catch (_) {
      return "";
    }
  }

  /** Cookies created here must land in the store the tab actually uses. */
  function currentStoreId() {
    if (state.cookies.length) return state.cookies[0].storeId;
    return state.storeId || "0";
  }

  /* ----------------------------------------------------------------- init -- */

  function init() {
    cacheDom();
    buildStaticControls();
    storageView = StorageView({ showNotice, askConfirm, closeConfirm, flashDone, setCount });
    state.view = rememberedView();
    paintViews();
    wireEvents();
    watchTab();
    load();
  }

  init();
})();
