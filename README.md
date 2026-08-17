# SaveYa Phone — Desktop

Electron wrapper around https://saveya-phone-platform.vercel.app that runs as a persistent menu-bar app on macOS.

## Why

The browser PWA gets suspended (tabs go idle, WebSockets drop on sleep, notifications break after macOS updates). This wrapper keeps the page alive in the tray, reloads on wake, and routes notifications through the native macOS notification center.

It is **not** a fork of the web app — it loads `https://saveya-phone-platform.vercel.app` live. Any change to the Next.js app at `/Users/chrislanzilli/saveya-phone-system` ships to the desktop app on next page load.

## Quick start

```sh
npm install
npm run dev      # builds TS, opens window pointed at saveya-phone-platform.vercel.app
```

## Package a `.dmg`

### Unsigned (works immediately, but staff will see Gatekeeper warning)

```sh
npm run build:mac:unsigned
# .dmg lands in ./out/SaveYa Phone-1.0.0-arm64.dmg
```

Staff will need to right-click → Open the first time. Fine for internal testing.

### Signed + notarized (proper distribution)

You need:
1. **Developer ID Application** certificate in your login Keychain (NOT the iOS Distribution cert — different cert type).
2. **App Store Connect API key** (`.p8`) with Developer role.

#### One-time setup of the Developer ID cert

The Mac currently has zero codesigning identities (`security find-identity -v -p codesigning` returns "0 valid identities"). You must:

1. Open **Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority…**
   - Email: chris@saveyatech.com
   - Common Name: Christopher Lanzilli
   - Saved to disk → continue. Save the `.certSigningRequest` file.
2. Go to https://developer.apple.com/account/resources/certificates → **+**
3. Choose **Developer ID Application** → continue → upload the CSR.
4. Download the `.cer`, double-click to install in **login** keychain.
5. Verify: `security find-identity -v -p codesigning | grep "Developer ID Application"` — you should see one identity.

#### Notarization key

We already have one App Store Connect API key on disk:
`~/Downloads/AuthKey_28FNDQ3332.p8` (Key ID `28FNDQ3332`).

You still need the **Issuer ID** — find it at https://appstoreconnect.apple.com/access/api (top of the Keys table, looks like `69a6de70-…-…`). Copy `.env.example` to `.env` and fill in:

```
APPLE_API_KEY=/Users/chrislanzilli/Downloads/AuthKey_28FNDQ3332.p8
APPLE_API_KEY_ID=28FNDQ3332
APPLE_API_ISSUER=<paste-issuer-uuid>
APPLE_TEAM_ID=L78CXLCJLX
```

Optional: also move the `.p8` to `~/private_keys/AuthKey_28FNDQ3332.p8` so other Apple tools auto-discover it.

#### Build

```sh
# Loads .env, signs with the Developer ID cert in Keychain, notarizes with the
# App Store Connect API key, staples the ticket.
npm run build:mac
# .dmg lands in ./out/SaveYa Phone-1.0.0-arm64.dmg
```

The `notarize: false` flag in `package.json` is set because we run notarization through a custom afterSign hook (`scripts/notarize.js`) that uses `@electron/notarize`. If you want to disable notarization (e.g. for a quick test build), comment out the afterSign hook.

## Repo layout

```
src/
  main.ts        # BrowserWindow, lifecycle, power events, permissions
  tray.ts        # Menu bar tray icon + context menu
build/
  entitlements.mac.plist  # Hardened-runtime entitlements (mic, network, JIT)
  icon.iconset/           # macOS app iconset (1024 → 16)
  icon.png                # 512px fallback for electron-builder
assets/
  trayTemplate.png        # 16x16 menu-bar template icon
  trayTemplate@2x.png     # 32x32 retina
scripts/
  make-icons.py           # Regenerate icons from scratch
  notarize.js             # afterSign hook for @electron/notarize
```

## How it stays alive

- `app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')` → renderer doesn't get throttled when window is hidden.
- `webPreferences.backgroundThrottling: false` → timers + WebSockets keep ticking.
- `disable-background-timer-throttling` + `disable-renderer-backgrounding` → same idea, belt and suspenders.
- Window `close` event is intercepted — hides to tray instead of quitting. Only the **Quit** menu item actually exits.
- `powerMonitor.on('resume')` → `webContents.reloadIgnoringCache()` on every wake to re-establish Twilio Voice WebSocket.
- Persistent `partition: 'persist:saveyaphone'` → Twilio Voice token + login cookie survive restarts.

## Permissions

The app auto-grants microphone, notifications, media, clipboard, and background-sync to `saveya-phone-platform.vercel.app` on every load — no OS prompt during a ringing call. Code in `src/main.ts: setPermissionRequestHandler`. Hardened-runtime entitlements are in `build/entitlements.mac.plist`.

## Distribution to staff

After `npm run build:mac` produces a notarized `.dmg`:
1. Upload to a private spot (e.g. Google Drive shared with @saveyalaw.com).
2. Staff double-clicks → drag to Applications → launch → grant microphone permission once.
3. App will appear in the menu bar; the window can be closed and the app stays running.

## Known gotchas

- **Login session is per-app.** Staff log in once; cookie persists in `~/Library/Application Support/SaveYa Phone/Partitions/saveyaphone/Cookies`.
- **Auto-update is NOT wired.** Push updates are deferred to v2 — for now, ship a new `.dmg` and email staff.
- **Universal vs ARM-only.** The package config builds both `arm64` and `x64`. If everyone is on Apple Silicon, comment out `x64` in `package.json` `build.mac.target` to halve build time.
- **Staff ID = same as iOS app.** No additional config needed — the Next.js app handles staffId per browser session, and the Twilio Voice multi-identity registration pattern means desktop + iOS + cell will all ring simultaneously.

## Useful commands

```sh
# Verify cert presence
security find-identity -v -p codesigning | grep "Developer ID Application"

# Inspect a built .dmg
hdiutil verify "out/SaveYa Phone-1.0.0-arm64.dmg"

# Verify signature on the .app inside the .dmg
codesign --verify --verbose=4 "out/mac-arm64/SaveYa Phone.app"
spctl -a -t exec -vv "out/mac-arm64/SaveYa Phone.app"

# Check notarization staple
xcrun stapler validate "out/SaveYa Phone-1.0.0-arm64.dmg"
```
