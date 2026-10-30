// background.js — context menu, keyboard shortcut, toolbar button/badge,
// and opening highlights from the library.
(function () {
  const REVEAL_PREFIX = "reveal:";   // storage.session: tab → highlight to show

  // ── Context menu ──────────────────────────────────────────
  // Recreated on install and on startup: the background is an event page.
  function createMenus() {
    browser.contextMenus.removeAll().then(() => {
      browser.contextMenus.create({ id: "highlight", title: "Highlight text", contexts: ["selection"] });
      for (const c of HL.COLORS) {
        browser.contextMenus.create({
          id: "color:" + c.id,
          parentId: "highlight",
          title: c.name,
          contexts: ["selection"],
          icons: { 16: `icons/swatch-${c.id}.svg` },
        });
      }
      browser.contextMenus.create({ id: "library", title: "Open highlights library", contexts: ["action"] });
    });
  }
  browser.runtime.onInstalled.addListener(createMenus);
  browser.runtime.onStartup.addListener(createMenus);

  browser.contextMenus.onClicked.addListener((info, tab) => {
    const id = String(info.menuItemId);
    if (id === "library") browser.runtime.openOptionsPage();
    else if (id.startsWith("color:") && tab) {
      browser.tabs.sendMessage(tab.id, { type: "highlight", color: id.slice(6) }, { frameId: info.frameId || 0 })
        .catch(() => {});
    }
  });

  // ── Keyboard shortcut ─────────────────────────────────────
  browser.commands.onCommand.addListener(async (command) => {
    if (command !== "highlight-selection") return;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const { lastColor } = await HL.getPrefs();
    // Sent to every frame; the focused one highlights its selection.
    browser.tabs.sendMessage(tab.id, { type: "highlight", color: lastColor, focusedOnly: true }).catch(() => {});
  });

  // ── Toolbar button: toggles the sidebar ───────────────────
  browser.action.onClicked.addListener(() => {
    browser.sidebarAction.toggle();
  });
  browser.action.setBadgeBackgroundColor({ color: "#7b6cff" });
  browser.action.setBadgeTextColor({ color: "#ffffff" });

  // ── Opening a highlight from the library ──────────────────
  // Reuses a tab that already shows the page; otherwise opens a new one and
  // remembers which highlight to reveal once its content script is ready.
  async function openHighlight(url, id) {
    const tabs = await browser.tabs.query({});
    const [current] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    const matches = tabs.filter((t) => t.url && HL.pageKeyUrl(t.url) === url);
    const tab = matches.find((t) => current && t.windowId === current.windowId) || matches[0];

    if (tab) {
      await browser.tabs.update(tab.id, { active: true });
      await browser.windows.update(tab.windowId, { focused: true });
      // Every frame gets it; the one holding the highlight reveals it.
      if (id) browser.tabs.sendMessage(tab.id, { type: "reveal", id }).catch(() => {});
      return;
    }

    let target = url;
    if (id) {
      const page = await HL.getPage(url);
      const hl = page && page.highlights.find((h) => h.id === id);
      if (hl) target = HL.fragmentUrl(url, hl.text);
    }
    const created = await browser.tabs.create({ url: target, index: current ? current.index + 1 : undefined });
    if (id) await browser.storage.session.set({ [REVEAL_PREFIX + created.id]: id });
  }

  browser.tabs.onRemoved.addListener((tabId) => {
    browser.storage.session.remove(REVEAL_PREFIX + tabId);
  });

  browser.runtime.onMessage.addListener((msg, sender) => {
    const tabId = sender.tab && sender.tab.id;

    if (msg.type === "count" && tabId !== undefined) {
      browser.action.setBadgeText({ tabId, text: msg.count ? String(msg.count) : "" }).catch(() => {});
      return;
    }

    // Every frame asks; the entry is removed once the frame holding the
    // highlight reports it revealed it.
    if (msg.type === "ready" && tabId !== undefined) {
      const key = REVEAL_PREFIX + tabId;
      return browser.storage.session.get(key).then((result) => ({ reveal: result[key] || null }));
    }

    if (msg.type === "revealed" && tabId !== undefined) {
      browser.storage.session.remove(REVEAL_PREFIX + tabId);
      return;
    }

    // An iframe asks which page it is in: highlights are stored with the top page.
    if (msg.type === "frame" && sender.tab) {
      const url = sender.tab.url || "";
      return Promise.resolve(/^(https?|file):/.test(url)
        ? { url: HL.pageKeyUrl(url), title: sender.tab.title || url }
        : {});
    }

    if (msg.type === "open") {
      return openHighlight(msg.url, msg.id);
    }
  });
})();
