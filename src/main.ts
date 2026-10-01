import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  Notification,
  powerMonitor,
  session,
  shell,
} from "electron";
import * as path from "path";
import { createTray, updateTrayMenu, setTrayUnread } from "./tray";
import { initAutoUpdater, installDownloadedUpdate } from "./updater";
import {
  disableGpuAndRelaunch,
  isGpuDisabled,
  markCleanShutdown,
  reconcileStartup,
  relaunchWithCacheWipe,
} from "./recovery";
import { log } from "./logger";
import { attachContextMenu, installApplicationMenu } from "./edit-menu";

// Render via software compositing on Windows (and on any machine a prior
// session pinned after repeated black screens). Office Windows PCs — older
// Intel iGPUs, RDP / virtualized sessions, stale drivers — routinely fail to
// composite Chromium's GPU output, leaving a pure-black window that survives
// restarts and cache wipes and that the reactive watchdog can't reliably even
// detect (capturePage is itself GPU-dependent). A phone dashboard gains nothing
// from the GPU, so trading it for a bulletproof paint is the right call. Must
// run before app.ready — this is the only point Electron honors it.
if (process.platform === "win32" || isGpuDisabled()) {
  app.disableHardwareAcceleration();
}

// Prevent the OS from throttling background renderers when the window is hidden.
// Twilio Voice WebSocket / Notification timers must keep running in the tray.
app.commandLine.appendSwitch(
  "disable-features",
  "CalculateNativeWinOcclusion,IntensiveWakeUpThrottling"
);
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

// Allow the renderer to use the microphone without an extra OS prompt loop.
app.commandLine.appendSwitch("enable-features", "WebRTC");

const APP_URL = "https://saveya-phone-platform.vercel.app";

// URLs are only ever logged host+path — query strings can carry tokens or
// call/caller identifiers and must never land in a log file on disk.
function stripQuery(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<unparseable-url>";
  }
}
const ERROR_PAGE = path.join(__dirname, "..", "assets", "connection-error.html");
const SINGLE_INSTANCE = app.requestSingleInstanceLock();

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
// Set when the renderer crashes or did-fail-load fires, so we know the next
// successful did-finish-load is a recovery and don't treat a benign in-app
// navigation as one.
let isShowingErrorPage = false;

// ---------------------------------------------------------------------------
// Call-active signal (renderer -> main)
//
// The recovery ladder below was built call-unaware: a wake reload, a
// black-screen reload or an unresponsive-triggered recover() tears down the
// renderer — and with it any live Twilio call. The web app now tells us when
// a call is ringing/connected (saveya:call-active true, re-sent every ~30s as
// a heartbeat) and when it's over (false), so the SOFT triggers can defer
// instead of killing a call a staffer is on.
//
// The TTL is the safety net for every way the "false" can get lost: renderer
// reloads mid-call, an unresponsive renderer stops heartbeating, an old web
// deploy that never sends the signal at all. If the flag hasn't been
// refreshed within the TTL we treat the call as over and recover normally —
// so the worst case is a bounded delay, never a permanently wedged watchdog.
// A shell running against a web build without the signal never sets the flag
// and behaves exactly as before.
// ---------------------------------------------------------------------------
const CALL_ACTIVE_TTL_MS = 90000; // 3 missed heartbeats == call presumed dead
let callActiveFlag = false;
let callActiveAt = 0;
// Set whenever a recovery action was suppressed/deferred because of a live
// call — the call-ended transition uses it to re-run the health check so a
// genuinely broken window still gets fixed right after the call.
let suppressedDuringCall = false;

function isCallActive(): boolean {
  return callActiveFlag && Date.now() - callActiveAt < CALL_ACTIVE_TTL_MS;
}

function loadConnectionError(
  win: BrowserWindow,
  reason: { code?: number; desc?: string; url?: string } = {}
): void {
  const params = new URLSearchParams();
  if (reason.code !== undefined) params.set("code", String(reason.code));
  if (reason.desc) params.set("desc", reason.desc);
  if (reason.url) params.set("url", reason.url);
  const qs = params.toString();
  const fileUrl = `file://${ERROR_PAGE}${qs ? `?${qs}` : ""}`;
  isShowingErrorPage = true;
  win.loadURL(fileUrl).catch(() => {
    // If we can't even load the local error file, the install is broken;
    // there's nothing useful left to do from this process.
    log.error("[main] failed to load connection-error.html");
  });
}

