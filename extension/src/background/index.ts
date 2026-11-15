import { IndexedDbLocalStore } from "../storage/indexeddb-store.js";
import { chromeLocalStore, chromeSessionStore } from "../storage/key-value.js";
import { handleExtensionMessage, type RouterDeps, type SenderInfo } from "./router.js";
import { VaultService } from "./vault-service.js";

const AUTOLOCK_ALARM = "autolock-check";

declare const __ALLOW_LOCALHOST__: boolean | undefined;

const service = new VaultService({
  store: new IndexedDbLocalStore(),
  session: chromeSessionStore,
  settings: chromeLocalStore,
});

const deps: RouterDeps = {
  service,
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

// A fresh browser session or a reloaded extension always starts locked.
chrome.runtime.onStartup.addListener(() => {
  void service.lock();
});
chrome.runtime.onInstalled.addListener(() => {
  void service.lock();
});

// Service workers sleep, so inactivity is enforced with an alarm instead of a timer.
chrome.alarms.create(AUTOLOCK_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTOLOCK_ALARM) {
    void service.checkAutoLock();
  }
});
