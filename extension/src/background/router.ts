import {
  type ExtensionResponse,
  type PopupStatusResponseData,
  type ContentScriptPingResponseData,
  isValidExtensionMessage,
} from "@password-manager/shared";

/**
 * Handles incoming messages at the service worker boundary with strict runtime validation.
 */
export async function handleExtensionMessage(
  rawMessage: unknown,
  _senderUrl?: string
): Promise<ExtensionResponse<PopupStatusResponseData | ContentScriptPingResponseData>> {
  if (!isValidExtensionMessage(rawMessage)) {
    return {
      ok: false,
      error: "Invalid message payload or unrecognized message type at boundary.",
    };
  }

  switch (rawMessage.type) {
    case "POPUP_GET_STATUS": {
      return {
        ok: true,
        data: {
          appName: "Personal Password Manager",
          version: "0.1.0",
          status: "locked",
          timestamp: new Date().toISOString(),
        },
      };
    }

    case "CONTENT_SCRIPT_PING": {
      return {
        ok: true,
        data: {
          acknowledged: true,
          receivedFromUrl: rawMessage.payload.url,
          timestamp: new Date().toISOString(),
        },
      };
    }
  }
}
