import { handleExtensionMessage } from "./router.js";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderUrl = sender.url ?? "unknown";
  handleExtensionMessage(message, senderUrl)
    .then((response) => {
      sendResponse(response);
    })
    .catch(() => {
      // Generic message only: internal errors must never leak details to callers.
      sendResponse({ ok: false, error: "Internal error." });
    });

  // Return true to indicate asynchronous response to sendResponse
  return true;
});
