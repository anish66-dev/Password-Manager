import {
  type ExtensionMessage,
  type ExtensionResponse,
  isValidExtensionResponse,
} from "@password-manager/shared";

/**
 * Sends a strongly-typed message to the background service worker. The response envelope
 * and its data are validated at the boundary with the supplied validator.
 */
export async function sendToBackground<TResponseData>(
  message: ExtensionMessage,
  validator: (data: unknown) => data is TResponseData
): Promise<ExtensionResponse<TResponseData>> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return {
      ok: false,
      error: "Chrome runtime messaging is not available.",
    };
  }

  try {
    const rawResponse: unknown = await chrome.runtime.sendMessage(message);
    if (!isValidExtensionResponse<TResponseData>(rawResponse, validator)) {
      // A well-formed error envelope is still a valid reply.
      if (
        typeof rawResponse === "object" &&
        rawResponse !== null &&
        (rawResponse as { ok?: unknown }).ok === false &&
        typeof (rawResponse as { error?: unknown }).error === "string"
      ) {
        return { ok: false, error: (rawResponse as { error: string }).error };
      }
      return {
        ok: false,
        error: "Malformed response received from service worker boundary.",
      };
    }
    return rawResponse;
  } catch {
    return { ok: false, error: "Could not reach the background service." };
  }
}
