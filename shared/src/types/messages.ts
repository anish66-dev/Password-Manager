export const MIN_MASTER_PASSWORD_LENGTH = 10;
export const MAX_FIELD_LENGTH = 2048;
export const MIN_AUTOLOCK_MINUTES = 1;
export const MAX_AUTOLOCK_MINUTES = 240;
export const DEFAULT_AUTOLOCK_MINUTES = 10;

export type VaultStatus = "uninitialized" | "locked" | "unlocked";

export interface LoginFields {
  url: string;
  username: string;
  password: string;
}

export type ExtensionMessage =
  | { type: "POPUP_GET_STATUS" }
  | { type: "CONTENT_SCRIPT_PING"; payload: { url: string } }
  | { type: "VAULT_CREATE"; payload: { password: string } }
  | { type: "VAULT_UNLOCK"; payload: { password: string } }
  | { type: "VAULT_LOCK" }
  | { type: "VAULT_LIST"; payload: { query: string } }
  | { type: "VAULT_GET"; payload: { id: string } }
  | { type: "VAULT_ADD"; payload: LoginFields }
  | { type: "VAULT_UPDATE"; payload: LoginFields & { id: string } }
  | { type: "VAULT_DELETE"; payload: { id: string } }
  | { type: "VAULT_CHANGE_PASSWORD"; payload: { currentPassword: string; newPassword: string } }
  | { type: "VAULT_SET_AUTOLOCK"; payload: { minutes: number } };

/** Message types that only extension pages (the popup) may send. */
export function isExtensionPageOnlyMessage(msg: ExtensionMessage): boolean {
  return msg.type !== "CONTENT_SCRIPT_PING";
}

export interface PopupStatusResponseData {
  appName: string;
  version: string;
  status: VaultStatus;
  autoLockMinutes: number;
  timestamp: string;
}

export interface ContentScriptPingResponseData {
  acknowledged: boolean;
  receivedFromUrl: string;
  timestamp: string;
}

/** A login without its password, for list views. */
export interface LoginSummary {
  id: string;
  url: string;
  username: string;
  modified_at: string;
}

export interface LoginDetail extends LoginSummary {
  password: string;
}

export interface VaultListResponseData {
  entries: LoginSummary[];
  /** Number of stored records that failed authentication and were skipped. */
  rejected: number;
}

export interface VaultEntryResponseData {
  entry: LoginDetail;
}

export interface DoneResponseData {
  done: true;
}

export type ExtensionResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export type PopupStatusResponse = ExtensionResponse<PopupStatusResponseData>;
export type ContentScriptPingResponse = ExtensionResponse<ContentScriptPingResponseData>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, min = 0): value is string {
  return typeof value === "string" && value.length >= min && value.length <= MAX_FIELD_LENGTH;
}

function isLoginFields(payload: Record<string, unknown>): boolean {
  return (
    isBoundedString(payload["url"], 1) &&
    isBoundedString(payload["username"]) &&
    isBoundedString(payload["password"], 1)
  );
}

export function isValidAutoLockMinutes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_AUTOLOCK_MINUTES &&
    value <= MAX_AUTOLOCK_MINUTES
  );
}

/**
 * Validates untrusted input at the boundary to ensure it matches ExtensionMessage.
 */
export function isValidExtensionMessage(msg: unknown): msg is ExtensionMessage {
  if (!isObject(msg) || typeof msg["type"] !== "string") {
    return false;
  }
  const payload = msg["payload"];
  switch (msg["type"]) {
    case "POPUP_GET_STATUS":
    case "VAULT_LOCK":
      return true;
    case "CONTENT_SCRIPT_PING":
      return isObject(payload) && typeof payload["url"] === "string";
    case "VAULT_CREATE":
    case "VAULT_UNLOCK":
      return isObject(payload) && isBoundedString(payload["password"], 1);
    case "VAULT_LIST":
      return isObject(payload) && isBoundedString(payload["query"]);
    case "VAULT_GET":
    case "VAULT_DELETE":
      return isObject(payload) && isBoundedString(payload["id"], 1);
    case "VAULT_ADD":
      return isObject(payload) && isLoginFields(payload);
    case "VAULT_UPDATE":
      return isObject(payload) && isBoundedString(payload["id"], 1) && isLoginFields(payload);
    case "VAULT_CHANGE_PASSWORD":
      return (
        isObject(payload) &&
        isBoundedString(payload["currentPassword"], 1) &&
        isBoundedString(payload["newPassword"], 1)
      );
    case "VAULT_SET_AUTOLOCK":
      return isObject(payload) && isValidAutoLockMinutes(payload["minutes"]);
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
  if (!isObject(response) || typeof response["ok"] !== "boolean") {
    return false;
  }
  if (response["ok"] === true) {
    if (dataValidator) {
      return dataValidator(response["data"]);
    }
    return "data" in response;
  }
  return typeof response["error"] === "string";
}

export function isPopupStatusData(data: unknown): data is PopupStatusResponseData {
  return (
    isObject(data) &&
    typeof data["appName"] === "string" &&
    typeof data["version"] === "string" &&
    (data["status"] === "uninitialized" ||
      data["status"] === "locked" ||
      data["status"] === "unlocked") &&
    typeof data["autoLockMinutes"] === "number" &&
    typeof data["timestamp"] === "string"
  );
}

export function isContentScriptPingData(data: unknown): data is ContentScriptPingResponseData {
  return (
    isObject(data) &&
    typeof data["acknowledged"] === "boolean" &&
    typeof data["receivedFromUrl"] === "string" &&
    typeof data["timestamp"] === "string"
  );
}

function isLoginSummary(value: unknown): value is LoginSummary {
  return (
    isObject(value) &&
    typeof value["id"] === "string" &&
    typeof value["url"] === "string" &&
    typeof value["username"] === "string" &&
    typeof value["modified_at"] === "string"
  );
}

export function isVaultListData(data: unknown): data is VaultListResponseData {
  return (
    isObject(data) &&
    typeof data["rejected"] === "number" &&
    Array.isArray(data["entries"]) &&
    data["entries"].every(isLoginSummary)
  );
}

export function isVaultEntryData(data: unknown): data is VaultEntryResponseData {
  if (!isObject(data) || !isObject(data["entry"])) return false;
  return isLoginSummary(data["entry"]) && typeof data["entry"]["password"] === "string";
}

export function isDoneData(data: unknown): data is DoneResponseData {
  return isObject(data) && data["done"] === true;
}
