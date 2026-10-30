// shared.js — constants and storage helpers shared by the background,
// the content script and the library/sidebar page.
//
// Storage layout (browser.storage.local):
//   "page:<url>" → { url, title, created, updated, highlights: [Highlight] }
//   "prefs"      → { lastColor }
// One key per page keeps writes small; a page record is removed when its
// last highlight is deleted.
const HL = (() => {
  const COLORS = [
    { id: "cyan",   name: "Cyan",   hex: "#00F7FF" },
    { id: "yellow", name: "Yellow", hex: "#FCFF00" },
    { id: "green",  name: "Green",  hex: "#7FFF00" },
  ];
  const DEFAULT_COLOR = "yellow";
  const PAGE_PREFIX   = "page:";
  const PREFS_KEY     = "prefs";

  // Query parameters that only track the visit and don't change the content.
  const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src)$/i;

  const isColor = (id) => COLORS.some((c) => c.id === id);
  const colorHex = (id) => (COLORS.find((c) => c.id === id) || COLORS[1]).hex;

  // The URL that identifies a page: no #hash and no tracking parameters.
  function pageKeyUrl(href) {
    try {
      const url = new URL(href);
      url.hash = "";
      for (const key of [...url.searchParams.keys()]) {
        if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
      }
      return url.href;
    } catch (_) {
      return href;
    }
  }

  const storageKey = (url) => PAGE_PREFIX + url;

  function collapse(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  // Name shown in lists: the custom name, or the highlighted text itself.
  function displayName(hl) {
    return collapse(hl.name) || collapse(hl.text);
  }

  // URL with a text fragment (#:~:text=) as a fallback: Firefox scrolls to
  // the text natively even if the extension can't re-anchor the highlight.
  function fragmentUrl(url, text) {
    const words = collapse(text).split(" ");
    const enc = (s) => encodeURIComponent(s).replace(/-/g, "%2D").replace(/,/g, "%2C");
    const directive = words.length > 10
      ? enc(words.slice(0, 5).join(" ")) + "," + enc(words.slice(-5).join(" "))
      : enc(words.join(" "));
    return url + (url.includes("#") ? "" : "#") + ":~:text=" + directive;
  }

  // ── Pages ─────────────────────────────────────────────────

  async function getPage(url) {
    const key = storageKey(url);
    const result = await browser.storage.local.get(key);
    return result[key] || null;
  }

  async function getAllPages() {
    const all = await browser.storage.local.get(null);
    return Object.keys(all)
      .filter((key) => key.startsWith(PAGE_PREFIX))
      .map((key) => all[key]);
  }

  async function savePage(page) {
    const key = storageKey(page.url);
    if (page.highlights.length) await browser.storage.local.set({ [key]: page });
    else await browser.storage.local.remove(key);
    return page.highlights.length ? page : null;
  }

  async function addHighlight(url, title, hl) {
    const now = Date.now();
    const page = (await getPage(url)) || { url, title, created: now, highlights: [] };
    page.title = title || page.title || url;
    page.updated = now;
    page.highlights.push(hl);
    return savePage(page);
  }

  async function updateHighlight(url, id, patch) {
    const page = await getPage(url);
    const hl = page && page.highlights.find((h) => h.id === id);
    if (!hl) return page;
    Object.assign(hl, patch, { updated: Date.now() });
    page.updated = hl.updated;
    return savePage(page);
  }

  async function removeHighlight(url, id) {
    const page = await getPage(url);
    if (!page) return null;
    page.highlights = page.highlights.filter((h) => h.id !== id);
    page.updated = Date.now();
    return savePage(page);
  }

  async function removePage(url) {
    await browser.storage.local.remove(storageKey(url));
  }

  // ── Preferences ───────────────────────────────────────────

  async function getPrefs() {
    const result = await browser.storage.local.get(PREFS_KEY);
    const prefs = result[PREFS_KEY] || {};
    return { lastColor: isColor(prefs.lastColor) ? prefs.lastColor : DEFAULT_COLOR };
  }

  async function setPrefs(patch) {
    const prefs = await getPrefs();
    await browser.storage.local.set({ [PREFS_KEY]: { ...prefs, ...patch } });
  }

  // ── Export / import ───────────────────────────────────────

  async function exportData() {
    return {
      app: "highlight-it",
      version: 1,
      exported: new Date().toISOString(),
      pages: await getAllPages(),
    };
  }

  const str = (value, max = 100000) => (typeof value === "string" ? value.slice(0, max) : "");
  const num = (value, fallback) => (Number.isFinite(value) ? value : fallback);

  function cleanHighlight(raw) {
    if (!raw || typeof raw !== "object" || !str(raw.text).trim()) return null;
    const now = Date.now();
    return {
      id:      str(raw.id, 100) || crypto.randomUUID(),
      color:   isColor(raw.color) ? raw.color : DEFAULT_COLOR,
      text:    str(raw.text),
      prefix:  str(raw.prefix, 200),
      suffix:  str(raw.suffix, 200),
      start:   num(raw.start, 0),
      name:    str(raw.name, 500),
      note:    str(raw.note, 20000),
      ...(str(raw.frame) ? { frame: str(raw.frame, 4000) } : {}),
      created: num(raw.created, now),
      updated: num(raw.updated, now),
    };
  }

  // Merges an export into the stored data. Highlights already present (same
  // id) are kept as they are; only new ones are added.
  async function importData(data) {
    if (!data || data.app !== "highlight-it" || !Array.isArray(data.pages)) {
      throw new Error("This file is not a Highlight it export.");
    }
    let added = 0;
    let skipped = 0;
    for (const raw of data.pages) {
      if (!raw || !/^(https?|file):/i.test(str(raw.url))) continue;
      const url = pageKeyUrl(raw.url);
      const now = Date.now();
      const page = (await getPage(url)) ||
        { url, title: str(raw.title, 1000) || url, created: num(raw.created, now), highlights: [] };
      const ids = new Set(page.highlights.map((h) => h.id));
      for (const item of Array.isArray(raw.highlights) ? raw.highlights : []) {
        const hl = cleanHighlight(item);
        if (!hl || ids.has(hl.id)) { skipped++; continue; }
        ids.add(hl.id);
        page.highlights.push(hl);
        added++;
      }
      page.updated = Math.max(num(page.updated, 0), ...page.highlights.map((h) => h.updated));
      await savePage(page);
    }
    return { added, skipped };
  }

  return {
    COLORS, DEFAULT_COLOR, PAGE_PREFIX, PREFS_KEY,
    isColor, colorHex, pageKeyUrl, storageKey, collapse, displayName, fragmentUrl,
    getPage, getAllPages, addHighlight, updateHighlight, removeHighlight, removePage,
    getPrefs, setPrefs, exportData, importData,
  };
})();
