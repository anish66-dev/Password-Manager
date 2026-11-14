import { handleExtensionMessage } from "./router.js";

console.log("[Service Worker] Personal Password Manager background active.");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderUrl = sender.url ?? "unknown";
  handleExtensionMessage(message, senderUrl)
    .then((response) => {
      sendResponse(response);
    })
    .catch((err) => {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : "Unknown background processing error.",
      });
    });

  // Return true to indicate asynchronous response to sendResponse
  return true;
});
