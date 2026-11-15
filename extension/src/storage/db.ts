export const DB_NAME = "pm-vault";
/** Version 2 added the "sync" store (the sync index). */
export const DB_VERSION = 2;

/** Opens the vault database, creating or upgrading its stores. Ciphertext and sync index only. */
export function openVaultDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta");
      }
      if (!db.objectStoreNames.contains("records")) {
        db.createObjectStore("records", { keyPath: "record_id" });
      }
      if (!db.objectStoreNames.contains("sync")) {
        db.createObjectStore("sync");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error("Could not open local storage."));
  });
}