// If a load hangs — neither did-finish-load nor did-fail-load ever fires
// (e.g. a stalled backend response) — the black-screen watchdog never arms,
// since it only schedules from did-finish-load. This is a hard backstop: if
// the app URL hasn't finished loading within this window, treat it the same
// as a confirmed black screen and run the same graduated recovery.
const LOAD_HANG_TIMEOUT_MS = 20000;
let loadHangTimer: NodeJS.Timeout | null = null;

function clearLoadHangTimer(): void {
  if (loadHangTimer) {
    clearTimeout(loadHangTimer);
    loadHangTimer = null;
  }
}

function armLoadHangTimer(win: BrowserWindow): void {
  clearLoadHangTimer();
  loadHangTimer = setTimeout(() => {
    loadHangTimer = null;
    if (isShowingErrorPage || win.isDestroyed()) return;
    log.warn("[main] load hang: neither did-finish-load nor did-fail-load fired in time");
    recover(win, "Load timed out");
  }, LOAD_HANG_TIMEOUT_MS);
}

function loadAppUrl(win: BrowserWindow): void {
  isShowingErrorPage = false;
  armLoadHangTimer(win);
  win.loadURL(APP_URL).catch(() => {
    // The did-fail-load handler is the canonical recovery path. swallow here.
  });
}

// ---------------------------------------------------------------------------
// Black-screen watchdog + escalating recovery
//
// A GPU-compositing failure or a corrupted service-worker/shader cache loads
// "successfully" but paints pure black — so did-fail-load, render-process-gone
// and unresponsive never fire and the window just sits there blank. We detect
// it by capturing the rendered surface and checking whether ~every sampled
// pixel is the dark background color, then run a graduated recovery.
// ---------------------------------------------------------------------------

// How long after a load to judge the paint — long enough for login + hydration.
const HEALTH_CHECK_DELAY_MS = 9000;
// A black first capture is re-checked after this to avoid a transient frame.
const BLACK_CONFIRM_DELAY_MS = 2500;

let recoveryAttempt = 0;
let healthCheckTimer: NodeJS.Timeout | null = null;
let recovering = false;

// True if essentially every sampled pixel matches the dark background (#0b1220)
// or pure black. A real login/dashboard render has a logo, text, form fields
// and a brand-colored header, so it clears the threshold easily.
async function looksBlack(win: BrowserWindow): Promise<boolean> {
  try {
    const img = await win.webContents.capturePage();
    const { width, height } = img.getSize();
    if (width === 0 || height === 0) return true;
    const bmp = img.toBitmap(); // BGRA, length = width*height*4
    const cols = 16;
    const rows = 16;
    let total = 0;
    let dark = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = Math.min(width - 1, Math.floor((c + 0.5) * (width / cols)));
        const y = Math.min(height - 1, Math.floor((r + 0.5) * (height / rows)));
        const idx = (y * width + x) * 4;
        const b = bmp[idx];
        const g = bmp[idx + 1];
        const red = bmp[idx + 2];
        total++;
        // near #0b1220 (rgb 11,18,32) or near pure black
        if (red <= 24 && g <= 28 && b <= 40) dark++;
      }
    }
    return total > 0 && dark / total >= 0.99;
  } catch {
    // capturePage can fail mid-navigation; never let that trigger a recovery.
    return false;
  }
}

function clearHealthCheck(): void {
  if (healthCheckTimer) {
    clearTimeout(healthCheckTimer);
    healthCheckTimer = null;
  }
}

// While a call is live a confirmed-black screen is only deferred, not acted
// on — re-check on this cadence so recovery starts promptly once the call
// ends (or the TTL expires).
const HEALTH_RECHECK_DURING_CALL_MS = 30000;

