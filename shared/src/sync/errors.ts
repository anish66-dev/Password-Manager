export type SyncErrorCode =
  "NO_VAULT" | "NO_REMOTE_VAULT" | "NO_PENDING_HEADER" | "ALREADY_EXISTS" | "VAULT_MISMATCH";

const MESSAGES: Record<SyncErrorCode, string> = {
  NO_VAULT: "There is no local vault to sync.",
  NO_REMOTE_VAULT: "No vault was found in the cloud folder.",
  NO_PENDING_HEADER: "There is no newer master password to apply.",
  ALREADY_EXISTS: "A vault already exists on this device.",
  VAULT_MISMATCH: "The cloud folder holds a different vault than this device. Nothing was merged.",
};

/** Fixed-message sync failures that are safe to show to the user. */
export class SyncError extends Error {
  readonly code: SyncErrorCode;

  constructor(code: SyncErrorCode) {
    super(MESSAGES[code]);
    this.name = "SyncError";
    this.code = code;
  }
}
