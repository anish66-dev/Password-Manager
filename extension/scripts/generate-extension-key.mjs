// Generates a key that pins the extension's ID, so the ID (and the Google OAuth client that
// is tied to it) stays the same wherever you load the unpacked extension from.
//
//   npm run oauth:key --workspace=extension
//
// Prints the extension ID to give to Google Cloud, and stores the public key in
// extension/oauth.config.json (gitignored). The private key is not needed for a personal,
// unpacked extension and is not kept.
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(root, "oauth.config.json");

const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
if (config.key && !process.argv.includes("--force")) {
  console.log("A key already exists in oauth.config.json. Use --force to replace it.");
  console.log("Extension ID:", extensionId(config.key));
  process.exit(0);
}

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = publicKey.export({ type: "spki", format: "der" });
config.key = der.toString("base64");
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

console.log("Saved a new key to extension/oauth.config.json");
console.log("Extension ID:", extensionId(config.key));

/** Chrome derives the ID from the SHA-256 of the DER public key: 32 hex digits, 0-f -> a-p. */
function extensionId(base64Key) {
  const hash = createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("hex");
  return hash
    .slice(0, 32)
    .split("")
    .map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16)))
    .join("");
}
