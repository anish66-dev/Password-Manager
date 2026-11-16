# Personal Password Manager

A personal, local-first password manager with encrypted cloud sync.

- **Desktop (Windows/macOS/Linux):** Chrome Extension (Manifest V3) built with React and TypeScript.
- **Mobile (Android):** Native Kotlin application (Jetpack Compose, Autofill Framework, biometric unlock) in `android/`.
- **Sync:** Local-first encrypted JSON synchronization via user cloud folder (Google Drive app data folder). No hosted backend servers.

---

## Project Structure

```
password-manager/
├── extension/          # Chrome extension (React popup, background worker, content script)
│   ├── public/         # Static assets and manifest.json
│   ├── src/
│   │   ├── popup/      # React popup interface
│   │   ├── background/ # MV3 Service worker and message routing
│   │   ├── content/    # Content script for page interactions
│   │   └── messages/   # Typed messaging client with runtime boundary validation
│   └── vite.*.config.ts# Vite build configurations
├── android/            # Android app (Kotlin, Jetpack Compose, Autofill Framework)
├── shared/             # Shared TypeScript logic (zero Chrome/React/DOM dependencies)
│   └── src/
│       └── types/      # Typed message schemas, responses, and boundary validators
├── doc/                # Specifications and development plans
├── package.json        # Workspace configuration (npm workspaces)
└── tsconfig.json       # Strict TypeScript configuration
```

---

## Architecture & Vite Build Choice

We use a **manual multi-entry Vite build** configuration rather than a third-party Vite MV3 plugin (such as CRXJS).

### Why Manual Multi-Entry?

1. **Stability & Longevity:** Third-party MV3 Vite plugins often suffer from compatibility breaks with new Vite/Node releases and HMR edge cases.
2. **Deterministic Output:**
   - **Popup:** Standard Vite HTML application (`vite.popup.config.ts`) outputting `dist/popup.html` and bundled React assets.
   - **Background Service Worker:** ES module bundle (`vite.background.config.ts`) targeting `dist/background.js`.
   - **Content Script:** IIFE bundle (`vite.content.config.ts`) targeting `dist/content.js`. This prevents Chrome's `Cannot use import statement outside a module` error in content scripts without requiring dynamic module hacks.
3. **Clean Manifest Copying:** Manifest V3 is maintained in `extension/public/manifest.json` and cleanly copied to `extension/dist/manifest.json`.

---

## Getting Started

### Prerequisites

- Node.js (v20+ or v24+)
- npm (v10+)

### Installation

Install dependencies across the workspaces:

```bash
npm install
```

### Build

To compile the TypeScript project and generate the production extension bundle in `extension/dist`:

```bash
npm run build
```

This builds the `shared` module followed by the three extension entrypoints into `extension/dist`.

### Testing

Run test suite via Vitest:

```bash
npm run test
```

### Linting & Formatting

```bash
# Run ESLint (enforces strict typing and no DOM/Chrome imports in shared/)
npm run lint

# Check code formatting with Prettier
npm run format:check

# Format files
npm run format
```

---

## Loading the Extension in Google Chrome

1. Build the extension if you haven't already:
   ```bash
   npm run build
   ```
2. Open Google Chrome and navigate to:
   ```text
   chrome://extensions
   ```
3. Enable **Developer mode** using the toggle in the upper-right corner.
4. Click the **Load unpacked** button in the top toolbar.
5. In the file picker dialog, select the `extension/dist` directory:
   ```text
   c:\Projects\password-manager\extension\dist
   ```
6. The extension **Personal Password Manager** will appear in the installed extensions list.
7. Click the extension icon in the Chrome toolbar to open the popup.
   - The popup connects via typed messages to the background service worker.
   - It displays the app name, current placeholder vault status (`LOCKED`), and handshake confirmation.
8. Inspecting background service worker logs:
   - Click `service worker` link under the extension entry in `chrome://extensions` to view the service worker console.

---

## Phase 2: Crypto and local vault

- **Key chain:** master password -> Argon2id (`hash-wasm`, 64 MiB / 3 iterations / 1 lane) -> HKDF-SHA256 (`vault-kek`) -> KEK -> unwraps a random 32-byte VEK. Every record is AES-256-GCM under the VEK with its ID and versions bound in as AAD.
- **Storage:** IndexedDB holds only the header and ciphertext records.
- **Session:** the unlocked VEK is held in the service worker and in `chrome.storage.session` (RAM only; cleared on browser restart or extension reload). An alarm locks the vault after inactivity (default 10 minutes, configurable in Settings).
- **Test vectors:** regenerate with `UPDATE_VECTORS=1 npx vitest run shared/src/crypto/vectors.test.ts`. Review the diff before committing; changing them breaks Android compatibility.
- A forgotten master password cannot be recovered.

