import {
  type LocalStore,
  type RecordFile,
  type VaultHeader,
  isValidRecordFile,
  isValidVaultHeader,
} from "@password-manager/shared";
import { openVaultDb } from "./db.js";

const META_STORE = "meta";
const RECORD_STORE = "records";
const HEADER_KEY = "header";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error("Storage request failed."));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error("Storage transaction failed."));
    tx.onabort = () => reject(new Error("Storage transaction aborted."));
  });
}

/**
 * IndexedDB implementation of LocalStore. Holds the header and the record files as they
 * exist in the cloud (already ciphertext). No key or plaintext ever reaches this class.
 */
export class IndexedDbLocalStore implements LocalStore {
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

  async getHeader(): Promise<VaultHeader | null> {
    const db = await this.open();
    const value = await request(db.transaction(META_STORE).objectStore(META_STORE).get(HEADER_KEY));
    if (value === undefined) return null;
    if (!isValidVaultHeader(value)) {
      throw new Error("Stored vault header is malformed.");
    }
    return value;
  }

  async putHeader(header: VaultHeader): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).put(header, HEADER_KEY);
    await transactionDone(tx);
  }

  async getRecord(recordId: string): Promise<RecordFile | null> {
    const db = await this.open();
    const value = await request(
      db.transaction(RECORD_STORE).objectStore(RECORD_STORE).get(recordId)
    );
    if (value === undefined) return null;
    if (!isValidRecordFile(value)) {
      throw new Error("Stored record is malformed.");
    }
    return value;
  }

  async putRecord(record: RecordFile): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(RECORD_STORE, "readwrite");
    tx.objectStore(RECORD_STORE).put(record);
    await transactionDone(tx);
  }

  async listRecords(): Promise<RecordFile[]> {
    const db = await this.open();
    const all = await request(db.transaction(RECORD_STORE).objectStore(RECORD_STORE).getAll());
    return all.filter(isValidRecordFile);
  }
}
