// Silent autoupdater wired to GitHub Releases.
//
// Flow:
//   1. On launch (~10s after startup) + every 4 hours, check the
//      `chrislanz20/saveya-phone-desktop` GitHub Releases feed.
//   2. If a newer version is published, download in the background.
//   3. When the download finishes, show a small native notification:
//      "SaveYa Phone updated — restart to apply." User can ignore;
//      next time they quit + relaunch, the new version is installed
//      automatically.
//
// No user interaction required other than eventually relaunching.

import { autoUpdater } from "electron-updater";
import { app } from "electron";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

let firstCheckScheduled = false;
// A downloaded-but-not-yet-installed update. This app lives in the tray and is
// rarely truly quit (closing the window just hides it), so autoInstallOnAppQuit
// alone left staff stuck on old builds for weeks — the recurring Windows
// black-screen reports traced back to this (the fix shipped in v1.0.8/1.0.9 but
// never installed). We now surface a one-click "Restart to update" (tray item +
// clickable notification) so a fix actually lands without needing a full quit.
let pendingVersion: string | null = null;

export function initAutoUpdater(opts: { onUpdateDownloaded?: (version: string) => void } = {}): void {
  // Don't run in dev — autoUpdater requires a packaged app.
  if (!app.isPackaged) {
    console.log("[updater] skipping autoupdater in dev mode");
    return;
  }

  // Silent — never show modal prompts. Just download and notify on completion.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on("checking-for-update", () => {
    console.log("[updater] checking for update");
  });

  autoUpdater.on("update-available", (info) => {
    console.log(`[updater] update available: ${info.version}`);
  });

  autoUpdater.on("update-not-available", () => {
    console.log("[updater] up to date");
  });

  autoUpdater.on("download-progress", (progress) => {
    console.log(`[updater] downloading ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log(`[updater] update downloaded: ${info.version}`);
    pendingVersion = info.version;
    // Hand off to the app to surface a one-click apply (notification + tray
    // item). The update ALSO still installs automatically on the next real quit
    // (autoInstallOnAppQuit stays true), so this only adds faster paths.
    opts.onUpdateDownloaded?.(info.version);
  });

  autoUpdater.on("error", (err) => {
    console.error("[updater] error:", err.message);
  });

  // First check shortly after startup so we don't compete with login + Twilio
  // Voice connection on a cold launch.
  if (!firstCheckScheduled) {
    firstCheckScheduled = true;
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((e) => console.error("[updater] first check failed:", e));
    }, 10_000);
    setInterval(() => {
      autoUpdater.checkForUpdates().catch((e) => console.error("[updater] check failed:", e));
    }, CHECK_INTERVAL_MS);
  }
}

export function isUpdatePending(): boolean {
  return pendingVersion !== null;
}

export function getPendingVersion(): string | null {
  return pendingVersion;
}

// Quit + install the downloaded update, then relaunch. The CALLER must first put
// the app into quitting mode (set main's isQuitting flag) — otherwise the
// window's close handler hides to the tray instead of letting the app exit, and
// the install never runs.
export function installDownloadedUpdate(): void {
  try {
    autoUpdater.quitAndInstall(false, true); // isSilent=false, isForceRunAfter=true
  } catch (e) {
    console.error("[updater] quitAndInstall failed:", e);
  }
}
