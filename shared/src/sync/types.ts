import { type Bytes } from "../crypto/index.js";
import { type StorageAdapter } from "../storage-adapter/index.js";
import { type RecordFile, type VaultHeader } from "../types/vault.js";
import { type LocalStore } from "../vault/vault.js";

/** What is known about one record's relationship with the cloud. */
export interface RecordSyncEntry {
  /** record_version of the copy that was last in sync with the cloud. */
  last_synced_version: number;
  /** Provider file ID. Names are not unique in Drive, so the ID is remembered. */
  file_id: string | null;
  /** The cloud revision marker (checksum or modified time) seen at the last sync. */
  revision: string | null;
}

export interface HeaderSyncEntry {
  file_id: string | null;
  revision: string | null;
  /** header_version of the local header at the last sync. */
  last_synced_header_version: number;
  /** Highest header_version seen in the cloud. A local header is never uploaded below it. */
  remote_header_version: number;
}

/**
 * Sync index, stored beside the vault. A record has a pending local change exactly when its
 * local record_version is higher than last_synced_version (or it has no entry yet), so
 * "pending" is derived, never stored separately. Contains no secrets.
 */
export interface SyncState {
  records: Record<string, RecordSyncEntry>;
  header: HeaderSyncEntry | null;
  /** A newer header found in the cloud, waiting for the new master password. */
  pending_remote_header: VaultHeader | null;
  last_sync_at: string | null;
}

export function emptySyncState(): SyncState {
  return { records: {}, header: null, pending_remote_header: null, last_sync_at: null };
}

export interface SyncStateStore {
  load(): Promise<SyncState>;
  save(state: SyncState): Promise<void>;
}

export class InMemorySyncStateStore implements SyncStateStore {
  private state: SyncState = emptySyncState();

  async load(): Promise<SyncState> {
    return structuredClone(this.state);
  }

  async save(state: SyncState): Promise<void> {
    this.state = structuredClone(state);
  }
}

export type HeaderStatus =
  | "unchanged"
  | "uploaded"
  /** The cloud has a newer header: the new master password is needed to adopt it. */
  | "remote-newer"
  /** The cloud header is not a valid vault header and was left alone. */
  | "remote-invalid"
  /** The cloud holds a different vault than this device. Nothing is merged. */
  | "vault-mismatch";

export type RejectReason = "auth" | "format" | "name-mismatch";

export interface SyncReport {
  uploaded: number;
  downloaded: number;
  /** Conflict copies created. */
  conflicts: number;
  /** Cloud files that failed verification. They are reported and never merged. */
  rejected: Array<{ record_id: string; reason: RejectReason }>;
  /** Records whose cloud copy was older than what was already synced and was ignored. */
  stale: string[];
  duplicatesRemoved: number;
  headerStatus: HeaderStatus;
  /** Local changes still waiting to be uploaded after this run. */
  pending: number;
}

export interface SyncDeps {
  store: LocalStore;
  state: SyncStateStore;
  adapter: StorageAdapter;
  /** Needed to verify and decrypt cloud records. Sync cannot run while the vault is locked. */
  vek: Bytes;
  now?: () => Date;
}

export type { RecordFile };
