# Manual steps before shipping a signed .dmg

The unsigned `.dmg` is built and works for internal testing. Two manual things have to happen before staff can install without a Gatekeeper warning:

## 1. Generate the Developer ID Application certificate (one-time, ~10 min)

The Mac currently has **zero codesigning identities** (verified by `security find-identity -v -p codesigning`). You need to create the Developer ID cert manually — Apple does not allow CLI generation.

1. Open **Keychain Access** → menu **Certificate Assistant → Request a Certificate From a Certificate Authority…**
   - Email: `chris@saveyatech.com`
   - Common Name: `Christopher Lanzilli`
   - **Saved to disk** → Continue. Save the `.certSigningRequest` file somewhere obvious (Desktop).
2. Go to https://developer.apple.com/account/resources/certificates → click **+** (top right)
3. Select **Developer ID Application** → Continue.
4. Upload the `.certSigningRequest`. (If you don't see "Developer ID Application" as an option, you may need to enable it under Account → Membership.)
5. Download the resulting `.cer` file.
6. Double-click the `.cer` — it installs into the **login** Keychain.
7. Verify:
   ```sh
   security find-identity -v -p codesigning | grep "Developer ID Application"
   # You should see one entry: 1) <SHA-1> "Developer ID Application: Christopher Lanzilli (L78CXLCJLX)"
   ```

## 2. Get the App Store Connect API Issuer ID (one-time, ~30 seconds)

We already have the API key file at `~/Downloads/AuthKey_28FNDQ3332.p8` (Key ID `28FNDQ3332`). We just need the Issuer ID:

1. Go to https://appstoreconnect.apple.com/access/api
2. At the top of the **Keys** table you'll see an **Issuer ID** (UUID format like `69a6de70-…-…`). Copy it.
3. In this repo, copy `.env.example` to `.env` and fill in:
   ```
   APPLE_API_KEY=/Users/chrislanzilli/Downloads/AuthKey_28FNDQ3332.p8
   APPLE_API_KEY_ID=28FNDQ3332
   APPLE_API_ISSUER=<paste-issuer-uuid>
   APPLE_TEAM_ID=L78CXLCJLX
   ```

## 3. Build the signed + notarized .dmg

```sh
cd /Users/chrislanzilli/saveya-phone-desktop
npm run build:mac
# .dmg lands in ./out/SaveYa Phone-1.0.0-arm64.dmg
# Notarization takes 2-5 min; afterSign hook waits for Apple's response.
```

Verify the signed build:
```sh
codesign --verify --verbose=4 "out/mac-arm64/SaveYa Phone.app"
# expected: "valid on disk" + "satisfies its Designated Requirement"

spctl -a -t exec -vv "out/mac-arm64/SaveYa Phone.app"
# expected: "accepted source=Notarized Developer ID"

xcrun stapler validate "out/SaveYa Phone-1.0.0-arm64.dmg"
# expected: "The validate action worked!"
```

## 4. Distribute

Upload `out/SaveYa Phone-1.0.0-arm64.dmg` to a private spot (Google Drive shared with `@saveyalaw.com`, Slack channel, S3, etc). Staff:
1. Double-click the `.dmg`.
2. Drag **SaveYa Phone** into Applications.
3. Launch from Applications.
4. Grant microphone access when prompted.
5. App appears in the menu bar. Close the window — it stays alive in the tray.
6. Log into saveya-phone-platform.vercel.app using their staff credentials.

## What's already done

- ✅ Electron 33 + electron-builder pipeline working.
- ✅ Tray icon, menu (Show/Hide/Reload/Quit), close-to-tray behavior.
- ✅ Power-resume reload hook for Twilio Voice WebSocket recovery.
- ✅ Microphone + notifications auto-granted for saveya-phone-platform.vercel.app.
- ✅ Hardened-runtime entitlements file.
- ✅ Unsigned `out/SaveYa Phone-1.0.0-arm64.dmg` (98 MB) and `.zip` produced. Verified Mach-O arm64 binary, .app launches and loads saveya-phone-platform.vercel.app.
- ✅ Notarization hook wired (skips if env not set).

## Known notes

- **Universal binary disabled.** Only `arm64` is built. If you have Intel Mac staff, edit `package.json` `build.mac.target` to add `"x64"`. Note: x64 build doubles total time and requires hdiutil to work in your shell (does work in normal Terminal — only the Claude sandbox blocked it during initial build).
- **Auto-update not wired.** Deferred to v2. Future plan: host releases on S3/GitHub Releases and add `electron-updater` (already a possible dep — needs `publish` config in `package.json` and `autoUpdater.checkForUpdatesAndNotify()` in main.ts).
- **A running test instance is still alive.** During verification I launched the .app and the sandbox blocked `kill`/`pkill`. You'll see an `SaveYa Phone` process — just quit it from its menu (the window opened to saveya-phone-platform.vercel.app login).
