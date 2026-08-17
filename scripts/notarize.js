// electron-builder afterSign hook that submits the .app for notarization
// using an App Store Connect API key.
//
// Skipped automatically if APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER
// are not set — that lets `npm run build:mac:unsigned` work without env.

require("dotenv").config();
const path = require("path");

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;

  if (!APPLE_API_KEY || !APPLE_API_KEY_ID || !APPLE_API_ISSUER) {
    console.log(
      "[notarize] skipping — APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER not all set"
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(`[notarize] submitting ${appPath}`);
  const { notarize } = require("@electron/notarize");

  // NOTE: do not pass `teamId` here — @electron/notarize's argument validator
  // treats teamId as a "password-credentials" property and rejects the call
  // with "cannot use password credentials and API key credentials at once".
  // The team is already encoded in the API key itself.
  await notarize({
    tool: "notarytool",
    appPath,
    appleApiKey: APPLE_API_KEY,
    appleApiKeyId: APPLE_API_KEY_ID,
    appleApiIssuer: APPLE_API_ISSUER,
  });

  console.log("[notarize] success — ticket stapled by electron-builder");
};