---

## Phase 3: Autofill

- **Matching** (`shared/src/matching`): registrable domain via `tldts` (Public Suffix List, private suffixes such as `github.io` included). The page must be `https`. Userinfo URLs, IP addresses, unknown suffixes and look-alike (punycode) domains never match. A saved login's own scheme is ignored; only the page must be https.
- **Who decides:** the content script only reports "a login field was focused". The service worker takes the page URL from the browser-provided `sender`, returns suggestions (id, username, domain) with no password, and on a click re-checks the page against the chosen record before it returns credentials to that top frame.
- **Suggestion UI:** an extension-owned iframe (`suggestions.html`). It only talks to the content script over a `MessageChannel` port. The port is authenticated with a one-time nonce that the content script registers with the service worker and the iframe claims, so a page that forges a port is rejected.
- **Scope:** top frame only, never on page load, never into cross-origin iframes. Hidden, tiny and off-screen fields are ignored. `autocomplete="new-password"` fields are skipped (registration and change flows are Phase 4).

### Testing autofill

Localhost only matches in a dedicated build. The normal `npm run build` never matches localhost.

```bash
npm run build:dev-localhost     # builds extension/dist with localhost matching on
npm run serve:test-pages        # http://localhost:5173/
```

1. Reload the extension from `chrome://extensions`, open the popup, create or unlock the vault.
2. Add a login with site `http://localhost`, any username and password.
3. Open `http://localhost:5173/login.html`, click into a field, then click the suggestion.
4. Try `dynamic.html` (JavaScript-rendered, controlled inputs) and `hostile.html` (every probe line should say PASS).
5. Run `npm run build` again before using the extension on real sites.

---

## Phase 4: Save and update prompts

- **What is detected** (`extension/src/content/detect.ts`): registration forms (two password fields: new + confirm) and change-password forms (current + new, optionally + confirm; or a field marked `autocomplete="new-password"`). The username is the nearest visible username/email field, or a hidden `autocomplete="username"` field on change-password pages.
- **When it captures** (`capture.ts`): on a real `submit` event, on Enter inside the form, and on a click of a submit-like control (covers script-driven forms). Only after a trusted user gesture, never when the confirm field does not match, and ignored when the browser would block the submit.
- **Where the password lives:** the content script sends one `CREDENTIAL_CAPTURED` message to the service worker. The worker keeps it in memory only, per tab, for 60 seconds. It is never written to any storage, and the prompt UI only receives the password's length.
- **The prompt** reuses the extension-owned frame (top-right corner): site, username, masked password, and Save/Update, Never, Not now. It is also shown after a redirect, but only on the same site as the capture.
- **Update vs save:** the worker decides. The same registrable domain and username (case-insensitive) is an Update, never a duplicate. A change-password page with no username updates the single saved login on that site. An unchanged password asks nothing.
- **Never:** stored as an encrypted `never_save` record (one per site), so it syncs later and reveals nothing.
- **Locked vault:** the prompt says "Unlock to save" and the capture is kept until it expires. Unlocking the vault makes the prompt switch to Save/Update.
- Only https pages (and localhost in the dev-localhost build) are ever offered a save prompt.

### Testing save prompts

Use the dev-localhost build and the test server as for Phase 3 (`npm run build:dev-localhost`, `npm run serve:test-pages`), then:

1. `register.html`: fill the first form, submit. You are redirected to `welcome.html`, where the prompt appears. Choose Save.
2. `login.html`: your new login is offered and fills.
3. `change-password.html`: save a login for `http://localhost` with username `demo` first, then change the password. The prompt says Update.
4. `register.html`, second form: script-driven button, no submit event. The prompt should still appear.
5. Choose Never on a site, then submit again: no prompt. Choose Not now: nothing is stored.
6. Lock the vault, submit a registration: "Unlock to save". Unlock in the popup: the prompt turns into Save.

---

## Phase 5: Cloud-folder sync (Chrome)

