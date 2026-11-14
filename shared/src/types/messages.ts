export type ExtensionMessage =
  | {
      type: "POPUP_GET_STATUS";
    }
  | {
      type: "CONTENT_SCRIPT_PING";
      payload: {
        url: string;
      };
    };

export interface PopupStatusResponseData {
  appName: string;
  version: string;
  status: "locked" | "unlocked" | "uninitialized";
  timestamp: string;
}

export interface ContentScriptPingResponseData {
  acknowledged: boolean;
  receivedFromUrl: string;
  timestamp: string;
}

export type ExtensionResponse<T = unknown> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: string;
    };

export type PopupStatusResponse = ExtensionResponse<PopupStatusResponseData>;
export type ContentScriptPingResponse = ExtensionResponse<ContentScriptPingResponseData>;

/**
 * Validates untrusted input at the boundary to ensure it matches ExtensionMessage.
 */
export function isValidExtensionMessage(msg: unknown): msg is ExtensionMessage {
  if (typeof msg !== "object" || msg === null) {
    return false;
  }
  const candidate = msg as Record<string, unknown>;
  if (typeof candidate["type"] !== "string") {
    return false;
  }
  switch (candidate["type"]) {
    case "POPUP_GET_STATUS":
      return true;
    case "CONTENT_SCRIPT_PING": {
      const payload = candidate["payload"];
      if (typeof payload !== "object" || payload === null) {
        return false;
      }
      return typeof (payload as Record<string, unknown>)["url"] === "string";
    }
    default:
      return false;
  }
}

/**
 * Validates untrusted response data at the boundary.
 */
export function isValidExtensionResponse<T>(
  response: unknown,
  dataValidator?: (data: unknown) => data is T
): response is ExtensionResponse<T> {
  if (typeof response !== "object" || response === null) {
    return false;
  }
  const candidate = response as Record<string, unknown>;
  if (typeof candidate["ok"] !== "boolean") {
    return false;
  }
  if (candidate["ok"] === true) {
    if (dataValidator) {
      return dataValidator(candidate["data"]);
    }
    return "data" in candidate;
  } else {
    return typeof candidate["error"] === "string";
  }
}
