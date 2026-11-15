import { isContentScriptPingData, isValidExtensionResponse } from "@password-manager/shared";

// Double check top-frame execution as defense-in-depth
if (window.top === window) {
  // Send initial handshake message to the background service worker
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage(
      {
        type: "CONTENT_SCRIPT_PING",
        payload: {
          url: window.location.href,
        },
      },
      (rawResponse) => {
        // Handshake only. Nothing is logged into the host page's console.
        void chrome.runtime.lastError;
        void isValidExtensionResponse(rawResponse, isContentScriptPingData);
      }
    );
  }
}