// (Re)arm the post-load health check. Called from did-finish-load, so it covers
// the cold start and every reload/recovery — and re-armed with a shorter delay
// when a black screen is confirmed but deferred behind a live call.
function scheduleHealthCheck(win: BrowserWindow, delayMs = HEALTH_CHECK_DELAY_MS): void {
  clearHealthCheck();
  healthCheckTimer = setTimeout(async () => {
    healthCheckTimer = null;
    if (recovering || isShowingErrorPage || win.isDestroyed()) return;
    // Only judge the real app — never the local error page.
    if (!win.webContents.getURL().startsWith(APP_URL)) return;

    if (!(await looksBlack(win))) {
      log.info("[main] health check: render OK");
      recoveryAttempt = 0; // confirmed healthy paint — reset the ladder
      return;
    }
    // Re-confirm to rule out a transient black frame mid-render.
    await new Promise((res) => setTimeout(res, BLACK_CONFIRM_DELAY_MS));
    if (recovering || isShowingErrorPage || win.isDestroyed()) return;
    if (await looksBlack(win)) {
      // The screen looks dead — but the audio path may well be alive, and a
      // reload is guaranteed to kill any call in progress. capturePage is a
      // heuristic (and GPU-dependent itself), so while a call is live we only
      // defer and keep re-checking; the call-ended transition and the TTL
      // both bound how long recovery can be held off.
      if (isCallActive()) {
        log.warn(
          "[main] health check: black/blank render confirmed but a call is active — deferring recovery"
        );
        suppressedDuringCall = true;
        scheduleHealthCheck(win, HEALTH_RECHECK_DURING_CALL_MS);
        return;
      }
      log.warn("[main] health check: black/blank render confirmed");
      recover(win, "Black screen detected");
    } else {
      log.info("[main] health check: render OK (recovered from transient)");
      recoveryAttempt = 0;
    }
  }, delayMs);
}

// Graduated recovery: cheapest fix first, hardest last. The attempt counter
// resets to 0 on any confirmed-healthy paint.
function recover(win: BrowserWindow, reason: string): void {
  if (recovering || win.isDestroyed()) return;
  recovering = true;
  clearHealthCheck();
  const attempt = recoveryAttempt++;
  log.warn(`[main] recover attempt ${attempt}: ${reason} (callActive=${isCallActive()})`);

  if (attempt === 0) {
    // Transient: force a fresh fetch + re-render. Re-arm the hang backstop in
    // case this reload itself never finishes (isShowingErrorPage is already
    // false here, since we only reach recover() while the real app is loaded).
    armLoadHangTimer(win);
    win.webContents.reloadIgnoringCache();
    recovering = false;
    return;
  }
  if (attempt === 1) {
    // A blank PWA shell: drop the service worker + cache storage, then reload.
    // Login (cookies/localStorage) is intentionally preserved.
    const ses = win.webContents.session;
    ses
      .clearStorageData({ storages: ["serviceworkers", "cachestorage", "shadercache"] })
      .catch(() => undefined)
      .then(() => ses.clearCache().catch(() => undefined))
      .then(() => {
        if (!win.isDestroyed()) loadAppUrl(win);
        recovering = false;
      });
    return;
  }
  if (attempt === 2) {
    // Corrupted GPU/shader cache on disk: relaunch and wipe it on the way up.
    relaunchWithCacheWipe();
    return; // process is restarting
  }
  if (attempt === 3 && !isGpuDisabled()) {
    // Cache wipes didn't fix it — the GPU itself can't composite. Pin to
    // software rendering and relaunch; the black screen can't survive that.
    disableGpuAndRelaunch();
    return; // process is restarting
  }
  // Out of automatic options — hand the user the manual recovery page.
  loadConnectionError(win, { desc: reason });
  recovering = false;
}

