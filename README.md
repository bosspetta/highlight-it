# Highlight it

A lightweight Firefox extension to highlight text on any web page. Pick a color, give the highlight a name or a note, and find it again later: highlights are saved per page, painted again every time you come back, and listed in a searchable library.

## Features

- **Three highlight colors:** cyan, yellow and green.
- **Three ways to highlight:**
  - select text and click the **floating button** that appears at the top-right of the selection,
  - right-click the selection › **Highlight text** › color,
  - press **Alt+Shift+H** to use the last color.
- **Names and notes:** highlights without a name are listed by their own text. Highlights with a note get a dotted underline on the page, and hovering them shows the note (up to 280 characters).
- **Edit on the page:** click a highlight to change its color, rename it, add a note or delete it.
- **Highlights come back:** they are painted again when you revisit the page, even if it loads its content late.
- **Library, grouped by page:** search highlights, names, notes and page titles, filter by color, edit and delete. Click a highlight to jump straight to it on the original page.
- **Sidebar:** click the toolbar icon (or press **Alt+Shift+L**) to see the highlights of the current page, or of all pages, while you read.
- **Toolbar badge:** shows how many highlights the current page has.
- **Export / import:** back up your highlights as a JSON file and restore them, or move them to another browser.
- **Privacy-friendly:** pages aren't modified to paint the highlights (they use the CSS Custom Highlight API), and the extension's controls live in a closed shadow root.

## Requirements

- **Firefox 140 or later** (desktop, including Firefox ESR 140).

## Installation

The extension is not yet published on [addons.mozilla.org](https://addons.mozilla.org), so for now it is loaded as a temporary add-on:

1. Download or clone this repository.
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Click **Load Temporary Add-on…** and select the `manifest.json` file in this folder.
4. Optional, but recommended: click the puzzle icon 🧩 in the toolbar and **pin** Highlight it, so the badge is visible.

> **Note:** temporary add-ons are removed when Firefox restarts, **and so are their highlights**. Export them before restarting if you want to keep them while testing.

## Usage

1. Select some text on a page.
2. Click the floating button and pick a color. You can also type a name and a note.
3. Click a highlight on the page to edit or delete it.
4. Click the toolbar icon to open the sidebar, or right-click the icon › **Open highlights library** for the full library (also available from `about:addons` › Highlight it › Options).

Keyboard shortcuts can be changed in `about:addons` › ⚙ › **Manage Extension Shortcuts**.

## Permissions

| Permission | Why it is needed |
|---|---|
| `storage` | Save your highlights and preferences locally. |
| `contextMenus` | Add **Highlight text** to the right-click menu. |
| `<all_urls>` | Find and paint your highlights on the pages you visit, and know which page the active tab shows. |

## Privacy

- **No data collection.** Everything is stored locally in your browser (`storage.local`). Nothing is sent anywhere, and the extension makes no remote requests (fonts are bundled).
- Highlighted text is saved together with a few words of context, so the highlight can be found again on the page.

## Limitations

- Extensions can't run on some pages: Firefox internal pages (`about:*`), addons.mozilla.org and the built-in PDF viewer.
- Text inside iframes can be highlighted; it is listed with the page that contains the iframe. Very small iframes may not have room for the whole panel.
- If a page's text changes, some highlights may no longer be found on it. They are kept in the library, and opening them still tries to scroll to the text.

## Project structure

```
highlight-it/
├── manifest.json     # Extension manifest (Manifest V3)
├── shared.js         # Colors, storage helpers, export/import (used everywhere)
├── background.js     # Context menu, shortcut, toolbar badge, opening highlights
├── content.js        # Finds and paints highlights, floating button and panel
├── highlights.css    # Highlight colors (::highlight)
├── library.html/.js  # Library: full tab and sidebar
├── fonts/            # Bundled fonts + their licenses
└── icons/            # Extension and color icons
```

## License

**Highlight it** © 2026 Enrique Rodríguez Vallejo, licensed under [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/). See [`LICENSE`](LICENSE).

You are free to use, share and adapt this work, including commercially, as long as you give appropriate credit, link to the license and indicate whether changes were made.

### Third-party fonts

The bundled fonts are licensed under the [SIL Open Font License 1.1](https://openfontlicense.org):

| Font | Copyright | License |
|---|---|---|
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | © 2020 The JetBrains Mono Project Authors | [`fonts/OFL-JetBrainsMono.txt`](fonts/OFL-JetBrainsMono.txt) |
| [Syne](https://gitlab.com/bonjour-monde/fonderie/syne-typeface) | © 2019 The Syne Project Authors | [`fonts/OFL-Syne.txt`](fonts/OFL-Syne.txt) |

The font files were obtained from [Fontsource](https://fontsource.org) and are not covered by the CC BY 4.0 license of this project.