- **Storage:** Google Drive's hidden app data folder (`drive.appdata` scope), through a small `StorageAdapter` interface (`list`, `download`, `upload`, `delete`). The app can see only its own folder, never your other files. The folder holds `header.json` and one `<uuid>.json` per record: ciphertext and random names only.
- **Sync algorithm** (`shared/src/sync`, pure logic, tested with two simulated devices): list the folder and download only files whose revision changed; verify and decrypt every download (failures are rejected and reported, never merged); remote newer and local unchanged takes remote; local newer and remote unchanged uploads; both changed keeps the later modification as current and stores the other as a **conflict copy** (shown with a badge). A cloud copy older than what was already synced is ignored as stale. Deletes are tombstones and sync like edits.
- **Pending changes** are derived, not stored: a record is pending when its local version is above the last synced version.
- **Header conflicts:** a local header is never uploaded over a newer cloud header. If the master password was changed on another device, the popup asks for the new password; unlocking with it also works.
- **New device:** "Restore from Google Drive" signs in, checks the vault exists, asks for the master password, and only then stores the header locally.
- **Triggers:** after unlock, about 3 seconds after a local change, every 5 minutes (alarm), and the Sync now button. Sync needs the unlocked key to verify records, so it never runs while the vault is locked, and background syncs never count as activity for auto-lock.
- **Different vault in the cloud:** if Drive already holds a different vault than the one on this device, nothing is merged and an error is shown.

### Cloud sync setup (you do this once)

Google requires an OAuth client tied to your extension's ID. Nothing below is committed to git.

