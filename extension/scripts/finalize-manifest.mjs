// Fills the per-user OAuth settings into dist/manifest.json after the Vite builds.
//
// The Google OAuth client ID (and the optional public "key" that pins the extension ID) belong
// to you, so they are not committed. Put them in extension/oauth.config.json (gitignored) or
// set PM_OAUTH_CLIENT_ID. See "Cloud sync setup" in the README.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "dist", "manifest.json");
const configPath = path.join(root, "oauth.config.json");

const placeholder = "REPLACE_WITH_YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

let config = {};
if (existsSync(configPath)) {
  config = JSON.parse(readFileSync(configPath, "utf8"));
}

const clientId = process.env.PM_OAUTH_CLIENT_ID ?? config.clientId;
const key = process.env.PM_EXTENSION_KEY ?? config.key;

if (typeof clientId === "string" && clientId.endsWith(".apps.googleusercontent.com")) {
  manifest.oauth2 = { ...manifest.oauth2, client_id: clientId };
} else {
  manifest.oauth2 = { ...manifest.oauth2, client_id: placeholder };
  console.warn(
    "[manifest] No OAuth client ID configured: cloud sync sign-in will not work.\n" +
      "           Create extension/oauth.config.json (see oauth.config.example.json)."
  );
}

/** A real manifest key is the base64 of an RSA public key (DER, a few hundred bytes). */
function isValidKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.length >= 150 && bytes[0] === 0x30; // DER SEQUENCE
}

if (isValidKey(key)) {
  manifest.key = key;
} else if (key !== undefined && key !== "") {
  console.warn(
    '[manifest] Ignoring "key" in oauth.config.json: it is not a valid public key.\n' +
      "           Remove the field, or run: npm run oauth:key --workspace=extension"
  );
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
