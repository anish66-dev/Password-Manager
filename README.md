# Personal Password Manager

A personal, local-first password manager with encrypted cloud sync.

- **Desktop (Windows/macOS/Linux):** Chrome Extension (Manifest V3) built with React and TypeScript.
- **Mobile (Android):** Native Kotlin application (Jetpack Compose, Autofill Framework) [Phase 6].
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