if (!SINGLE_INSTANCE) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showWindow();
  });
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "SaveYa Phone",
    backgroundColor: "#0b1220",
    show: false,
    autoHideMenuBar: true,
    // Embed the macOS traffic lights INSIDE the app's top bar so we get back
    // the ~28px strip that the default title bar otherwise takes. The web
    // app's purple header has plenty of padding for the lights to sit cleanly
    // in the top-left.
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Persist Twilio Voice + login session across launches.
      partition: "persist:saveyaphone",
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Auto-grant mic / notifications / media for saveya-phone-platform.vercel.app — Twilio Voice
  // browser SDK needs these on every load and we don't want a prompt to break
  // a ringing call.
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const url = details?.requestingUrl ?? "";
    const allowedHosts = ["saveya-phone-platform.vercel.app"];
    const allowed = allowedHosts.some((h) => url.includes(h));
    const granted =
      allowed &&
      [
        "media",
        "audioCapture",
        "videoCapture",
        "notifications",
        "background-sync",
        "clipboard-read",
        "clipboard-sanitized-write",
        "display-capture",
      ].includes(permission);
    callback(granted);
  });

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (!requestingOrigin) return false;
    if (!requestingOrigin.includes("saveya-phone-platform.vercel.app")) return false;
    return [
      "media",
      "audioCapture",
      "videoCapture",
      "notifications",
      "background-sync",
      "clipboard-read",
      "clipboard-sanitized-write",
    ].includes(permission);
  });

  // Set a desktop user-agent suffix so the Next.js app can detect the
  // wrapper if it ever needs to (e.g. to hide the iOS-app banner).
  const ua = win.webContents.getUserAgent() + ` SaveYaPhoneDesktop/${app.getVersion()}`;
  win.webContents.setUserAgent(ua);

  loadAppUrl(win);

  win.once("ready-to-show", () => {
    win.show();
  });

  // Inject a CSS rule that makes the app's top bar draggable. The web app
  // has a sticky brand-colored header at the top of every dashboard page —
  // without `-webkit-app-region: drag` macOS doesn't know that strip is meant
  // to act as a window titlebar, so the entire window is stuck where it
  // opened. Buttons and inputs inside that strip stay clickable via
  // `no-drag`. Injected on every page load (login + dashboard).
  const DRAG_CSS = `
    /* Top sticky brand header in the dashboard layout */
    .dashboard-shell > header,
    header.bg-brand,
    nav.bg-brand,
    [data-electron-drag] {
      -webkit-app-region: drag;
    }
    /* Keep every interactive element inside the drag region clickable */
    button, a, input, select, textarea,
    [role="button"], [role="link"], [role="menuitem"],
    [contenteditable="true"], .no-drag, [data-electron-no-drag] {
      -webkit-app-region: no-drag;
    }
    /* A 28px transparent strip across the very top is ALWAYS draggable so
       the user can grab the window from above the traffic lights even if
       the app's header layout changes. Sits behind everything else so it
       doesn't block clicks on real content. */
    body::before {
      content: "";
      position: fixed;
      top: 0; left: 0; right: 0;
      height: 28px;
      -webkit-app-region: drag;
      pointer-events: none;
      z-index: 9999;
    }
  `;
  win.webContents.on("did-finish-load", () => {
    log.info(`[main] did-finish-load: ${stripQuery(win.webContents.getURL())}`);
    clearLoadHangTimer();
    win.webContents.insertCSS(DRAG_CSS).catch(() => undefined);
    // Confirm the page actually painted real content (catches the black-screen
    // case that loads "successfully" but renders blank).
    scheduleHealthCheck(win);
  });
  win.webContents.on("did-navigate-in-page", () => {
    win.webContents.insertCSS(DRAG_CSS).catch(() => undefined);
  });

  // Open external links in the default browser instead of new Electron windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      const u = new URL(url);
      if (u.hostname !== "saveya-phone-platform.vercel.app") {
        shell.openExternal(url);
        return { action: "deny" };
      }
    }
    return { action: "allow" };
  });

  // Hide instead of quit when the user closes the window — keep WebSocket
  // alive in the tray so calls still ring.
  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
      // The Dock icon STAYS (Chris, 1 Oct 2026: "keep the icon in the dock with
      // its number when you close the window, like Slack"). It used to be
      // hidden here, which took the red unread number away with it; clicking
      // the icon brings the window back (app "activate").
      updateTrayMenu(getMainWindow());
    }
  });

  win.on("show", () => {
    if (process.platform === "darwin") {
      app.dock?.show();
    }
    updateTrayMenu(getMainWindow());
  });

  win.on("hide", () => {
    updateTrayMenu(getMainWindow());
  });

  // Stop any incoming-call taskbar flash the moment the user looks at the app.
  win.on("focus", () => {
    win.flashFrame(false);
  });

  // Replace the black screen with a branded retry page on any non-aborted
  // load failure (network down, Vercel hiccup, saveya-phone-platform.vercel.app DNS issue).
  // The error page auto-retries every 8s and exposes a manual Retry button.
  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // ERR_ABORTED (-3) fires on every normal in-app navigation. Don't swap.
      if (errorCode === -3) return;
      // Sub-frame failures (iframes etc.) shouldn't replace the whole window.
      if (!isMainFrame) return;
      clearLoadHangTimer();
      // If we're already showing the error page and it failed to load, bail —
      // otherwise we'd loop. The page is a local file, so this is rare.
      if (isShowingErrorPage) return;
      // Don't re-route to error.html for failures NOT on the app URL — e.g.,
      // mid-flight navigation to an unrelated host.
      try {
        const u = new URL(validatedURL);
        if (u.hostname !== "saveya-phone-platform.vercel.app") return;
      } catch { /* malformed URL -> still safe to recover via error page */ }

      log.error(
        `[main] did-fail-load ${errorCode} ${errorDescription} ${stripQuery(validatedURL)}`
      );
      loadConnectionError(win, {
        code: errorCode,
        desc: errorDescription,
        url: validatedURL,
      });
      try {
        new Notification({
          title: "SaveYa Phone — can't reach the server",
          body: "We're retrying automatically. Click the window to try now.",
        }).show();
      } catch {
        /* ignore — notifications may not be granted yet */
      }
    }
  );

  // Renderer process died (out-of-memory, segfault, GPU crash). Run the
  // graduated recovery (reload first) instead of jumping straight to the
  // error page. NEVER deferred for a live call: the renderer owns the Twilio
  // connection, so if it's gone the call is already gone — waiting would just
  // leave the staffer staring at a dead window.
  win.webContents.on("render-process-gone", (_event, details) => {
    log.error(
      `[main] render-process-gone: reason=${details.reason} callActive=${isCallActive()}`
    );
    // The flag was set by a renderer that no longer exists — clear it so a
    // stale "call active" can't suppress the recovery reload (or anything
    // else) for up to a TTL after the crash.
    callActiveFlag = false;
    clearUnresponsiveDeferral();
    if (details.reason === "clean-exit") return;
    recover(win, `App crashed (${details.reason})`);
  });

  // Renderer stopped responding for >30s — usually a JS deadlock. Electron
  // fires `responsive` if it works itself out, so this trigger is SPECULATIVE:
  // a renderer that's merely busy may come back on its own. Recovering here
  // reloads the page — fatal to a live call — so while a call is active we
  // defer for a grace window instead of firing immediately. If the renderer
  // is still stuck after the deferral it can't be servicing the call anyway,
  // so we recover regardless (and note the renderer being hung also stops the
  // call-active heartbeats, so the TTL opens the gate on its own too).
  const UNRESPONSIVE_DEFER_MS = 60000;
  let unresponsiveDeferral: NodeJS.Timeout | null = null;
  function clearUnresponsiveDeferral(): void {
    if (unresponsiveDeferral) {
      clearTimeout(unresponsiveDeferral);
      unresponsiveDeferral = null;
    }
  }
  win.webContents.on("unresponsive", () => {
    if (isCallActive()) {
      log.warn(
        "[main] webContents went unresponsive during an active call — deferring recovery 60s"
      );
      suppressedDuringCall = true;
      clearUnresponsiveDeferral();
      unresponsiveDeferral = setTimeout(() => {
        unresponsiveDeferral = null;
        if (win.isDestroyed()) return;
        log.warn("[main] still unresponsive after deferral — recovering anyway");
        recover(win, "App stopped responding");
      }, UNRESPONSIVE_DEFER_MS);
      return;
    }
    log.warn("[main] webContents went unresponsive");
    recover(win, "App stopped responding");
  });

  // The renderer came back on its own — stand down any deferred recovery so a
  // transient stall (big transcript render, GC pause) doesn't get "fixed" with
  // a reload a minute after it resolved itself.
  win.webContents.on("responsive", () => {
    if (unresponsiveDeferral) {
      clearUnresponsiveDeferral();
      log.info("[main] webContents responsive again — cancelled deferred recovery");
    }
  });

  // Right-click Cut/Copy/Paste. Electron ships no default context menu, so
  // without this a right-click in any text field does nothing at all — which
  // is how staff ended up unable to paste a password into the login form.
  attachContextMenu(win);

  return win;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

