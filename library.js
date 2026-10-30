// library.js — the highlights library, grouped by page. The same page runs
// as a full tab (library.html, also the add-on's options page) and in the
// sidebar (library.html?view=sidebar), where it can be limited to the
// page of the active tab.
(function () {
  const sidebar = new URLSearchParams(location.search).get("view") === "sidebar";
  document.body.classList.toggle("sidebar", sidebar);

  const $ = (sel) => document.querySelector(sel);

  const state = {
    pages:      [],
    query:      "",
    colors:     new Set(),             // empty = all colors
    scope:      sidebar ? "page" : "all",
    currentUrl: null,                  // page of the active tab (sidebar)
    editing:    null,                  // id of the highlight being edited
    confirming: null,                  // "hl:<id>" or "page:<url>" awaiting confirmation
  };

  $("#btn-export").hidden = sidebar;
  $("#btn-import").hidden = sidebar;
  $("#btn-full").hidden   = !sidebar;
  $("#scope").hidden      = !sidebar;

  // ── Helpers ───────────────────────────────────────────────

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    node.append(...children);
    return node;
  }

  function hostOf(url) {
    try {
      const u = new URL(url);
      return u.protocol === "file:" ? u.pathname.split("/").pop() || "file" : u.hostname;
    } catch (_) {
      return url;
    }
  }

  const formatDate = (ts) => new Date(ts).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" });

  let toastTimer = 0;
  function toast(message, error = false) {
    const box = $("#toast");
    box.textContent = message;
    box.classList.toggle("error", error);
    box.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.remove("show"), 2600);
  }

  function open(url, id) {
    browser.runtime.sendMessage({ type: "open", url, id }).catch(() => toast("Could not open the page", true));
  }

  // ── Rendering ─────────────────────────────────────────────

  function matches(hl, page, q) {
    if (state.colors.size && !state.colors.has(hl.color)) return false;
    if (!q) return true;
    return [hl.text, hl.name, hl.note, page.title, page.url].join("\n").toLowerCase().includes(q);
  }

  function render() {
    const q = state.query.trim().toLowerCase();
    const pages = state.pages
      .filter((p) => state.scope === "all" || p.url === state.currentUrl)
      .sort((a, b) => (b.updated || 0) - (a.updated || 0));

    const groups = [];
    let count = 0;
    for (const page of pages) {
      const items = page.highlights
        .filter((hl) => matches(hl, page, q))
        .sort((a, b) => (a.start || 0) - (b.start || 0));
      if (!items.length) continue;
      count += items.length;
      groups.push(renderGroup(page, items));
    }

    const total = state.pages.reduce((n, p) => n + p.highlights.length, 0);
    const filtered = q || state.colors.size;
    $("#stats").textContent = state.scope === "page"
      ? (count ? `${count} highlight${count === 1 ? "" : "s"} on this page` : "")
      : `${filtered ? count + " of " : ""}${total} highlight${total === 1 ? "" : "s"} · ${state.pages.length} page${state.pages.length === 1 ? "" : "s"}`;

    $("#list").replaceChildren(...(groups.length ? groups : [renderEmpty(filtered, total)]));
  }

  function renderEmpty(filtered, total) {
    let title = "No highlights yet";
    let text  = "Select text on any page and click the floating button, or right-click › Highlight text.";
    if (filtered) {
      title = "Nothing found";
      text  = "Try another search or color.";
    } else if (state.scope === "page") {
      title = state.currentUrl ? "No highlights on this page" : "Highlights aren't available here";
      text  = state.currentUrl
        ? "Select some text to highlight it."
        : "Firefox doesn't let extensions run on this kind of page.";
      if (total) text += ` You have ${total} highlight${total === 1 ? "" : "s"} in “All pages”.`;
    }
    return el("div", { class: "empty" }, [el("strong", { text: title }), el("span", { text })]);
  }

  function renderGroup(page, items) {
    const key = "page:" + page.url;
    const head = state.confirming === key
      ? el("div", { class: "group-head" }, [renderConfirm(
        `Delete all ${page.highlights.length} highlights of this page?`,
        async () => { await HL.removePage(page.url); toast("Page highlights deleted"); },
      )])
      : el("div", { class: "group-head" }, [
        el("div", { class: "group-info" }, [
          el("button", { class: "group-title", type: "button", title: page.url, text: page.title || page.url,
            onclick: () => open(page.url) }),
          el("div", { class: "group-host", text: `${hostOf(page.url)} · ${page.highlights.length}` }),
        ]),
        el("div", { class: "item-actions" }, [
          el("button", { class: "btn icon", type: "button", title: "Delete all highlights of this page",
            "aria-label": "Delete all highlights of this page", text: "✕",
            onclick: () => { state.confirming = key; render(); } }),
        ]),
      ]);

    return el("section", { class: "group" }, [
      head,
      el("ul", { class: "items" }, items.map((hl) => renderItem(page, hl))),
    ]);
  }

  function renderItem(page, hl) {
    const item = el("li", { class: "item", style: `--c:${HL.colorHex(hl.color)}` });

    if (state.editing === hl.id) {
      item.append(renderEdit(page, hl));
      return item;
    }

    if (state.confirming === "hl:" + hl.id) {
      item.append(renderConfirm("Delete this highlight?", async () => {
        await HL.removeHighlight(page.url, hl.id);
        toast("Highlight deleted");
      }));
      return item;
    }

    const named = !!HL.collapse(hl.name);
    item.append(
      el("button", { class: "item-main", type: "button", title: "Go to highlight", onclick: () => open(page.url, hl.id) }, [
        el("span", { class: "item-title", text: HL.displayName(hl) }),
        named ? el("span", { class: "item-quote", text: HL.collapse(hl.text) }) : "",
        HL.collapse(hl.note) ? el("span", { class: "item-note", text: hl.note }) : "",
        el("span", { class: "item-meta", text: formatDate(hl.created) }),
      ]),
      el("div", { class: "item-actions" }, [
        el("button", { class: "btn icon", type: "button", title: "Edit", "aria-label": "Edit", text: "✎",
          onclick: () => { state.editing = hl.id; state.confirming = null; render(); } }),
        el("button", { class: "btn icon", type: "button", title: "Delete", "aria-label": "Delete", text: "✕",
          onclick: () => { state.confirming = "hl:" + hl.id; render(); } }),
      ]),
    );
    return item;
  }

  function renderEdit(page, hl) {
    let color = hl.color;
    const swatches = HL.COLORS.map((c) => el("button", {
      class: "swatch", type: "button", title: c.name, "aria-label": c.name,
      "aria-pressed": String(c.id === color), style: `background:${c.hex}`,
      onclick: () => {
        color = c.id;
        swatches.forEach((s, i) => s.setAttribute("aria-pressed", String(HL.COLORS[i].id === color)));
      },
    }));
    const name = el("input", { type: "text", placeholder: HL.collapse(hl.text).slice(0, 80), maxlength: "500" });
    const note = el("textarea", { placeholder: "Note (optional)" });
    name.value = hl.name;
    note.value = hl.note;

    const close = () => { state.editing = null; render(); };
    const save = async () => {
      await HL.updateHighlight(page.url, hl.id, { color, name: name.value.trim(), note: note.value.trim() });
      close();
      toast("Saved");
    };
    const form = el("div", { class: "edit" }, [
      el("div", { class: "row" }, swatches),
      name,
      note,
      el("div", { class: "row" }, [
        el("span", { class: "spacer" }),
        el("button", { class: "btn", type: "button", text: "Cancel", onclick: close }),
        el("button", { class: "btn primary", type: "button", text: "Save", onclick: save }),
      ]),
    ]);
    form.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
      else if (e.key === "Enter" && (e.target === name || e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
    });
    requestAnimationFrame(() => name.focus());
    return form;
  }

  function renderConfirm(message, onConfirm) {
    const cancel = () => { state.confirming = null; render(); };
    return el("div", { class: "confirm" }, [
      el("span", { text: message }),
      el("button", { class: "btn", type: "button", text: "Cancel", onclick: cancel }),
      el("button", { class: "btn danger", type: "button", text: "Delete",
        onclick: async () => { state.confirming = null; await onConfirm(); render(); } }),
    ]);
  }

  // ── Toolbar ───────────────────────────────────────────────

  $("#search").addEventListener("input", (e) => { state.query = e.target.value; render(); });

  $("#scope").addEventListener("click", (e) => {
    const button = e.target.closest("button[data-scope]");
    if (!button) return;
    state.scope = button.dataset.scope;
    for (const b of $("#scope").children) b.setAttribute("aria-pressed", String(b === button));
    render();
  });

  for (const c of HL.COLORS) {
    const button = el("button", {
      class: "swatch", type: "button", title: `Only ${c.name.toLowerCase()}`, "aria-label": `Filter ${c.name}`,
      "aria-pressed": "false", style: `background:${c.hex}`,
      onclick: () => {
        if (state.colors.has(c.id)) state.colors.delete(c.id); else state.colors.add(c.id);
        button.setAttribute("aria-pressed", String(state.colors.has(c.id)));
        render();
      },
    });
    $("#filters").append(button);
  }

  $("#btn-full").addEventListener("click", () => browser.runtime.openOptionsPage());

  // ── Export / import ───────────────────────────────────────

  $("#btn-export").addEventListener("click", async () => {
    const data = await HL.exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = el("a", { href: url, download: `highlight-it-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $("#btn-import").addEventListener("click", () => $("#import-file").click());

  $("#import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const { added, skipped } = await HL.importData(JSON.parse(await file.text()));
      toast(`Imported ${added} highlight${added === 1 ? "" : "s"}${skipped ? ` (${skipped} already there)` : ""}`);
    } catch (err) {
      toast(err instanceof SyntaxError ? "This file is not valid JSON" : err.message, true);
    }
  });

  // ── Data ──────────────────────────────────────────────────

  async function loadPages() {
    state.pages = await HL.getAllPages();
    // Don't wipe a form the user is typing in; it renders again on close.
    if (!state.editing) render();
  }

  async function loadCurrentTab() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    state.currentUrl = tab && tab.url && /^(https?|file):/.test(tab.url) ? HL.pageKeyUrl(tab.url) : null;
    render();
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.keys(changes).some((key) => key.startsWith(HL.PAGE_PREFIX))) loadPages();
  });

  if (sidebar) {
    browser.tabs.onActivated.addListener(loadCurrentTab);
    browser.tabs.onUpdated.addListener((tabId, info, tab) => {
      if (info.url && tab.active) loadCurrentTab();
    }, { properties: ["url"] });
    loadCurrentTab();
  }
  loadPages();
})();
