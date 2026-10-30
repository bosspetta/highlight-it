// content.js — finds, paints and edits the highlights of the page.
// Highlights are painted with the CSS Custom Highlight API: ranges are
// registered in CSS.highlights and styled by highlights.css, so the page's
// DOM is never modified.
//
// It also runs in iframes. Highlights made in an iframe are stored with the
// top page (so the library groups them with the page being read) and carry
// the iframe's URL in `frame`; each frame only paints its own.
(function () {
  const NS    = "highlight-it";
  const AFFIX = 32;   // chars of context saved before/after each highlight
  const SKIP  = "script, style, noscript, textarea, select, template";
  const NOTE_PREVIEW = 280;   // max chars of a note shown in the hover tooltip

  const isTop = window.top === window;
  let pageUrl   = isTop ? HL.pageKeyUrl(location.href) : null;  // page the highlights are stored under
  let pageTitle = "";                                            // its title, for iframes
  let frameUrl  = isTop ? "" : HL.pageKeyUrl(location.href);    // "" in the top frame
  let page      = null;        // stored record of this page, or null
  let lastColor = HL.DEFAULT_COLOR;
  let missing   = 0;           // highlights not found in the page (yet)
  let retryUntil = 0;          // keep looking for missing ones until then

  // id → Range currently painted. Firefox can't iterate Highlight objects
  // from a content script (Xray wrappers), so this map is the source of
  // truth and the Highlights below are only ever written to.
  const live = new Map();

  function register(name, priority = 0) {
    const highlight = new Highlight();
    highlight.priority = priority;
    CSS.highlights.set(name, highlight);
    return highlight;
  }
  const paints = {};
  for (const c of HL.COLORS) paints[c.id] = register(`${NS}-${c.id}`);
  const notePaint    = register(`${NS}-note`, 1);
  const pendingPaint = register(`${NS}-pending`, 2);
  const focusPaint   = register(`${NS}-focus`, 3);

  // ── Text index ────────────────────────────────────────────
  // The page's text nodes concatenated, so a highlight can be stored as
  // offsets + quoted text and found again on the next visit.

  function buildIndex() {
    const nodes = [], starts = [], parts = [];
    let length = 0;
    if (document.body) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement && !n.parentElement.closest(SKIP)
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
      });
      for (let n; (n = walker.nextNode()); ) {
        nodes.push(n);
        starts.push(length);
        parts.push(n.data);
        length += n.data.length;
      }
    }
    return { nodes, starts, text: parts.join(""), pos: new Map(nodes.map((n, i) => [n, i])) };
  }

  // Text offset of a range boundary.
  function boundaryOffset(index, node, offset) {
    const i = index.pos.get(node);
    if (i !== undefined) return index.starts[i] + offset;
    // Element boundary: offset of the first text node at or after it.
    const point = document.createRange();
    point.setStart(node, offset);
    let lo = 0, hi = index.nodes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      let cmp = -1;
      try { cmp = point.comparePoint(index.nodes[mid], 0); } catch (_) { /* other tree */ }
      if (cmp >= 0) hi = mid; else lo = mid + 1;
    }
    return lo < index.nodes.length ? index.starts[lo] : index.text.length;
  }

  // Text node + offset for a text offset. An end point prefers the end of
  // the previous node over the start of the next one.
  function pointAt(index, offset, isEnd) {
    let lo = 0, hi = index.nodes.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (isEnd ? index.starts[mid] < offset : index.starts[mid] <= offset) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return found < 0 ? null : [index.nodes[found], offset - index.starts[found]];
  }

  function makeRange(index, start, end) {
    const a = pointAt(index, start, false);
    const b = pointAt(index, end, true);
    if (!a || !b) return null;
    try {
      const range = document.createRange();
      range.setStart(a[0], Math.min(a[1], a[0].length));
      range.setEnd(b[0], Math.min(b[1], b[0].length));
      return range;
    } catch (_) {
      return null;
    }
  }

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function sharedTail(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
  }
  function sharedHead(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  }

  // Finds a stored highlight in the page. Whitespace may differ between
  // visits; when the text appears several times, the occurrence whose
  // surrounding text and position best match the saved ones wins.
  function locate(index, hl) {
    const words = HL.collapse(hl.text).split(" ").filter(Boolean);
    if (!words.length) return null;
    const re = new RegExp(words.map(escapeRe).join("\\s+"), "g");
    const text = index.text;
    let best = null, bestScore = -Infinity, tries = 0;
    for (let m; (m = re.exec(text)) && tries++ < 500; ) {
      const start = m.index, end = start + m[0].length;
      const score = sharedTail(text.slice(Math.max(0, start - AFFIX), start), hl.prefix || "")
        + sharedHead(text.slice(end, end + AFFIX), hl.suffix || "")
        - Math.abs(start - (hl.start || 0)) / Math.max(1, text.length);
      if (score > bestScore) { bestScore = score; best = { start, end }; }
    }
    return best;
  }

  // ── Painting ──────────────────────────────────────────────

  // Highlights of this frame.
  const highlights = () => (page ? page.highlights.filter((h) => (h.frame || "") === frameUrl) : []);

  function render() {
    const ids = new Set(highlights().map((h) => h.id));
    for (const id of live.keys()) if (!ids.has(id)) live.delete(id);

    let index = null;
    missing = 0;
    for (const hl of highlights()) {
      const range = live.get(hl.id);
      if (range && !range.collapsed && HL.collapse(range.toString()) === HL.collapse(hl.text)) continue;
      index = index || buildIndex();
      const found = locate(index, hl);
      const fresh = found && makeRange(index, found.start, found.end);
      if (fresh) live.set(hl.id, fresh);
      else { live.delete(hl.id); missing++; }
    }
    paint();
  }

  function paint() {
    for (const highlight of Object.values(paints)) highlight.clear();
    notePaint.clear();
    for (const hl of highlights()) {
      const range = live.get(hl.id);
      if (!range) continue;
      (paints[hl.color] || paints[HL.DEFAULT_COLOR]).add(range);
      if (HL.collapse(hl.note)) notePaint.add(range);
    }
    // The badge counts every highlight of the page, iframes included.
    if (isTop) {
      browser.runtime.sendMessage({ type: "count", count: page ? page.highlights.length : 0 }).catch(() => {});
    }
  }

  async function load() {
    if (!isTop) {
      // An iframe can't read the top page's URL; the background can.
      const top = await browser.runtime.sendMessage({ type: "frame" });
      pageUrl   = top && top.url ? top.url : null;
      pageTitle = top && top.title ? top.title : "";
    }
    if (!pageUrl) return;
    page = await HL.getPage(pageUrl);
    retryUntil = Date.now() + 30000;
    render();
  }

  // Pages that load content late, re-render it, or change URL without
  // reloading (single-page apps) are handled by watching DOM mutations.
  let mutationTimer = 0;
  function onMutations() {
    mutationTimer = 0;
    const url = HL.pageKeyUrl(location.href);
    if (url !== (isTop ? pageUrl : frameUrl)) {
      if (isTop) pageUrl = url; else frameUrl = url;
      live.clear();
      hideFab();
      closePanel();
      load();
      return;
    }
    const broken = [...live.values()].some((r) => r.collapsed);
    if (broken || (missing && Date.now() < retryUntil)) render();
  }

  // ── Creating, editing, revealing ──────────────────────────

  async function create(range, color, extra = {}) {
    if (!pageUrl) return null;
    const index = buildIndex();
    const text = index.text;
    let start = boundaryOffset(index, range.startContainer, range.startOffset);
    let end   = boundaryOffset(index, range.endContainer, range.endOffset);
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (end <= start) return null;

    const now = Date.now();
    const hl = {
      id:      crypto.randomUUID(),
      color,
      text:    text.slice(start, end),
      prefix:  text.slice(Math.max(0, start - AFFIX), start),
      suffix:  text.slice(end, end + AFFIX),
      start,
      name:    (extra.name || "").trim(),
      note:    (extra.note || "").trim(),
      created: now,
      updated: now,
    };
    if (frameUrl) hl.frame = frameUrl;
    const fresh = makeRange(index, start, end);
    if (fresh) live.set(hl.id, fresh);
    page = await HL.addHighlight(pageUrl, isTop ? document.title || location.href : pageTitle, hl);
    paint();
    lastColor = color;
    HL.setPrefs({ lastColor: color });
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
    return hl;
  }

  async function update(id, patch) {
    page = await HL.updateHighlight(pageUrl, id, patch);
    paint();
    if (patch.color) {
      lastColor = patch.color;
      HL.setPrefs({ lastColor: patch.color });
    }
  }

  async function remove(id) {
    live.delete(id);
    page = await HL.removeHighlight(pageUrl, id);
    paint();
  }

  // Scrolls to a highlight and flashes it. Retries for a few seconds in
  // case the page is still loading its content. Returns whether the
  // highlight belongs to this frame.
  function reveal(id, attempt = 0) {
    if (!highlights().some((h) => h.id === id)) return false;
    const range = live.get(id);
    if (!range) {
      if (attempt < 20) setTimeout(() => reveal(id, attempt + 1), 500);
      return true;
    }
    const el = range.startContainer.parentElement;
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    let blinks = 0;
    const blink = () => {
      if (blinks % 2 === 0) focusPaint.add(range); else focusPaint.delete(range);
      if (++blinks < 6) setTimeout(blink, 350);
    };
    setTimeout(blink, 300);
    return true;
  }

  // Highlight under a viewport point, if any (optionally only among `list`).
  function highlightAt(x, y, list = highlights()) {
    if (!list.length) return null;
    const caret = document.caretPositionFromPoint(x, y);
    if (!caret) return null;
    for (const hl of list) {
      const range = live.get(hl.id);
      if (!range) continue;
      let inside = false;
      try { inside = range.isPointInRange(caret.offsetNode, caret.offset); } catch (_) { /* other tree */ }
      if (inside && [...range.getClientRects()].some((r) =>
        x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) return hl;
    }
    return null;
  }

  // ── In-page UI ────────────────────────────────────────────
  // Floating button + panel, rendered inside a closed shadow root so the
  // page can neither restyle nor read them.

  let host = null;
  let ui   = null;
  // The panel's current target: a pending selection ("new") or a highlight ("edit").
  let target = null;   // { mode: "new", range } | { mode: "edit", id }
  let fabRange = null;
  let saveTimer = 0;

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .fab, .panel {
      position: fixed;
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      color: #e8e6f0;
    }
    .fab {
      display: grid; place-items: center;
      width: 32px; height: 32px; padding: 0;
      border: 1px solid #2a2a35; border-radius: 9px;
      background: #17171c;
      box-shadow: 0 4px 14px rgba(0,0,0,.3);
      cursor: pointer;
      transition: transform .1s;
    }
    .fab:hover { border-color: #7b6cff; }
    .fab:active { transform: scale(.94); }
    .fab svg { width: 18px; height: 18px; }
    .panel {
      width: 280px;
      padding: 12px;
      border: 1px solid #2a2a35; border-radius: 12px;
      background: #17171c;
      box-shadow: 0 10px 30px rgba(0,0,0,.4);
      display: flex; flex-direction: column; gap: 8px;
    }
    .row { display: flex; align-items: center; gap: 8px; }
    .spacer { flex: 1; }
    .swatch {
      width: 26px; height: 26px; padding: 0;
      border: 2px solid transparent; border-radius: 50%;
      box-shadow: inset 0 0 0 2px #17171c;
      cursor: pointer;
    }
    .swatch[aria-pressed="true"] { border-color: #e8e6f0; }
    .swatch:focus-visible, button:focus-visible, input:focus-visible, textarea:focus-visible {
      outline: 2px solid #7b6cff; outline-offset: 1px;
    }
    .close {
      width: 24px; height: 24px; padding: 0;
      border: none; border-radius: 6px;
      background: transparent; color: #666680;
      font-size: 18px; line-height: 1; cursor: pointer;
    }
    .close:hover { color: #e8e6f0; background: #2a2a35; }
    input, textarea {
      width: 100%;
      padding: 7px 9px;
      border: 1px solid #2a2a35; border-radius: 7px;
      background: #0e0e11; color: #e8e6f0;
      font: inherit;
      outline: none;
    }
    input:focus, textarea:focus { border-color: #7b6cff; }
    input::placeholder, textarea::placeholder { color: #666680; }
    textarea { min-height: 64px; resize: vertical; }
    .btn {
      padding: 6px 12px;
      border: 1px solid #2a2a35; border-radius: 7px;
      background: transparent; color: #e8e6f0;
      font-family: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
    }
    .btn.primary { border: none; background: linear-gradient(135deg, #7b6cff, #9b8dff); color: #fff; }
    .btn.danger { color: #ff5f5f; }
    .btn.danger:hover { border-color: #ff5f5f; }
    .btn.primary:hover { opacity: .88; }
    .hint { color: #666680; font-size: 11px; }
    .tip {
      position: fixed;
      max-width: 280px;
      padding: 8px 10px;
      border: 1px solid #2a2a35; border-radius: 8px;
      background: #17171c; color: #e8e6f0;
      box-shadow: 0 6px 20px rgba(0,0,0,.35);
      font: 12.5px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
      white-space: pre-wrap; overflow-wrap: anywhere;
      pointer-events: none;
    }
    .tip .hint { display: block; margin-top: 4px; }
    [hidden] { display: none !important; }
  `;

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
  }

  // Marker icon with the three highlight colors.
  function markerIcon() {
    const NS_SVG = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS_SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    HL.COLORS.forEach((c, i) => {
      const bar = document.createElementNS(NS_SVG, "rect");
      bar.setAttribute("x", "3");
      bar.setAttribute("y", String(4 + i * 6));
      bar.setAttribute("width", String(18 - i * 4));
      bar.setAttribute("height", "4");
      bar.setAttribute("rx", "2");
      bar.setAttribute("fill", c.hex);
      svg.append(bar);
    });
    return svg;
  }

  function ensureUi() {
    if (ui) {
      if (!host.isConnected) document.documentElement.append(host);
      return ui;
    }
    host = document.createElement("div");
    host.style.setProperty("all", "initial", "important");
    host.style.setProperty("position", "fixed", "important");
    host.style.setProperty("top", "0", "important");
    host.style.setProperty("left", "0", "important");
    host.style.setProperty("z-index", "2147483647", "important");
    const root = host.attachShadow({ mode: "closed" });

    const fab = el("button", {
      class: "fab", type: "button", title: "Highlight", "aria-label": "Highlight selected text", hidden: "",
      onmousedown: (e) => e.preventDefault(),   // keep the page selection
      onclick: () => { const range = fabRange; hideFab(); if (range) openPanel({ mode: "new", range }); },
    }, [markerIcon()]);

    const swatches = HL.COLORS.map((c) => el("button", {
      class: "swatch", type: "button", title: c.name, "aria-label": c.name, "aria-pressed": "false",
      style: `background:${c.hex}`,
      onclick: () => pickColor(c.id),
    }));
    const close = el("button", { class: "close", type: "button", title: "Close", "aria-label": "Close", text: "×", onclick: () => closePanel() });
    const name  = el("input", { type: "text", placeholder: "Name (optional)", maxlength: "500", oninput: scheduleSave });
    const note  = el("textarea", { placeholder: "Note (optional)", oninput: scheduleSave });
    const del   = el("button", { class: "btn danger", type: "button", text: "Delete", onclick: onDelete });
    const done  = el("button", { class: "btn primary", type: "button", onclick: onDone });
    const hint  = el("span", { class: "hint", text: "Pick a color to highlight" });

    name.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); onDone(); } });
    const panel = el("div", { class: "panel", role: "dialog", "aria-label": "Highlight", hidden: "" }, [
      el("div", { class: "row" }, [...swatches, el("span", { class: "spacer" }), close]),
      name,
      note,
      el("div", { class: "row" }, [del, hint, el("span", { class: "spacer" }), done]),
    ]);
    // Keep the page's own shortcuts from reacting to typing in the panel.
    for (const type of ["keydown", "keyup", "keypress"]) {
      panel.addEventListener(type, (e) => {
        if (e.key === "Escape" && type === "keydown") closePanel();
        e.stopPropagation();
      });
    }

    const tip = el("div", { class: "tip", role: "tooltip", hidden: "" });

    root.append(el("style", { text: STYLE }), fab, panel, tip);
    document.documentElement.append(host);
    ui = { fab, panel, tip, swatches, name, note, del, done, hint };
    return ui;
  }

  const fromUi = (e) => !!host && e.composedPath().includes(host);
  const isOpen = () => !!ui && !ui.panel.hidden;

  function showFab(range) {
    ensureUi();
    fabRange = range;
    ui.fab.hidden = false;
    position();
  }

  function hideFab() {
    fabRange = null;
    if (ui) ui.fab.hidden = true;
  }

  function openPanel(next) {
    flushSave();
    ensureUi();
    target = next;
    const hl = next.mode === "edit" ? highlights().find((h) => h.id === next.id) : null;
    ui.name.value = hl ? hl.name : "";
    ui.name.placeholder = hl ? HL.collapse(hl.text).slice(0, 80) : "Name (optional)";
    ui.note.value = hl ? hl.note : "";
    pendingPaint.clear();
    if (next.mode === "new") pendingPaint.add(next.range);
    syncPanel();
    ui.panel.hidden = false;
    position();
    if (next.mode === "edit") ui.name.focus();
  }

  function syncPanel() {
    const hl = target && target.mode === "edit" ? highlights().find((h) => h.id === target.id) : null;
    const current = hl ? hl.color : lastColor;
    HL.COLORS.forEach((c, i) => ui.swatches[i].setAttribute("aria-pressed", String(c.id === current)));
    ui.del.hidden  = !hl;
    ui.hint.hidden = !!hl;
    ui.done.textContent = hl ? "Done" : "Highlight";
  }

  function closePanel() {
    flushSave();
    target = null;
    pendingPaint.clear();
    if (ui) ui.panel.hidden = true;
  }

  async function pickColor(color) {
    if (!target) return;
    if (target.mode === "new") {
      const hl = await create(target.range, color, { name: ui.name.value, note: ui.note.value });
      if (!hl) { closePanel(); return; }
      pendingPaint.clear();
      target = { mode: "edit", id: hl.id };
    } else {
      await update(target.id, { color });
    }
    syncPanel();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    if (target && target.mode === "edit") saveTimer = setTimeout(flushSave, 400);
  }

  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!ui || !target || target.mode !== "edit") return;
    const hl = highlights().find((h) => h.id === target.id);
    const name = ui.name.value.trim();
    const note = ui.note.value.trim();
    if (hl && (hl.name !== name || hl.note !== note)) update(hl.id, { name, note });
  }

  async function onDone() {
    if (target && target.mode === "new") await pickColor(lastColor);
    closePanel();
  }

  async function onDelete() {
    if (!target || target.mode !== "edit") return;
    const id = target.id;
    target = null;
    closePanel();
    await remove(id);
  }

  // Places the button at the top-right corner of the selection and the
  // panel below it (or above, when there is no room), inside the viewport.
  function position() {
    if (!ui) return;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const clamp = (v, min, max) => Math.max(min, Math.min(v, max));

    if (!ui.fab.hidden && fabRange) {
      const r = fabRange.getBoundingClientRect();
      const top = r.top - 38 >= 4 ? r.top - 38 : r.bottom + 6;
      ui.fab.style.left = clamp(r.right - 16, 4, vw - 36) + "px";
      ui.fab.style.top  = clamp(top, 4, vh - 36) + "px";
    }

    if (!ui.panel.hidden && target) {
      const range = target.mode === "new" ? target.range : live.get(target.id);
      if (!range) return;
      const r = range.getBoundingClientRect();
      const h = ui.panel.offsetHeight;
      const below = r.bottom + 8;
      const top = below + h <= vh - 8 ? below : r.top - h - 8;
      ui.panel.style.left = clamp(r.right - 280, 8, vw - 288) + "px";
      ui.panel.style.top  = clamp(top, 8, Math.max(8, vh - h - 8)) + "px";
    }
  }

  // ── Note tooltip ──────────────────────────────────────────
  // Hovering a highlight that has a note shows the note's beginning.

  let tipId = null;
  let tipTimer = 0;
  let hoverQueued = false;
  let hoverPoint = null;

  function showTip(hl, x, y) {
    ensureUi();
    const note = hl.note.trim();
    const cut = note.length > NOTE_PREVIEW;
    ui.tip.replaceChildren(
      cut ? note.slice(0, NOTE_PREVIEW).trimEnd() + "…" : note,
      cut ? el("span", { class: "hint", text: "Click to read the full note" }) : "",
    );
    ui.tip.hidden = false;
    const vw = document.documentElement.clientWidth;
    const w = ui.tip.offsetWidth, h = ui.tip.offsetHeight;
    const top = y - h - 14 >= 8 ? y - h - 14 : y + 20;
    ui.tip.style.left = Math.max(8, Math.min(x - w / 2, vw - w - 8)) + "px";
    ui.tip.style.top  = top + "px";
  }

  function hideTip() {
    clearTimeout(tipTimer);
    tipId = null;
    if (ui) ui.tip.hidden = true;
  }

  function checkHover() {
    hoverQueued = false;
    const { x, y } = hoverPoint;
    const hl = highlightAt(x, y, highlights().filter((h) => h.note && h.note.trim()));
    if (!hl) { hideTip(); return; }
    if (hl.id === tipId) return;
    hideTip();
    tipId = hl.id;
    tipTimer = setTimeout(() => showTip(hl, x, y), 250);
  }

  document.addEventListener("pointermove", (e) => {
    if (fromUi(e)) return;
    // Not while selecting, or while the button or the panel are shown.
    if (e.buttons || isOpen() || (ui && !ui.fab.hidden)) { if (tipId) hideTip(); return; }
    hoverPoint = { x: e.clientX, y: e.clientY };
    if (!hoverQueued) { hoverQueued = true; requestAnimationFrame(checkHover); }
  }, { capture: true, passive: true });

  // Text selected in the page (not in form fields or editable areas).
  function pageSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const elem = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!elem || !document.body || !document.body.contains(elem)) return null;
    if (elem.isContentEditable || elem.closest("input, textarea")) return null;
    if (!range.toString().trim()) return null;
    return range;
  }

  // ── Events ────────────────────────────────────────────────

  // Pointer events rather than mouse events: pages that cancel pointerdown
  // also suppress mousedown/mouseup.
  document.addEventListener("pointerdown", (e) => {
    if (fromUi(e)) return;
    hideFab();
    hideTip();
    if (isOpen()) closePanel();
  }, true);

  // A click inside an iframe doesn't reach this document, but moves the
  // focus into it.
  window.addEventListener("blur", () => {
    setTimeout(() => {
      const active = document.activeElement;
      if (active && (active.tagName === "IFRAME" || active.tagName === "FRAME")) {
        hideFab();
        if (isOpen()) closePanel();
      }
    }, 0);
  });

  document.addEventListener("pointerup", (e) => {
    if (e.button !== 0 || fromUi(e)) return;
    const { clientX: x, clientY: y } = e;
    const link = e.target instanceof Element && e.target.closest("a[href], button, input, select, textarea, label");
    setTimeout(() => {
      const range = pageSelection();
      if (range) { showFab(range.cloneRange()); return; }
      if (link) return;
      const hl = highlightAt(x, y);
      if (hl) openPanel({ mode: "edit", id: hl.id });
    }, 0);
  }, true);

  document.addEventListener("keyup", (e) => {
    if (fromUi(e) || !e.shiftKey) return;
    const range = pageSelection();
    if (range) showFab(range.cloneRange());
  }, true);

  document.addEventListener("keydown", (e) => {
    hideTip();
    if (e.key !== "Escape") return;
    hideFab();
    if (isOpen()) closePanel();
  }, true);

  document.addEventListener("selectionchange", () => {
    if (fabRange && !pageSelection()) hideFab();
  });

  let positionQueued = false;
  const queuePosition = () => {
    hideTip();
    if (positionQueued) return;
    positionQueued = true;
    requestAnimationFrame(() => { positionQueued = false; position(); });
  };
  window.addEventListener("scroll", queuePosition, { capture: true, passive: true });
  window.addEventListener("resize", queuePosition, { passive: true });

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "highlight") {
      // The shortcut is sent to every frame: only the focused one acts.
      if (msg.focusedOnly && !document.hasFocus()) return;
      const range = pageSelection();
      if (range) { hideFab(); create(range.cloneRange(), HL.isColor(msg.color) ? msg.color : lastColor); }
    } else if (msg.type === "reveal") {
      reveal(msg.id);
    }
  });

  // Changes made elsewhere (sidebar, library, another tab of the same page).
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const key = HL.storageKey(pageUrl);
    if (Object.hasOwn(changes, key)) {
      page = changes[key].newValue || null;
      render();
      if (target && target.mode === "edit" && !highlights().some((h) => h.id === target.id)) closePanel();
      else if (isOpen() && document.activeElement !== host) syncPanel();
    }
    if (Object.hasOwn(changes, HL.PREFS_KEY)) {
      HL.getPrefs().then((prefs) => { lastColor = prefs.lastColor; });
    }
  });

  // ── Start ─────────────────────────────────────────────────

  HL.getPrefs().then((prefs) => { lastColor = prefs.lastColor; });
  load().then(() => {
    if (!pageUrl) return null;
    if (document.body) {
      new MutationObserver(() => {
        if (!mutationTimer) mutationTimer = setTimeout(onMutations, 800);
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    // Asks whether this tab was opened to show a particular highlight.
    return browser.runtime.sendMessage({ type: "ready" });
  }).then((reply) => {
    if (reply && reply.reveal && reveal(reply.reveal)) {
      browser.runtime.sendMessage({ type: "revealed" }).catch(() => {});
    }
  }).catch(() => {});
})();