export function hideWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
}

export function quitApp(): void {
  isQuitting = true;
  app.quit();
}

// Apply a downloaded update NOW. Must enter quitting mode first — otherwise the
// window 'close' handler (which hides to the tray) would swallow the quit and
// the installer would never run. quitAndInstall then exits + installs + relaunch.
function applyUpdate(): void {
  log.info("[main] applying downloaded update");
  isQuitting = true;
  installDownloadedUpdate();
}

// Fired when an update finishes downloading: refresh the tray (surfaces the
// "Restart to update" item) and pop a clickable notification so staff can apply
// it in one click between calls — instead of waiting for a full quit a tray app
// rarely gets. (The update still also installs on the next real quit.)
function onUpdateReady(version: string): void {
  log.info(`[main] update downloaded: v${version}`);
  // Surface the persistent "Restart to update" tray item first…
  updateTrayMenu(getMainWindow());
  // …then pop an UNMISSABLE one-click dialog. Staff should never need to hunt
  // for the system tray to apply a fix. Standalone (no parent window) so it shows
  // even when the app is hidden in the tray. Non-blocking; "Later" defers and the
  // update still installs on the next quit/restart. Only fires once per download.
  dialog
    .showMessageBox({
      type: "info",
      title: "SaveYa Phone — Update Ready",
      message: "A quick update is ready to install.",
      detail:
        "Restart now to apply it (fixes the black-screen issue). It only takes a few seconds and you stay logged in.",
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    .then(({ response }) => {
      if (response === 0) applyUpdate();
    })
    .catch(() => {
      /* dialog failed — the tray "Restart to update" item still offers it */
    });
}

app.whenReady().then(() => {
  // First line of every session — pins version/platform/render-path so the
  // log file reads standalone when pulled off a staffer's machine.
  log.info(
    `[main] app start: v${app.getVersion()} platform=${process.platform} gpuDisabled=${isGpuDisabled()}`
  );

  // Pin the standard edit roles (and therefore the Ctrl/Cmd+V accelerators)
  // rather than trusting Electron's default menu to be there. The menu bar
  // stays hidden via `autoHideMenuBar`, so nothing changes visually.
  installApplicationMenu(app.getName());

  // If the previous session ended uncleanly (a crash or a black-screen
  // recovery relaunch), wipe the GPU/shader caches now — before any window
  // touches them — to clear the on-disk corruption that survives restarts.
  reconcileStartup();

  // A GPU process crash leaves the renderer alive but un-composited (black).
  // Chromium respawns the GPU process; a reload re-paints. A second crash in
  // one session means the GPU path is genuinely broken on this machine, so we
  // skip the reload ladder and pin to software rendering immediately.
  //
  // Both responses are VISUAL fixes for a failure the audio path usually
  // survives (WebRTC audio doesn't need the compositor), so during a live
  // call we defer them — reload and relaunch alike would drop the call to fix
  // pixels the staffer may not even be looking at. The crash counter still
  // increments while deferred, and the call-ended health check (plus the TTL)
  // picks recovery back up once it can't take a call down with it.
  let gpuCrashes = 0;
  app.on("child-process-gone", (_event, details) => {
    if (details.type !== "GPU") return;
    gpuCrashes++;
    log.error(
      `[main] GPU process gone (#${gpuCrashes}): reason=${details.reason} callActive=${isCallActive()}`
    );
    if (isCallActive()) {
      log.warn("[main] GPU crash during an active call — deferring recovery until it ends");
      suppressedDuringCall = true;
      // Self-poll like the black-screen deferral: even if the explicit
      // call-ended signal is lost, the health check re-evaluates the paint
      // once the TTL opens the gate, so a deferred GPU recovery can't sit
      // forever waiting on a message that never arrives.
      if (mainWindow && !mainWindow.isDestroyed()) {
        scheduleHealthCheck(mainWindow, HEALTH_RECHECK_DURING_CALL_MS);
      }
      return;
    }
    if (gpuCrashes >= 2 && !isGpuDisabled()) {
      disableGpuAndRelaunch();
      return; // process is restarting
    }
    if (mainWindow && !mainWindow.isDestroyed() && !isShowingErrorPage) {
      recover(mainWindow, "Graphics process crashed");
    }
  });

  // Ensure permissions on the persistent partition before the window loads.
  const persistent = session.fromPartition("persist:saveyaphone");
  persistent.setPermissionRequestHandler((_wc, permission, callback) => {
    const granted = [
      "media",
      "audioCapture",
      "videoCapture",
      "notifications",
      "background-sync",
      "clipboard-read",
      "clipboard-sanitized-write",
      "display-capture",
    ].includes(permission);
    callback(granted);
  });

  mainWindow = createMainWindow();
  createTray({
    onShow: showWindow,
    onHide: hideWindow,
    onQuit: quitApp,
    onReload: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reload();
      }
    },
    onReset: () => {
      // Same path as the error page's Reset & Reload button.
      ipcMain.emit("saveya:reset-reload");
    },
    onInstallUpdate: applyUpdate,
    getWindow: getMainWindow,
  });

  // Wire silent autoupdater (GitHub Releases). First check fires 10s after
  // launch so it doesn't compete with login + Twilio Voice on cold start.
  // On download, surface a one-click apply (Restart-now dialog + tray item) so
  // the fix actually lands without needing a full quit or finding the tray.
  initAutoUpdater({ onUpdateDownloaded: onUpdateReady });

  // Retry button on connection-error.html fires this. Re-attempts the remote
  // load; if it fails again, did-fail-load swaps back to the error page.
  ipcMain.on("saveya:retry-connect", () => {
    if (mainWindow && !mainWindow.isDestroyed()) loadAppUrl(mainWindow);
  });

  // Quit button on connection-error.html. Same code path as the tray Quit.
  ipcMain.on("saveya:quit", () => {
    quitApp();
  });

  // "Open notification settings" — the in-app alerts card fires this.
  //
  // No app can flip the OS notification switch for a user; Apple and Microsoft
  // both reserve that. What we CAN do is land them on the exact pane instead of
  // reading them five steps of instructions, which is where people give up.
  // Chris hit this himself on 2026-08-19: the chime played, the banner did not,
  // and the fix was buried in System Settings.
  ipcMain.on("saveya:open-notification-settings", () => {
    const url =
      process.platform === "darwin"
        ? "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
        : process.platform === "win32"
          ? "ms-settings:notifications"
          : "";
    if (!url) return;
    shell.openExternal(url).catch((e) => {
      // Never crash the app over a settings deep link — the card still shows
      // the manual steps underneath the button.
      log.warn(`[notif-settings] could not open ${url}: ${String(e)}`);
    });
  });

  // "Reset & Reload" — tray menu + error page. Clears the service-worker /
  // cache / shader storage (login preserved) then relaunches with a full
  // GPU/shader cache wipe. The one-click fix for a stuck black screen.
  ipcMain.on("saveya:reset-reload", async () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      relaunchWithCacheWipe();
      return;
    }
    const ses = mainWindow.webContents.session;
    try {
      await ses.clearStorageData({
        storages: ["serviceworkers", "cachestorage", "shadercache"],
      });
      await ses.clearCache();
    } catch {
      /* fall through to relaunch regardless */
    }
    relaunchWithCacheWipe();
  });

  // Unread badge — dock badge on Mac (with count), taskbar dot on Windows.
  // Web app pushes the total unread count whenever it changes; 0 clears.
  ipcMain.on("saveya:set-badge", (_event, count: number) => {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    // The tray icon carries it too: on Windows a closed window has no taskbar
    // button (so no overlay below) and the tray is the only place left.
    setTrayUnread(n);
    if (process.platform === "darwin") {
      app.dock?.setBadge(n > 0 ? String(n) : "");
    } else if (process.platform === "win32" && mainWindow && !mainWindow.isDestroyed()) {
      // Windows taskbar overlay: 16x16 red dot if any unread, else clear.
      // Using a tiny in-memory PNG so we don't need a bundled asset.
      if (n > 0) {
        const red = nativeImage.createFromBuffer(Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAaklEQVR42mNgGAWj" +
          "YBSMglEwCkbBKBgFowAEGGEC/4HoPwj/B7H/MzAwsDIwMDIwMDAyMDAxMDAxAEUYG" +
          "BgYGRgYGBnYgIwGBgYWBgZGBgYGRgYGBgYGRgYGFgYGRgYGBgYGFgYGBgYGAJwsB" +
          "5pBKv6sAAAAASUVORK5CYII=",
          "base64"
        ));
        mainWindow.setOverlayIcon(red, `${n} unread`);
      } else {
        mainWindow.setOverlayIcon(null, "");
      }
    }
  });

  // Incoming call — surface the window so the ringing overlay is visible even
  // when the app is minimized or hidden in the tray, flash the taskbar for
  // attention, and pop a clickable desktop notification. The web renderer
  // (use-twilio-device.ts) fires this on the Twilio Device 'incoming' event.
  // The notification is silent because the web app plays its own ringtone
  // (renderer audio keeps running in the tray) — we don't want two sounds.
  ipcMain.on(
    "saveya:incoming-call",
    (_event, info: { from?: string; callerName?: string } = {}) => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return;

      // Bring the window into view. On Windows the OS may decline to steal
      // foreground focus from whatever the user is actively in — flashFrame +
      // the notification below are the reliable attention signals in that case.
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
      win.flashFrame(true);

      if (Notification.isSupported()) {
        const who =
          info.callerName?.trim() ||
          (info.from && info.from !== "Unknown" ? info.from : "Unknown caller");
        const notif = new Notification({
          title: "Incoming call",
          body: who,
          silent: true,
        });
        notif.on("click", () => showWindow());
        notif.show();
      }
    }
  );

  // Call answered / rejected / cancelled — stop the taskbar flash. (Windows
  // also stops flashing on its own once the window gains focus.)
  ipcMain.on("saveya:call-ended", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.flashFrame(false);
    }
  });

  // Call-active signal from the renderer (see the state block up top). The
  // payload crosses the contextBridge untyped, so validate it: only a literal
  // true engages the gate — anything else reads as "no call", which fails
  // toward today's recover-freely behavior rather than toward a wedged
  // watchdog. Heartbeats (true while already true) just refresh the TTL
  // timestamp; only real transitions are logged (booleans only — never any
  // call/caller detail).
  ipcMain.on("saveya:call-active", (_event, active: unknown) => {
    const next = active === true;
    const wasActive = callActiveFlag;
    callActiveFlag = next;
    if (next) callActiveAt = Date.now();
    if (wasActive === next) return;
    log.info(`[main] call-active: ${next}`);
    // Call just ended: if any soft recovery was held back while it was live,
    // re-run the health check now so a genuinely broken window gets fixed
    // seconds after hangup instead of waiting for the next scheduled pass.
    if (!next && suppressedDuringCall) {
      suppressedDuringCall = false;
      log.info("[main] call ended with deferred recovery pending — re-checking health");
      if (mainWindow && !mainWindow.isDestroyed()) {
        scheduleHealthCheck(mainWindow);
      }
    }
  });

  // Reload the web app on wake — Twilio Voice WebSocket usually drops during
  // sleep and the Next.js app's auto-reconnect is unreliable. But the reload
  // is UNCONDITIONAL and wake events also fire on lid jiggles / display sleep
  // where nothing actually dropped — if a call survived the event, reloading
  // here is what kills it. Skip while a call is live; the post-call health
  // check re-evaluates the window once it's safe.
  powerMonitor.on("resume", () => {
    if (isCallActive()) {
      log.warn("[main] system resumed during an active call — skipping wake reload");
      suppressedDuringCall = true;
      // Same self-poll as the GPU deferral: re-check the paint after the
      // in-call recheck window so a lost call-ended signal can't leave a
      // wedged (e.g. black) window behind with nothing re-evaluating it.
      if (mainWindow && !mainWindow.isDestroyed()) {
        scheduleHealthCheck(mainWindow, HEALTH_RECHECK_DURING_CALL_MS);
      }
      return;
    }
    log.info("[main] system resumed — reloading window");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reloadIgnoringCache();
    }
  });

  powerMonitor.on("unlock-screen", () => {
    log.info("[main] screen unlocked");
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      // Don't auto-show, but make sure the page is fresh for the next call.
      mainWindow.webContents
        .executeJavaScript(
          "(typeof document !== 'undefined' && document.hasFocus && document.hasFocus()) || false"
        )
        .catch(() => undefined);
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    } else {
      showWindow();
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  // A clean quit (tray Quit / Cmd+Q / OS shutdown) normally clears the
  // running-flag so the next launch skips the cache wipe. But if recovery was
  // ever triggered this session and never confirmed healthy again
  // (recoveryAttempt > 0), the on-disk GPU/shader cache may still be the
  // culprit — leave the flag in place so the next launch wipes it regardless
  // of how clean this particular exit was.
  if (recoveryAttempt > 0) {
    log.warn("[main] quitting with recovery unresolved — next launch will wipe caches");
    return;
  }
  log.info("[main] clean shutdown");
  markCleanShutdown();
});

// Don't quit on macOS when all windows are closed — the tray keeps us alive.
// We never call app.quit() here, which keeps the Electron event loop running
// (Electron only exits when the last window closes AND no quit was requested).
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
  // On darwin: do nothing — tray menu's Quit handler is the only way out.
});
