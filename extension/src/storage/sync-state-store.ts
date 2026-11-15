import {
  type SyncState,
  type SyncStateStore,
  emptySyncState,
  isValidVaultHeader,
} from "@password-manager/shared";
import { openVaultDb } from "./db.js";

const STORE = "sync";
const KEY = "state";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accepts only a well-formed sync index; anything else starts over (the cloud is the truth). */
function parseState(value: unknown): SyncState {
  if (!isObject(value) || !isObject(value["records"])) return emptySyncState();
  const header = value["header"];
  const pending = value["pending_remote_header"];
  return {
    records: value["records"] as SyncState["records"],
    header: isObject(header) ? (header as unknown as SyncState["header"]) : null,
    pending_remote_header: isValidVaultHeader(pending) ? pending : null,
    last_sync_at: typeof value["last_sync_at"] === "string" ? value["last_sync_at"] : null,
  };
}

/**
 * IndexedDB home of the sync index: per record the last synced version, the cloud file ID and
 * revision marker. It holds no keys, no plaintext and no tokens.
 */
export class IndexedDbSyncStateStore implements SyncStateStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory = indexedDB) {}

  private open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openVaultDb(this.factory).catch((err) => {
        this.dbPromise = null;
        throw err;
      });
    }
    return this.dbPromise;
  }

  async load(): Promise<SyncState> {
    const db = await this.open();
    const value = await new Promise<unknown>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error("Storage request failed."));
    });
    return parseState(value);
  }

  async save(state: SyncState): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(state, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error("Storage transaction failed."));
      tx.onabort = () => reject(new Error("Storage transaction aborted."));
    });
  }
}
