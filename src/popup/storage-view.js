/**
 * Cookie Editor — the local storage tab.
 *
 * Lists, edits, imports and exports the localStorage of the active tab's page.
 * The popup controller (popup.js) owns the header, the tab strip, notices and
 * the confirm bar, and hands them in as `shell`; this file owns everything
 * inside #view-storage. Reads and writes go through `Api.readStorage` and
 * `Api.writeStorage`, which run in the page itself.
 */
(function (global) {
  "use strict";

  const S = StorageUtils;

  /**
   * @param {object} shell
   * @param {Function} shell.showNotice  (text, kind)
   * @param {Function} shell.askConfirm  (lead, detail, onConfirm)
   * @param {Function} shell.closeConfirm
   * @param {Function} shell.flashDone   (button)
   * @param {Function} shell.setCount    (view, text)
   */
  function StorageView(shell) {
    const $ = (selector, root) => (root || document).querySelector(selector);
    const fieldOf = (form, name) => $(`[data-field="${name}"]`, form);
    const pluralize = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    }

    const dom = {
      view: $("#view-storage"),
      filter: $("#storage-filter"),
      filterClear: $("#storage-filter-clear"),
      counts: $("#storage-counts"),
      list: $("#storage-list"),
      add: $("#storage-add"),
      transfer: $("#storage-transfer"),
      panel: $("#storage-panel"),
      exportText: $("#storage-export-text"),
      exportNote: $("#storage-export-note"),
      importText: $("#storage-import-text"),
      importNote: $("#storage-import-note"),
      importReplace: $("#storage-import-replace"),
      itemTemplate: $("#tpl-storage-item"),
      editorTemplate: $("#tpl-storage-editor"),
    };

    const state = {
      /** @type {{tabId: number, site: object}|null} */
      context: null,
      origin: null,
      entries: [],
      byKey: new Map(),
      items: new Map(),
      filter: "",
      rendered: false,
      /** Why the page's storage could not be read, if it could not. */
      error: null,
      /** @type {{mode: "create"|"edit", key: string|null, draft: {key: string, value: string}}|null} */
      editor: null,
      /** @type {{tab: "export"|"import"}|null} */
      transfer: null,
      busy: false,
    };

    let editorForm = null;
    let editorHolder = null;

    /* ------------------------------------------------------------ events -- */

    dom.filter.addEventListener("input", () => {
      state.filter = dom.filter.value;
      applyFilter();
    });
    dom.filterClear.addEventListener("click", () => {
      clearFilter();
      dom.filter.focus();
    });
    dom.add.addEventListener("click", () => openCreate());
    dom.transfer.addEventListener("click", () => (state.transfer ? closePanel() : openPanel("export")));

    for (const tab of dom.panel.querySelectorAll("[data-tab]")) {
      tab.addEventListener("click", () => showPanel(tab.dataset.tab));
    }
    $('[data-act="close-panel"]', dom.panel).addEventListener("click", closePanel);
    $("#storage-export-copy").addEventListener("click", copyExport);
    $("#storage-export-download").addEventListener("click", downloadExport);
    $("#storage-import-go").addEventListener("click", runImport);
    $("#storage-import-clear").addEventListener("click", () => {
      dom.importText.value = "";
      setNote(dom.importNote, "");
      dom.importText.focus();
    });
    dom.importText.addEventListener("input", () => setNote(dom.importNote, ""));

    dom.list.addEventListener("click", onListClick);
    dom.list.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const row = event.target.closest(".row");
      if (!row || event.target !== row) return;
      event.preventDefault();
      openEditor(row.closest(".item").dataset.key);
    });
    dom.list.addEventListener("input", (event) => {
      const form = event.target.closest(".editor");
      if (form) syncEditor(form);
    });
    dom.list.addEventListener("submit", (event) => {
      if (!event.target.closest(".editor")) return;
      event.preventDefault();
      save();
    });

    /* -------------------------------------------------------------- load -- */

    /** Show the storage of `context.site` in `context.tabId`. */
    async function load(context) {
      const previous = state.context;
      state.context = context;
      if (!previous || previous.site.url !== context.site.url || previous.tabId !== context.tabId) {
        // Another page: what was open belonged to the last one.
        closeEditor();
        closePanel();
        state.rendered = false;
      }
      setEnabled(true);
      await refresh();
    }

    /** Forget the page, for a tab whose storage cannot be shown. */
    function reset() {
      closeEditor();
      closePanel();
      state.context = null;
      state.origin = null;
      state.entries = [];
      state.byKey = new Map();
      state.items = new Map();
      state.rendered = false;
      state.error = null;
      setEnabled(false);
      dom.counts.textContent = "";
      shell.setCount("storage", "");
      dom.list.replaceChildren(el("div", "empty loading", "Loading local storage…"));
    }

    async function refresh() {
      const context = state.context;
      if (!context) return;
      let result;
      try {
        result = await Api.readStorage(context.tabId);
      } catch (error) {
        if (state.context !== context) return;
        return showUnavailable(error.message);
      }
      // The popup moved on while the page was answering.
      if (state.context !== context) return;

      const entries = S.toEntries(result.pairs);
      state.origin = result.origin;
      if (state.rendered && !state.error && S.sameEntries(entries, state.entries)) {
        updateCounts();
        return;
      }
      state.error = null;
      state.entries = entries;
      state.rendered = true;
      setEnabled(true);
      renderList();
      if (state.transfer) renderExport();
    }

    function showUnavailable(reason) {
      closeEditor();
      closePanel();
      state.error = reason;
      state.entries = [];
      state.byKey = new Map();
      state.items = new Map();
      state.rendered = true;
      setEnabled(false);
      dom.counts.textContent = "";
      shell.setCount("storage", "");
      const box = el("div", "empty");
      box.append(el("strong", null, "Local storage is not available here"), el("span", null, reason));
      dom.list.replaceChildren(box);
    }

    function setEnabled(enabled) {
      dom.add.disabled = !enabled || state.busy;
      dom.transfer.disabled = !enabled || state.busy;
    }

    /* -------------------------------------------------------------- list -- */

    function renderList() {
      if (state.editor && editorForm) state.editor.draft = readDraft(editorForm);
      const focused =
        editorForm && editorForm.contains(document.activeElement)
          ? document.activeElement.getAttribute("data-field")
          : null;
      unmountEditor();

      state.byKey = new Map();
      state.items = new Map();
      const fragment = document.createDocumentFragment();
      for (const entry of state.entries) {
        const item = dom.itemTemplate.content.firstElementChild.cloneNode(true);
        item.dataset.key = entry.key;
        paintRow(item, entry);
        fragment.append(item);
        state.byKey.set(entry.key, entry);
        state.items.set(entry.key, item);
      }

      if (!state.entries.length) {
        const box = el("div", "empty");
        box.append(
          el("strong", null, "No local storage yet"),
          el("span", null, `Nothing is stored for ${state.origin || state.context.site.host}.`)
        );
        fragment.append(box);
      }

      const noMatches = el("div", "empty no-matches");
      noMatches.hidden = true;
      fragment.append(noMatches);
      dom.list.replaceChildren(fragment);

      // An item being edited that has gone from the page is now a new one.
      if (state.editor && state.editor.mode === "edit" && !state.byKey.has(state.editor.key)) {
        state.editor.mode = "create";
        state.editor.key = null;
      }
      if (state.editor) mountEditor();
      if (focused && editorForm) fieldOf(editorForm, focused).focus();
      applyFilter();
    }

    function paintRow(item, entry) {
      const name = $(".row-name", item);
      name.textContent = entry.key === "" ? "(empty key)" : entry.key;
      name.title = entry.key;

      const compact = S.compactJson(entry.value);
      const value = $(".row-value", item);
      value.textContent = entry.value === "" ? "empty value" : compact || entry.value;
      value.classList.toggle("blank", entry.value === "");
      value.title = entry.value.length > 2000 ? `${entry.value.slice(0, 2000)}…` : entry.value;

      const flags = [];
      if (compact !== null) {
        const badge = el("span", "badge info", "JSON");
        badge.title = "The value is JSON; the editor can format it";
        flags.push(badge);
      }
      $(".row-flags", item).replaceChildren(...flags);

      const size = $(".row-size", item);
      size.textContent = S.formatSize(S.byteSize(entry));
      size.title = "Space this item takes in the site's storage quota";
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
        const match = S.matchesFilter(state.byKey.get(key), state.filter);
        item.hidden = !match;
        if (match) shown += 1;
      }
      const noMatches = $(".no-matches", dom.list);
      if (noMatches) {
        noMatches.hidden = !(shown === 0 && state.entries.length > 0);
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
      const total = state.entries.length;
      const visible = typeof shown === "number" ? shown : total;
      const size = S.formatSize(S.totalSize(state.entries));
      dom.counts.textContent = state.filter.trim()
        ? `${visible} of ${pluralize(total, "item")}`
        : `${pluralize(total, "item")} · ${size}`;
      shell.setCount("storage", String(total));
    }

    function onListClick(event) {
      const item = event.target.closest(".item");
      if (!item) return;
      const action = event.target.closest("[data-act]");
      const key = item.dataset.key;
      const entry = key !== undefined ? state.byKey.get(key) : null;

      if (action) {
        event.stopPropagation();
        switch (action.dataset.act) {
          case "close":
            return closeEditor();
          case "format":
            return toggleFormat();
          case "copy":
            if (entry) copyValue(entry, action);
            return;
          case "duplicate":
            return duplicate();
          case "delete":
            if (entry) {
              openEditor(entry.key);
              askDeleteOne(entry);
            } else if (state.editor && state.editor.key !== null) {
              askDeleteOne(state.byKey.get(state.editor.key));
            }
            return;
          case "edit":
            if (entry) openEditor(entry.key);
            return;
        }
      }

      if (event.target.closest(".editor") || !entry) return;
      if (state.editor && state.editor.key === key) closeEditor();
      else openEditor(key);
    }

    /* ------------------------------------------------------------ editor -- */

    function openEditor(key) {
      const entry = state.byKey.get(key);
      if (!entry) return;
      startEditor({ mode: "edit", key, draft: { key: entry.key, value: entry.value } });
      const item = state.items.get(key);
      if (item && item.scrollIntoView) item.scrollIntoView({ block: "nearest" });
      if (editorForm && editorForm.scrollIntoView) editorForm.scrollIntoView({ block: "nearest" });
      // Quick edit: most edits change the value, so start there.
      focusField("value", true);
    }

    function openCreate(draft) {
      if (!state.context || state.error) return;
      startEditor({ mode: "create", key: null, draft: draft || { key: "", value: "" } });
      dom.list.scrollTop = 0;
      focusField("key", Boolean(draft));
    }

    function duplicate() {
      if (!state.editor || !editorForm) return;
      const draft = readDraft(editorForm);
      openCreate({ key: `${draft.key}-copy`, value: draft.value });
    }

    function startEditor(editor) {
      shell.closeConfirm();
      state.editor = editor;
      mountEditor();
    }

    function closeEditor() {
      if (!state.editor) return;
      state.editor = null;
      unmountEditor();
    }

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
      const editing = state.editor.mode === "edit";
      $(".editor-title", editorForm).textContent = editing ? "Edit item" : "New item";
      for (const act of editorForm.querySelectorAll('[data-act="delete"], [data-act="duplicate"]')) {
        act.hidden = !editing;
      }
      fieldOf(editorForm, "key").value = state.editor.draft.key;
      fieldOf(editorForm, "value").value = state.editor.draft.value;
      syncEditor(editorForm);

      const item = editing && state.items.get(state.editor.key);
      if (item) {
        item.append(editorForm);
        markOpenRow(state.editor.key);
      } else {
        editorHolder = el("div", "item");
        editorHolder.setAttribute("role", "listitem");
        editorHolder.append(editorForm);
        dom.list.prepend(editorHolder);
      }
      fitValue(editorForm);
    }

    function markOpenRow(key) {
      for (const [itemKey, item] of state.items) {
        const row = $(":scope > .row", item);
        row.classList.toggle("open", itemKey === key);
        row.setAttribute("aria-expanded", String(itemKey === key));
      }
    }

    function syncEditor(form) {
      const value = fieldOf(form, "value").value;
      const counter = $("[data-counter]", form);
      counter.textContent = value.length ? `${value.length} chars` : "";
      $('[data-act="format"]', form).hidden = !S.isJson(value);
      for (const node of form.querySelectorAll(".msg")) node.className = "msg";
      for (const node of form.querySelectorAll(".field.invalid")) node.classList.remove("invalid");
    }

    /** Formatted JSON becomes one line again; anything else gets formatted. */
    function toggleFormat() {
      if (!editorForm) return;
      const field = fieldOf(editorForm, "value");
      const pretty = S.formatJson(field.value);
      if (pretty === null) return;
      field.value = field.value === pretty ? S.compactJson(field.value) : pretty;
      syncEditor(editorForm);
      fitValue(editorForm);
      field.focus();
    }

    /** Grow the value box to show what it holds, up to the CSS cap. */
    function fitValue(form) {
      const field = fieldOf(form, "value");
      field.style.height = "auto";
      if (field.scrollHeight) field.style.height = `${field.scrollHeight + 2}px`;
    }

    function focusField(name, selectAll) {
      if (!editorForm) return;
      const node = fieldOf(editorForm, name);
      node.focus();
      if (selectAll) node.select();
    }

    function readDraft(form) {
      return { key: fieldOf(form, "key").value, value: fieldOf(form, "value").value };
    }

    function showError(form, field, text) {
      const node = $(`[data-msg="${field}"]`, form);
      node.className = "msg show error";
      node.textContent = text;
      node.closest(".field").classList.add("invalid");
    }

    /* ------------------------------------------------------------ saving -- */

    function setBusy(busy) {
      state.busy = busy;
      dom.view.classList.toggle("busy", busy);
      setEnabled(Boolean(state.context) && !state.error);
    }

    /** Apply `ops` to the page, then re-read it. */
    async function write(ops) {
      await Api.writeStorage(state.context.tabId, state.origin, ops);
    }

    async function save() {
      const form = editorForm;
      if (!form || state.busy || !state.editor) return;
      const draft = readDraft(form);
      const original = state.editor.key;
      const errors = S.validateItem(draft, state.entries, original);
      if (errors.length) {
        showError(form, errors[0].field, errors[0].message);
        focusField(errors[0].field);
        return;
      }

      const ops = [];
      if (original !== null && original !== draft.key) ops.push({ op: "remove", key: original });
      ops.push({ op: "set", key: draft.key, value: draft.value });

      setBusy(true);
      try {
        await write(ops);
        state.editor = null;
        unmountEditor();
        shell.showNotice("Item saved.", "ok");
        await refresh();
      } catch (error) {
        shell.showNotice(`Could not save the item: ${error.message}`, "error");
      } finally {
        setBusy(false);
      }
    }

    async function remove(ops, done) {
      if (state.busy) return;
      setBusy(true);
      try {
        await write(ops);
        closeEditor();
        shell.showNotice(done, "ok");
        await refresh();
      } catch (error) {
        shell.showNotice(`Could not delete: ${error.message}`, "error");
      } finally {
        setBusy(false);
      }
    }

    function askDeleteOne(entry) {
      if (!entry) return;
      shell.askConfirm("Delete the item", `“${entry.key}”?`, () =>
        remove([{ op: "remove", key: entry.key }], `Deleted “${entry.key}”.`)
      );
    }

    function askDeleteAll() {
      if (!state.context || state.error) return;
      const count = state.entries.length;
      if (!count) return shell.showNotice("There is no local storage for this page.", "neutral");
      shell.askConfirm(`Delete all ${pluralize(count, "item")} in local storage for ${state.origin}?`, null, () =>
        remove([{ op: "clear" }], `Deleted ${pluralize(count, "item")}.`)
      );
    }

    async function copyValue(entry, button) {
      try {
        await navigator.clipboard.writeText(entry.value);
        shell.showNotice(`Copied the value of “${entry.key}”.`, "ok");
        shell.flashDone(button);
      } catch (_) {
        shell.showNotice("The clipboard is not available here.", "error");
      }
    }

    /* ------------------------------------------------ import and export -- */

    function openPanel(tab) {
      if (!state.context || state.error || state.busy) return;
      shell.closeConfirm();
      state.transfer = { tab };
      dom.panel.hidden = false;
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
      dom.transfer.classList.remove("on");
    }

    function setNote(node, text, kind) {
      node.className = `panel-note${kind ? ` ${kind}` : ""}`;
      node.textContent = text;
    }

    function renderExport() {
      if (!state.transfer) return;
      if (!state.entries.length) {
        dom.exportText.value = "";
        setNote(dom.exportNote, `There is no local storage for ${state.origin} to export.`);
        return;
      }
      dom.exportText.value = S.serializeEntries(state.entries);
      setNote(dom.exportNote, `${pluralize(state.entries.length, "item")}. Paste this back in to restore them.`);
    }

    async function copyExport() {
      if (!dom.exportText.value) return;
      try {
        await navigator.clipboard.writeText(dom.exportText.value);
        setNote(dom.exportNote, `Copied ${pluralize(state.entries.length, "item")} to the clipboard.`, "ok");
      } catch (_) {
        setNote(dom.exportNote, "The clipboard is not available here.", "error");
      }
    }

    function downloadExport() {
      const text = dom.exportText.value;
      if (!text) return;
      const host = state.context.site.host.replace(/[^\w.-]+/g, "_");
      const url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
      const link = el("a");
      link.href = url;
      link.download = `${host}.localStorage.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    async function runImport() {
      if (!state.transfer || !state.context || state.busy) return;
      const parsed = S.parseImport(dom.importText.value);
      if (parsed.error) return setNote(dom.importNote, parsed.error, "error");

      const replace = dom.importReplace.checked;
      const ops = replace ? [{ op: "clear" }] : [];
      for (const entry of parsed.entries) ops.push({ op: "set", key: entry.key, value: entry.value });

      setBusy(true);
      try {
        // One write, applied all or nothing in the page.
        await write(ops);
        closePanel();
        shell.showNotice(
          `Imported ${pluralize(parsed.entries.length, "item")}${replace ? ", replacing the rest" : ""}.`,
          "ok"
        );
        await refresh();
      } catch (error) {
        setNote(dom.importNote, `Nothing was imported: ${error.message}`, "error");
      } finally {
        setBusy(false);
      }
    }

    /* ------------------------------------------------------- the shell -- */

    return {
      load,
      reset,
      refresh,
      openCreate: () => openCreate(),
      openPanel,
      askDeleteAll,
      save,
      focusFilter() {
        dom.filter.focus();
        dom.filter.select();
      },
      hasEditor: () => Boolean(state.editor),
      /** Close the innermost open thing; false if nothing was open. */
      escape() {
        if (state.transfer) return (closePanel(), true);
        if (state.editor) return (closeEditor(), true);
        if (dom.filter.value) return (clearFilter(), true);
        return false;
      },
      panelOpen: () => Boolean(state.transfer),
    };
  }

  global.StorageView = StorageView;
})(typeof globalThis !== "undefined" ? globalThis : window);
