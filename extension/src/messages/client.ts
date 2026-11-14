import {
  type ExtensionMessage,
  type ExtensionResponse,
  isValidExtensionResponse,
} from "@password-manager/shared";

/**
 * Sends a strongly-typed message to the background service worker and validates the response at the boundary.
 */
export async function sendToBackground<TResponseData>(
  message: ExtensionMessage
): Promise<ExtensionResponse<TResponseData>> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return {
      ok: false,
      error: "Chrome runtime messaging is not available.",
    };
  }

  try {
    const rawResponse = await chrome.runtime.sendMessage(message);
    if (!isValidExtensionResponse<TResponseData>(rawResponse)) {
      return {
        ok: false,
        error: "Malformed response received from service worker boundary.",
      };
    }
    return rawResponse;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
