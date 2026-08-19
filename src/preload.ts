import { contextBridge, ipcRenderer } from "electron";

// Surface a minimal, typed API to the renderer (saveya-phone-platform.vercel.app).
// Web code calls `window.saveyaDesktop?.setBadge(n)` — guarded by optional chaining
// so the same web bundle still works in the regular browser.
// retryConnect / quit are used by the bundled connection-error.html page.
contextBridge.exposeInMainWorld("saveyaDesktop", {
  setBadge: (count: number) => ipcRenderer.send("saveya:set-badge", count),
  // Fired on Twilio Device 'incoming' so the main process can surface the
  // window, flash the taskbar, and pop a notification even when minimized/hidden.
  incomingCall: (info: { from?: string; callerName?: string }) =>
    ipcRenderer.send("saveya:incoming-call", info),
  // Fired when the call is answered, rejected, or cancelled — stops the flash.
  callEnded: () => ipcRenderer.send("saveya:call-ended"),
  // True while a Twilio call is ringing or connected, false when it's over.
  // The web app re-sends true every ~30s as a heartbeat. Lets the main
  // process hold its softer recovery actions (wake reloads, black-screen
  // reloads) instead of killing a live call — the recovery ladder was built
  // call-unaware. NOT the same as callEnded above, which only means "ringing
  // stopped" and fires even when the call was just answered.
  setCallActive: (active: boolean) => ipcRenderer.send("saveya:call-active", active),
  retryConnect: () => ipcRenderer.send("saveya:retry-connect"),
  resetReload: () => ipcRenderer.send("saveya:reset-reload"),
  quit: () => ipcRenderer.send("saveya:quit"),
  // Opens the OS notification pane for this app. Presence of this method is
  // how the web app decides whether to show the one-click button at all, so an
  // older installed build simply keeps the manual steps.
  openNotificationSettings: () =>
    ipcRenderer.send("saveya:open-notification-settings"),
});
