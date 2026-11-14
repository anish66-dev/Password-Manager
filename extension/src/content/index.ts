import {
  type ContentScriptPingResponseData,
  isValidExtensionResponse,
} from "@password-manager/shared";

// Double check top-frame execution as defense-in-depth
if (window.top === window) {
  console.log(
    "[Content Script] Personal Password Manager content script loaded in top frame:",
    window.location.href
  );

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
        if (chrome.runtime.lastError) {
          console.warn("[Content Script] Handshake error:", chrome.runtime.lastError.message);
          return;
        }

        if (isValidExtensionResponse<ContentScriptPingResponseData>(rawResponse)) {
          if (rawResponse.ok) {
            console.log(
              "[Content Script] Typed response received from service worker:",
              rawResponse.data
            );
          } else {
            console.warn(
              "[Content Script] Service worker responded with error:",
              rawResponse.error
            );
          }
        } else {
          console.error(
            "[Content Script] Invalid response structure from service worker boundary."
          );
        }
      }
    );
  }
}