1. **Get the extension ID.** `npm run build`, load `extension/dist` unpacked, and copy the ID shown at `chrome://extensions`. It stays the same as long as you load it from the same folder. (Optional: `npm run oauth:key --workspace=extension` creates a key that pins the ID wherever you load it from. That changes the ID, which gives a new empty vault, so do it before you store real data. The command prints the ID to use.)
2. **Create a Google Cloud project** at [console.cloud.google.com](https://console.cloud.google.com/), then enable the **Google Drive API** (APIs and Services, Library).
3. **Configure the OAuth consent screen** (Google Auth Platform, Branding / Audience): app name, your email, user type **External**.
4. **Add the scope** `.../auth/drive.appdata` under Data Access. It is listed under non-sensitive scopes, so no Google verification should be needed. Confirm what the console shows for it.
5. **Publishing status: set it to "In production".** In "Testing" status Google can expire consent every 7 days, which would sign sync out unexpectedly. With only a non-sensitive scope, publishing should need no review, and only you will use it. While in Testing, add your own Google account under Test users.
6. **Create the OAuth client**: Credentials, Create credentials, OAuth client ID, application type **Chrome extension**, and paste the extension ID from step 1 as the Item ID. Copy the client ID (it ends in `.apps.googleusercontent.com`).
7. **Give it to the build**: copy `extension/oauth.config.example.json` to `extension/oauth.config.json` (gitignored) and set `clientId`. Do not add a `key` field unless you ran `npm run oauth:key`; an invalid one is ignored with a warning. Rebuild (`npm run build`) and reload the extension. The build prints a warning if no client ID is set.
8. **Connect**: popup, Settings, Connect Google Drive, and approve the consent screen. On a second device or Chrome profile, use "Restore from Google Drive" on the empty popup.

If sign-in later asks again, sync pauses with "Cloud sign-in is required" and your changes stay queued; reconnect in Settings.

### Testing sync

1. Create a login on profile A, connect Google Drive, press Sync now. In Drive's app data folder you cannot browse it directly; check DevTools, Network on the service worker, that requests to `googleapis.com` contain only ciphertext.
2. In a second Chrome profile, load the same build, choose Restore from Google Drive, and enter the master password.
3. Edit offline (DevTools, Network, Offline on the service worker, or turn off Wi-Fi), reconnect, and watch it sync. Edit the same login on both profiles while offline to see a conflict copy.

---

## Phase 6: Android app

Native Kotlin app in `android/` (Jetpack Compose, minSdk 28, targetSdk 35). It uses the same vault, file format and sync algorithm as the Chrome extension, so both devices share one vault through the Drive folder.

### What is in it

- **Crypto and vault** (`app/.../core/`): the exact scheme from the plan over maintained libraries only: Argon2id and HKDF-SHA256 from Bouncy Castle, AES-256-GCM from the platform. Records are the same JSON files as in Chrome (`header.json`, `<uuid>.json`) in app-private storage. No key or plaintext is ever written to disk.
- **Shared test fixtures** (`shared/test-vectors/`): `kdf.json`, `wrap.json` and `record.json` (including the must-fail AAD cases) plus two new files that **both** languages replay: `sync-scenarios.json` (first device, new device, edits, delete tombstones, offline queueing, both conflict directions, tampered file, stale file, wrong password) and `matching.json` (the domain-matching table). Kotlin even reproduces the TypeScript ciphertext byte for byte and the same conflict-copy ID.
- **Sync** (`core/sync`, `core/storage`): a Kotlin port of `shared/src/sync`, a Drive REST v3 adapter (appDataFolder only, pagination, 401 refresh, back-off on 429/5xx) and Google's Authorization API for the `drive.appdata` scope. Triggers: after unlock, about 3 seconds after a local change, every 15 minutes (WorkManager), and the Sync now button.
- **Unlock:** master password (Argon2id off the main thread) and optional biometrics. Enabling biometrics creates an Android Keystore key that needs strong biometric authentication for every use and encrypts the vault key; only that blob is stored. If the enrolled biometrics change, the key is invalidated and the master password is used. Auto-lock after inactivity (default 10 minutes).
- **Autofill service:** matches by the web domain the browser reports (same registrable-domain rules as Chrome, https only) or, for native apps, by a package name you link to a login. The system dropdown shows only "Unlock/Fill from Password Manager". Nothing is returned until you authenticate in the app's own screen, and nothing is filled until you pick a login.
- **Save flow:** `SaveInfo` makes Android offer to save or update a login. The same rules as Chrome apply: same registrable domain (or app) and username means update, never a duplicate; a site you marked "never save" in Chrome is honoured. If the vault is locked, the capture is kept in memory for 60 seconds and a notification asks you to unlock and confirm.
- **Hardening:** `FLAG_SECURE` on every screen (no screenshots, no recent-apps preview), `allowBackup="false"` plus empty data-extraction rules, no cleartext traffic, no analytics, and no secrets in logs (error messages are fixed strings).

### Build, test and install

Requirements: JDK 17 or newer and the Android SDK (platform 36). Create `android/local.properties` with `sdk.dir=...` (Android Studio does this for you).

```bash
cd android
./gradlew testDebugUnitTest      # crypto vectors, sync scenarios, matching, Drive adapter, save logic
./gradlew assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
./gradlew installDebug           # installs on the connected phone (USB debugging on)
```

On Windows use `gradlew.bat` in `cmd`/PowerShell. `testapp/` is a tiny development-only app with a native login form for trying autofill; it is not part of the product (`./gradlew :testapp:installDebug`).

### First run on the phone

1. Open the app, create a vault, and use Settings, **Measure unlock speed**. The plan aims for roughly 0.5 to 1 second. The Argon2 parameters (64 MiB, 3 iterations, 1 lane) must stay identical on every device, so if it is much slower, tell me before changing them.
2. Settings, **Open autofill settings**, choose Password Manager. In Chrome on Android, third-party autofill needs the "Autofill using another service" option, which depends on your Chrome version.
3. To fill a native app, add a login, and type the app's package name in "Linked app package".
4. Enable biometric unlock in Settings after unlocking with the master password.

### Google Drive setup for Android (you do this once)

Google matches the Android app by **package name plus signing certificate fingerprint**, so this needs its own OAuth client in the same Google Cloud project you made for Chrome (Drive API enabled, consent screen configured, scope `drive.appdata`, publishing status "In production").

1. Get the SHA-1 of the key that signs your build. For a debug build:
   ```bash
   keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android
   ```
2. Google Cloud console, Credentials, Create credentials, OAuth client ID, application type **Android**. Package name: `com.personal.passwordmanager`. Paste the SHA-1.
3. Nothing needs to be added to the app or to git: no client ID is stored in the code.
4. In the app: Settings, **Connect Google Drive**, approve the consent screen. On a phone without a vault, use **Restore from Google Drive** on the first screen and enter the master password.

A release-signed or differently signed build has a different SHA-1 and needs its own entry. Add `allowLocalhost=true` to `android/local.properties` only for a development build that should match `http://localhost`.

### Limits to know

- Background sync only runs while the app process holds the unlocked key (the key is never stored). A locked vault simply skips the run and keeps changes queued; they sync after the next unlock.
- Autofill asks for authentication through the unlock screen only when the vault is locked. While it is unlocked (within the auto-lock window) fill is one tap.
- Linking a login to a native app adds an optional `app_package` field to that login's encrypted payload. The Chrome extension ignores and preserves it.
- Unpaired surrogates in a master password are encoded differently by Kotlin and JavaScript. Ordinary text, including emoji, matches (the shared test vector covers it).

### Testing end to end (checklist)

1. Create a login in Chrome, sync, then **Restore from Google Drive** on the phone: it appears. Edit on the phone, sync, Sync now in Chrome: the edit appears. Delete on either side: it disappears on the other.
2. Airplane mode: unlock with biometrics, fill a login in the test app or a browser, save a new login, turn the network back on: it syncs.
3. Put a hand-edited file in the Drive folder: the phone rejects it and shows "Some files failed verification".
4. Inspect the app's private files with `adb shell run-as com.personal.passwordmanager ls files/vault` (debug builds): only ciphertext. Check logs with `adb logcat`: no passwords.
