# Better Command Palette (BCP)

**Better Command Palette** enhances Roam Research’s command palette by letting you **pin your favourite commands** so they always appear at the top. You can also sort **unpinned** commands alphabetically if that’s your preference.

This extension is intentionally lightweight, safe, and non-invasive:

- ✅ **Does not modify your graph** (no block/page writes)
- ✅ **Does not override Roam commands**
- ✅ Works entirely at the **UI layer** (DOM decoration + reordering)

<p align="center">
<img src="https://raw.githubusercontent.com/mlava/better-command-palette/f579f7c9fe2be3d7e135b01abfdfa4b8d536dc9d/demo.gif" alt="Demo of Better Command Palette" width="40%" />
</p>

---

## ✨ Features

### ⭐ Pin favourite commands
- Click the star next to any command to pin it
- Pinned commands move to the top instantly
- A divider is shown between pinned and unpinned commands (when both exist)

### 💾 Per-graph persistence
- Your pinned commands are stored in **Roam Depot settings** for this graph
- Pins are restored every time you open the command palette

### 🔤 Sort unpinned commands
- Choose **Roam native**, **A → Z**, or **Z → A** in settings
- Optionally override the sort mode for the current command-palette session using the footer buttons
- **Note:** pinned commands are always shown in A → Z order for stability.

### ⚡ Fast & safe
- Only activates while the command palette is open
- Uses scoped `MutationObserver`s to react to Roam UI changes
- No polling, no key simulation, no DOM cloning

---

## 🖱 Usage

1. Open the command palette (`Cmd–P` / `Ctrl–P`)
2. Click the ☆ star next to any command to pin it
3. Pinned commands appear at the top immediately
4. Click ★ to unpin

The extension also adds three small buttons in the footer of the Command Palette. These allow you to override your global sort preference on a per-session basis.

Footer sort overrides apply only to the current palette session and reset when the palette closes.

---

## ⚙️ Settings

This extension uses **Roam Depot settings**:

- **Sort mode**: `Roam native` / `A → Z` / `Z → A`
- **Pinned commands storage**: saved automatically as you pin/unpin

Clearing the extension’s settings resets all pins and returns sorting to Roam native.

---

## 🧠 How it works

- Watches for the Command Palette modal to appear
- Decorates each command with a star button
- Tracks pinned commands by a stable key derived from:
  - label text, and
  - shortcut (when present)
- Reorders the menu **in place** using Roam’s existing DOM nodes
- Keeps keyboard navigation aligned with the visible order, even when pinned/sorted
- When pins exist, the first pinned command becomes the initial active item on open
- Resets cleanly when the palette closes

---

## ♿ Accessibility

- Stars and sort controls are implemented as real `<button>` elements
- Keyboard focusable
- Uses `aria-label` and `aria-pressed`

---

## 🛡 Safety & compatibility

- Works with built-in commands and extension commands
- Does not interfere with filtering/searching/keyboard navigation
- If Roam changes the palette DOM, the extension fails gracefully (no graph impact)

---

## 📌 Limitations (by design)

- Commands are identified by their **label** (and shortcut when present)
  - If a command’s label changes, you may need to re-pin it
- The “original order” baseline is learned per palette open
  - Roam remains the source of truth for native ordering

These choices keep the extension robust and future-proof.
