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
  | { type: "VAULT_SET_AUTOLOCK"; payload: { minutes: number } }
  | { type: "LOGIN_FIELD_FOCUSED" }
  | { type: "FILL_REQUEST"; payload: { id: string } }
  | { type: "FRAME_REGISTER"; payload: { nonce: string } }
  | { type: "FRAME_CLAIM"; payload: { nonce: string } }
  | { type: "CREDENTIAL_CAPTURED"; payload: CapturedCredentials }
  | { type: "PENDING_CAPTURE_GET" }
  | { type: "CAPTURE_DECISION"; payload: { decision: CaptureDecision } }
  | { type: "SYNC_GET_STATUS" }
  | { type: "SYNC_SIGN_IN" }
  | { type: "SYNC_SIGN_OUT" }
  | { type: "SYNC_NOW" }
  | { type: "SYNC_CHECK_REMOTE" }
  | { type: "SYNC_SETUP_FROM_CLOUD"; payload: { password: string } }
  | { type: "SYNC_APPLY_NEW_PASSWORD"; payload: { password: string } };

export type CaptureKind = "register" | "change";

/** What the user's decision on a save/update prompt means. The worker picks add vs update. */
export type CaptureDecision = "accept" | "never" | "dismiss";

export interface CapturedCredentials {
  kind: CaptureKind;
  username: string;
  password: string;
}

export type SenderKind = "extension-page" | "content-script" | "suggestion-frame";

/** Which kind of sender may send each message type. Enforced by the service worker. */
export function allowedSenderKind(msg: ExtensionMessage): SenderKind {
  switch (msg.type) {
    case "CONTENT_SCRIPT_PING":
    case "LOGIN_FIELD_FOCUSED":
    case "FILL_REQUEST":
    case "FRAME_REGISTER":
    case "CREDENTIAL_CAPTURED":
    case "PENDING_CAPTURE_GET":
    case "CAPTURE_DECISION":
      return "content-script";
    case "FRAME_CLAIM":
      return "suggestion-frame";
    default:
      return "extension-page";
  }
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
  /** True for a conflict copy: a version that lost a sync conflict and was kept. */
  conflict: boolean;
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

/** A saved login offered on a page. Never contains the password. */
export interface Suggestion {
  id: string;
  username: string;
  /** Registrable domain of the saved login, for display. */
  displayDomain: string;
}

export type FocusState = "ineligible" | "uninitialized" | "locked" | "ready";

export interface FocusResponseData {
  state: FocusState;
  suggestions: Suggestion[];
}

export interface FillResponseData {
  username: string;
  password: string;
}

/**
 * What the save/update prompt shows. The password itself never leaves the service worker:
 * the prompt only gets its length so it can draw masked dots.
 */
export interface CapturePrompt {
  mode: "save" | "update" | "unlock";
  /** Registrable domain, for display. */
  site: string;
  username: string;
  passwordLength: number;
}

export interface CapturePromptResponseData {
  prompt: CapturePrompt | null;
}

export type SyncPhase = "off" | "idle" | "syncing" | "pending" | "error";

export interface SyncStatusData {
  /** Sync has been set up with a cloud sign-in. */
  enabled: boolean;
  phase: SyncPhase;
  lastSyncAt: string | null;
  /** Local changes not yet uploaded. */
  pendingChanges: number;
  /** A fixed, secret-free message about the last failure, if any. */
  error: string | null;
  /** The master password was changed on another device: the new password is needed. */
  needsNewPassword: boolean;
  /** Cloud files from the last run that failed verification and were skipped. */
  rejected: number;
}

export interface RemoteVaultData {
  exists: boolean;
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

function isUuidLike(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
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
    case "LOGIN_FIELD_FOCUSED":
      return true;
    case "FILL_REQUEST":
      return isObject(payload) && isBoundedString(payload["id"], 1);
    case "FRAME_REGISTER":
    case "FRAME_CLAIM":
      return isObject(payload) && isUuidLike(payload["nonce"]);
    case "PENDING_CAPTURE_GET":
    case "SYNC_GET_STATUS":
    case "SYNC_SIGN_IN":
    case "SYNC_SIGN_OUT":
    case "SYNC_NOW":
    case "SYNC_CHECK_REMOTE":
      return true;
    case "SYNC_SETUP_FROM_CLOUD":
    case "SYNC_APPLY_NEW_PASSWORD":
      return isObject(payload) && isBoundedString(payload["password"], 1);
    case "CREDENTIAL_CAPTURED":
      return (
        isObject(payload) &&
        (payload["kind"] === "register" || payload["kind"] === "change") &&
        isBoundedString(payload["username"]) &&
        isBoundedString(payload["password"], 1)
      );
    case "CAPTURE_DECISION":
      return (
        isObject(payload) &&
        (payload["decision"] === "accept" ||
          payload["decision"] === "never" ||
          payload["decision"] === "dismiss")
      );
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
    typeof value["conflict"] === "boolean" &&
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

function isSuggestion(value: unknown): value is Suggestion {
  return (
    isObject(value) &&
    typeof value["id"] === "string" &&
    typeof value["username"] === "string" &&
    typeof value["displayDomain"] === "string"
  );
}

export function isFocusData(data: unknown): data is FocusResponseData {
  return (
    isObject(data) &&
    (data["state"] === "ineligible" ||
      data["state"] === "uninitialized" ||
      data["state"] === "locked" ||
      data["state"] === "ready") &&
    Array.isArray(data["suggestions"]) &&
    data["suggestions"].every(isSuggestion)
  );
}

export function isFillData(data: unknown): data is FillResponseData {
  return (
    isObject(data) && typeof data["username"] === "string" && typeof data["password"] === "string"
  );
}

export function isCapturePrompt(value: unknown): value is CapturePrompt {
  return (
    isObject(value) &&
    (value["mode"] === "save" || value["mode"] === "update" || value["mode"] === "unlock") &&
    typeof value["site"] === "string" &&
    typeof value["username"] === "string" &&
    typeof value["passwordLength"] === "number"
  );
}

export function isCapturePromptData(data: unknown): data is CapturePromptResponseData {
  return isObject(data) && (data["prompt"] === null || isCapturePrompt(data["prompt"]));
}

export function isSyncStatusData(data: unknown): data is SyncStatusData {
  return (
    isObject(data) &&
    typeof data["enabled"] === "boolean" &&
    (data["phase"] === "off" ||
      data["phase"] === "idle" ||
      data["phase"] === "syncing" ||
      data["phase"] === "pending" ||
      data["phase"] === "error") &&
    (data["lastSyncAt"] === null || typeof data["lastSyncAt"] === "string") &&
    typeof data["pendingChanges"] === "number" &&
    (data["error"] === null || typeof data["error"] === "string") &&
    typeof data["needsNewPassword"] === "boolean" &&
    typeof data["rejected"] === "number"
  );
}

export function isRemoteVaultData(data: unknown): data is RemoteVaultData {
  return isObject(data) && typeof data["exists"] === "boolean";
}
