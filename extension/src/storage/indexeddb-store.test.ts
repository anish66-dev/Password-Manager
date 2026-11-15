import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { Vault, createVault, unlock } from "@password-manager/shared";
import { IndexedDbLocalStore } from "./indexeddb-store.js";
import { IndexedDbSyncStateStore } from "./sync-state-store.js";

const KDF = { memory_kib: 64, iterations: 1, parallelism: 1 };

async function dumpDatabase(factory: IDBFactory): Promise<string> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open("pm-vault");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const out: unknown[] = [];
  for (const name of Array.from(db.objectStoreNames)) {
    const all = await new Promise<unknown[]>((resolve, reject) => {
      const req = db.transaction(name).objectStore(name).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    out.push(name, all);
  }
  db.close();
  return JSON.stringify(out);
}

describe("IndexedDbLocalStore", () => {
  it("persists the header and records and survives re-opening", async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbLocalStore(factory);
    expect(await store.getHeader()).toBeNull();

    const vault = await createVault("a-long-master-password", store, { kdf: KDF });
    const entry = await vault.add({ url: "https://a.example", username: "u", password: "p" });

    const reopened = new IndexedDbLocalStore(factory);
    const again = await unlock("a-long-master-password", reopened, { kdf: KDF });
    expect((await again.get(entry.id)).password).toBe("p");
    expect(await reopened.listRecords()).toHaveLength(1);
    expect(await reopened.getRecord("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("contains no plaintext credentials and no key", async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbLocalStore(factory);
    const vault: Vault = await createVault("a-long-master-password", store, { kdf: KDF });
    await vault.add({ url: "https://plain.example", username: "plainuser", password: "plainpass" });

    const dump = await dumpDatabase(factory);
    for (const needle of ["plain.example", "plainuser", "plainpass", "a-long-master-password"]) {
      expect(dump).not.toContain(needle);
    }
    const vekBase64 = Buffer.from(vault.exportSessionKey()).toString("base64");
    expect(dump).not.toContain(vekBase64);
  });
});

describe("IndexedDbSyncStateStore", () => {
  it("starts empty, persists the index, and survives re-opening", async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbSyncStateStore(factory);
    expect(await store.load()).toEqual({
      records: {},
      header: null,
      pending_remote_header: null,
      last_sync_at: null,
    });

    const state = await store.load();
    state.records["abc"] = { last_synced_version: 3, file_id: "f1", revision: "r1" };
    state.last_sync_at = "2026-01-01T00:00:00.000Z";
    await store.save(state);

    const again = await new IndexedDbSyncStateStore(factory).load();
    expect(again.records["abc"]).toEqual({ last_synced_version: 3, file_id: "f1", revision: "r1" });
    expect(again.last_sync_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("upgrades an existing version 1 vault database without losing records", async () => {
    const factory = new IDBFactory();
    // A database as Phase 2 created it: no "sync" store.
    await new Promise<void>((resolve, reject) => {
      const req = factory.open("pm-vault", 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("meta");
        req.result.createObjectStore("records", { keyPath: "record_id" });
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });

    const store = new IndexedDbLocalStore(factory);
    const vault = await createVault("a-long-master-password", store, { kdf: KDF });
    await vault.add({ url: "https://a.example", username: "u", password: "p" });

    const sync = new IndexedDbSyncStateStore(factory);
    await sync.save({ ...(await sync.load()), last_sync_at: "x" });
    expect(await store.listRecords()).toHaveLength(1);
  });

  it("stores no secrets: the index holds only versions, file IDs and revisions", async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbLocalStore(factory);
    const vault: Vault = await createVault("a-long-master-password", store, { kdf: KDF });
    await vault.add({ url: "https://plain.example", username: "plainuser", password: "plainpass" });
    const sync = new IndexedDbSyncStateStore(factory);
    await sync.save({ ...(await sync.load()), last_sync_at: "2026-01-01T00:00:00.000Z" });

    const dump = await dumpDatabase(factory);
    for (const needle of ["plain.example", "plainuser", "plainpass", "a-long-master-password"]) {
      expect(dump).not.toContain(needle);
    }
  });
});
