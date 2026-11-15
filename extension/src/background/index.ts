import { IndexedDbLocalStore } from "../storage/indexeddb-store.js";
import { chromeLocalStore, chromeSessionStore } from "../storage/key-value.js";
import { handleExtensionMessage, type SenderInfo } from "./router.js";
import { VaultService } from "./vault-service.js";

const AUTOLOCK_ALARM = "autolock-check";

const service = new VaultService({
  store: new IndexedDbLocalStore(),
  session: chromeSessionStore,
  settings: chromeLocalStore,
});

/** Builds sender facts from the browser's `sender`, never from message contents. */
function describeSender(sender: chrome.runtime.MessageSender): SenderInfo {
  const extensionOrigin = chrome.runtime.getURL("");
  const isExtensionPage =
    sender.id === chrome.runtime.id &&
    sender.tab === undefined &&
    typeof sender.url === "string" &&
    sender.url.startsWith(extensionOrigin);
  const isContentScript =
    !isExtensionPage && sender.id === chrome.runtime.id && sender.tab !== undefined;
  return { url: sender.url, isExtensionPage, isContentScript };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleExtensionMessage(message, describeSender(sender), service)
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
