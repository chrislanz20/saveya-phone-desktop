import { app, BrowserWindow, Menu, nativeImage, Tray } from "electron";
import * as path from "path";
import { isUpdatePending, getPendingVersion } from "./updater";

interface TrayHandlers {
  onShow: () => void;
  onHide: () => void;
  onQuit: () => void;
  onReload: () => void;
  onReset: () => void;
  onInstallUpdate: () => void;
  getWindow: () => BrowserWindow | null;
}

let tray: Tray | null = null;
let handlers: TrayHandlers | null = null;

function loadTrayIcon(): Electron.NativeImage {
  // The packaged app puts assets next to the resources dir; in dev they live
  // at <repo>/assets. Try both.
  const candidates = [
    path.join(__dirname, "..", "assets", "trayTemplate.png"),
    path.join(process.resourcesPath || "", "assets", "trayTemplate.png"),
    path.join(app.getAppPath(), "assets", "trayTemplate.png"),
  ];
  for (const p of candidates) {
    try {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) {
        // Template image renders correctly in light/dark menu bars.
        img.setTemplateImage(true);
        return img;
      }
    } catch {
      /* try next */
    }
  }
  // Fallback: tiny in-memory placeholder so the tray still appears.
  return nativeImage.createEmpty();
}

// The same glyph with a red dot, for unread things while the window is closed
// (assets/trayUnread*.png). Not a template image — a template is drawn in one
// colour by macOS and the dot would vanish; it is used on Windows only.
function loadUnreadTrayIcon(): Electron.NativeImage | null {
  const candidates = [
    path.join(__dirname, "..", "assets", "trayUnread.png"),
    path.join(process.resourcesPath || "", "assets", "trayUnread.png"),
    path.join(app.getAppPath(), "assets", "trayUnread.png"),
  ];
  for (const p of candidates) {
    try {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    } catch {
      /* try next */
    }
  }
  return null;
}

let unreadCount = 0;
let normalIcon: Electron.NativeImage | null = null;
let unreadIcon: Electron.NativeImage | null | undefined;

/**
 * Show the unread count on the tray: in the hover text everywhere, and as a
 * red dot on the icon on Windows (macOS shows the number on the Dock icon).
 */
export function setTrayUnread(count: number): void {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n === unreadCount) return;
  unreadCount = n;
  applyTrayUnread();
}

// Separate so createTray can apply a count that arrived before the tray existed.
function applyTrayUnread(): void {
  const n = unreadCount;
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(n > 0 ? `SaveYa Phone — ${n} unread` : "SaveYa Phone");
  if (process.platform !== "win32") return;
  if (unreadIcon === undefined) unreadIcon = loadUnreadTrayIcon();
  if (n > 0 && unreadIcon) tray.setImage(unreadIcon);
  else if (normalIcon) tray.setImage(normalIcon);
}

export function createTray(h: TrayHandlers): Tray {
  handlers = h;
  const icon = loadTrayIcon();
  normalIcon = icon;
  tray = new Tray(icon);
  tray.setToolTip("SaveYa Phone");
  applyTrayUnread();
  tray.on("click", () => toggleWindow());
  tray.on("right-click", () => tray?.popUpContextMenu());
  updateTrayMenu(h.getWindow());
  return tray;
}

export function updateTrayMenu(win: BrowserWindow | null): void {
  if (!tray || !handlers) return;
  const visible = !!win && !win.isDestroyed() && win.isVisible();
  const items: Electron.MenuItemConstructorOptions[] = [];
  // A downloaded update waiting to install — give it a prominent one-click apply
  // at the very top, since a tray app rarely gets a true quit on its own.
  if (isUpdatePending()) {
    items.push(
      {
        label: `🔄  Restart to update (v${getPendingVersion()})`,
        click: () => handlers!.onInstallUpdate(),
      },
      { type: "separator" },
    );
  }
  items.push(
    {
      label: visible ? "Hide SaveYa Phone" : "Show SaveYa Phone",
      click: () => (visible ? handlers!.onHide() : handlers!.onShow()),
    },
    {
      label: "Reload",
      click: () => handlers!.onReload(),
    },
    {
      label: "Reset & Reload (fixes black screen)",
      click: () => handlers!.onReset(),
    },
    { type: "separator" },
    {
      label: "About",
      click: () => app.showAboutPanel?.(),
    },
    { type: "separator" },
    {
      label: "Quit SaveYa Phone",
      click: () => handlers!.onQuit(),
    },
  );
  const menu = Menu.buildFromTemplate(items);
  tray.setContextMenu(menu);
}

function toggleWindow(): void {
  if (!handlers) return;
  const win = handlers.getWindow();
  if (!win || win.isDestroyed() || !win.isVisible()) {
    handlers.onShow();
  } else {
    handlers.onHide();
  }
}
