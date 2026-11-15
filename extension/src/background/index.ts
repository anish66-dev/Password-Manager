import { IndexedDbLocalStore } from "../storage/indexeddb-store.js";
import { chromeLocalStore, chromeSessionStore } from "../storage/key-value.js";
import { handleExtensionMessage, type RouterDeps, type SenderInfo } from "./router.js";
import { VaultService } from "./vault-service.js";
import { PendingCaptures } from "./capture-flow.js";
import { DriveAdapter } from "../sync/drive-adapter.js";
import { ChromeTokenProvider } from "../sync/auth.js";
import { IndexedDbSyncStateStore } from "../storage/sync-state-store.js";
import { SyncService } from "./sync-service.js";

const AUTOLOCK_ALARM = "autolock-check";
const SYNC_ALARM = "sync-periodic";

declare const __ALLOW_LOCALHOST__: boolean | undefined;

const localStore = new IndexedDbLocalStore();
const service = new VaultService({
  store: localStore,
  session: chromeSessionStore,
  settings: chromeLocalStore,
});

const tokens = new ChromeTokenProvider();
const sync = new SyncService({
  store: localStore,
  state: new IndexedDbSyncStateStore(),
  adapter: new DriveAdapter({ tokens }),
  auth: {
    signIn: async () => {
      await tokens.getToken(true);
    },
    signOut: () => tokens.signOut(),
  },
  vault: service,
  settings: chromeLocalStore,
});

const captures = new PendingCaptures();

/** Tells tabs with a waiting save prompt to look again, for example after an unlock. */
function notifyPendingTabs(): void {
  for (const tabId of captures.tabIds()) {
    chrome.tabs.sendMessage(tabId, { type: "PENDING_CAPTURE_AVAILABLE" }).catch(() => undefined);
  }
}

const deps: RouterDeps = {
  service,
  captures,
  sync,
  onUnlocked: notifyPendingTabs,
  // Replaced at build time. True only for the dev-localhost build.
  allowLocalhost: typeof __ALLOW_LOCALHOST__ !== "undefined" && __ALLOW_LOCALHOST__ === true,
  frameNonces: new Map(),
};

/** Builds sender facts from the browser's `sender`, never from message contents. */
function describeSender(sender: chrome.runtime.MessageSender): SenderInfo {
  const ours = sender.id === chrome.runtime.id;
  const fromExtensionUrl =
    ours && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
  // Our own suggestion iframe, embedded in a web page (never the top frame).
  const isSuggestionFrame =
    fromExtensionUrl &&
    sender.tab !== undefined &&
    (sender.frameId ?? 0) !== 0 &&
    (sender.url as string).startsWith(chrome.runtime.getURL("suggestions.html"));
  // Popup or other extension page. Pages cannot frame these (not web-accessible).
  const isExtensionPage = fromExtensionUrl && !isSuggestionFrame;
  // Content scripts only run in the top frame (frameId 0) of http(s) pages.
  const isContentScript =
    ours && !fromExtensionUrl && sender.tab !== undefined && sender.frameId === 0;
  return {
    url: sender.url,
    isExtensionPage,
    isContentScript,
    isSuggestionFrame,
    tabId: sender.tab?.id,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleExtensionMessage(message, describeSender(sender), deps)
    .then((response) => sendResponse(response))
    .catch(() => {
      // Generic message only: internal errors must never leak details to callers.
      sendResponse({ ok: false, error: "Internal error." });
    });

  // Return true to indicate asynchronous response to sendResponse
  return true;
});

// A closed tab never gets its pending capture back.
chrome.tabs.onRemoved.addListener((tabId) => captures.delete(tabId));

// A fresh browser session or a reloaded extension always starts locked.
chrome.runtime.onStartup.addListener(() => {
  void service.lock();
});
chrome.runtime.onInstalled.addListener(() => {
  void service.lock();
});

// Service workers sleep, so inactivity is enforced with an alarm instead of a timer.
chrome.alarms.create(AUTOLOCK_ALARM, { periodInMinutes: 1 });
chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTOLOCK_ALARM) {
    void service.checkAutoLock();
  } else if (alarm.name === SYNC_ALARM) {
    // Does nothing while the vault is locked or sync is off.
    void sync.syncNow();
  }
});
