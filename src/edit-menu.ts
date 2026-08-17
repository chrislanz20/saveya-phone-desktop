import { BrowserWindow, Menu, MenuItemConstructorOptions, clipboard, shell } from "electron";

// ---------------------------------------------------------------------------
// Cut / Copy / Paste
//
// Electron gives a wrapper app NEITHER of the two things a Windows user
// reaches for when they want to paste:
//
//   1. There is no default right-click context menu. Right-clicking a text
//      field in a stock Electron window shows nothing at all — no Paste, no
//      Copy, no Select All. A browser tab has one; an Electron window does
//      not, and the difference is invisible to the person using it.
//   2. The default application menu (which is what carries the Ctrl+V /
//      Cmd+V accelerators) is easy to lose the moment anything else touches
//      the menu, and this app also runs with `autoHideMenuBar: true`, so
//      even when it exists there is no visible Edit menu to fall back on.
//
// Staff reported "it won't let me copy and paste" — including pasting a
// password into the login field, which is the one place a person is most
// likely to be pasting rather than typing. Nothing in the web app blocks it;
// the wrapper simply never offered the affordance.
//
// So we do both explicitly: a real context menu on every right-click, and an
// application menu that pins the standard edit roles (and therefore their
// accelerators) rather than relying on Electron's default surviving.
// ---------------------------------------------------------------------------

/**
 * Install the application menu.
 *
 * The window keeps `autoHideMenuBar: true`, so on Windows/Linux this changes
 * nothing visually (Alt still reveals it) — its job is to guarantee the
 * Ctrl+V / Ctrl+C / Ctrl+X / Ctrl+A accelerators are bound. On macOS it also
 * restores the standard app menu, which is where Cmd+Q and Cmd+V live.
 */
export function installApplicationMenu(appName: string): void {
  const isMac = process.platform === "darwin";

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: appName,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: "&File",
      submenu: [isMac ? { role: "close" } : { role: "quit" }],
    },
    {
      label: "&Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        // Pasting into a plain <input> should not carry styling from wherever
        // the text was copied (Outlook, Word). The web app's fields are plain
        // text, so this is belt-and-braces, but it costs nothing and it is
        // what a user expects from "Paste".
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { type: "separator" },
        { role: "selectAll" },
      ],
    },
    {
      label: "&View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "&Window",
      submenu: isMac
        ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }]
        : [{ role: "minimize" }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Attach a right-click context menu to a window's web contents.
 *
 * Items are enabled off Chromium's own `editFlags` for the element that was
 * clicked, so Paste is greyed out in a non-editable spot instead of silently
 * doing nothing — the failure mode we are fixing is precisely a control that
 * looks available and isn't.
 *
 * Re-attaching on navigation is unnecessary: `context-menu` is a webContents
 * event and survives every in-app navigation and reload.
 */
export function attachContextMenu(win: BrowserWindow): void {
  win.webContents.on("context-menu", (_event, params) => {
    const flags = params.editFlags;
    const hasSelection = params.selectionText.trim().length > 0;
    const items: MenuItemConstructorOptions[] = [];

    // Spelling suggestions first, the way every native text field orders them.
    if (params.isEditable && params.misspelledWord && params.dictionarySuggestions.length > 0) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        items.push({
          label: suggestion,
          click: () => win.webContents.replaceMisspelling(suggestion),
        });
      }
      items.push({ type: "separator" });
    }

    if (params.isEditable || hasSelection) {
      items.push(
        { label: "Cut", role: "cut", enabled: params.isEditable && flags.canCut },
        { label: "Copy", role: "copy", enabled: flags.canCopy },
        { label: "Paste", role: "paste", enabled: params.isEditable && flags.canPaste },
        { label: "Select All", role: "selectAll", enabled: flags.canSelectAll },
      );
    }

    // Right-clicking a link should offer to copy it — staff share recording
    // and share links out of this app constantly.
    if (params.linkURL) {
      if (items.length > 0) items.push({ type: "separator" });
      items.push(
        {
          label: "Copy Link",
          click: () => clipboard.writeText(params.linkURL),
        },
        {
          label: "Open Link in Browser",
          click: () => {
            if (params.linkURL.startsWith("http://") || params.linkURL.startsWith("https://")) {
              shell.openExternal(params.linkURL);
            }
          },
        },
      );
    }

    if (items.length === 0) return;

    Menu.buildFromTemplate(items).popup({ window: win });
  });
}
