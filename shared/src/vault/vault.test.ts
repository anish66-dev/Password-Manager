import { describe, it, expect } from "vitest";
import {
  InMemoryLocalStore,
  Vault,
  VaultError,
  createVault,
  unlock,
  unlockVek,
  type VaultOptions,
} from "./vault.js";
import { VaultCryptoError, decryptRecord } from "../crypto/index.js";

const options: VaultOptions = { kdf: { memory_kib: 64, iterations: 1, parallelism: 1 } };
const PASSWORD = "first-master-password";

async function newVault(): Promise<{ store: InMemoryLocalStore; vault: Vault }> {
  const store = new InMemoryLocalStore();
  const vault = await createVault(PASSWORD, store, options);
  return { store, vault };
}

describe("vault lifecycle", () => {
  it("creates a header with the planned shape and refuses a second vault", async () => {
    const { store } = await newVault();
    const header = await store.getHeader();
    expect(header?.format_version).toBe(1);
    expect(header?.header_version).toBe(1);
    expect(header?.kdf).toBe("argon2id");
    expect(header?.memory_kib).toBe(64);
    await expect(createVault("another-password", store, options)).rejects.toThrow(VaultError);
  });

  it("unlocks with the right password and rejects a wrong one", async () => {
    const { store, vault } = await newVault();
    const entry = await vault.add({ url: "https://a.example", username: "u", password: "p" });

    const again = await unlock(PASSWORD, store, options);
    expect((await again.get(entry.id)).password).toBe("p");

    await expect(unlock("wrong-password", store, options)).rejects.toMatchObject({
      code: "BAD_PASSWORD",
    });
    await expect(unlock(PASSWORD, new InMemoryLocalStore())).rejects.toMatchObject({
      code: "NO_VAULT",
    });
  });

  it("rejects a malformed or tampered header", async () => {
    const { store } = await newVault();
    const header = await store.getHeader();
    if (!header) throw new Error("no header");
    await expect(unlockVek(PASSWORD, { ...header, salt: "!!!" })).rejects.toThrow(VaultCryptoError);
    await expect(unlockVek(PASSWORD, { ...header, format_version: 2 })).rejects.toMatchObject({
      code: "BAD_PASSWORD",
    });
    await expect(unlockVek(PASSWORD, { ...header, iterations: 1000 })).rejects.toThrow(
      VaultCryptoError
    );
  });
});

describe("credentials", () => {
  it("adds, lists, searches, updates and deletes (tombstone)", async () => {
    const { store, vault } = await newVault();
    const a = await vault.add({ url: "https://github.com", username: "alice", password: "pw1" });
    const b = await vault.add({ url: "https://bank.example", username: "bob", password: "pw2" });
    expect(a.record_version).toBe(1);

    expect((await vault.list()).map((e) => e.url)).toEqual([
      "https://bank.example",
      "https://github.com",
    ]);
    expect((await vault.search("GIT")).entries.map((e) => e.id)).toEqual([a.id]);
    expect((await vault.search("bob")).entries.map((e) => e.id)).toEqual([b.id]);
    expect((await vault.search("nothing")).entries).toEqual([]);

    const updated = await vault.update(a.id, {
      url: "https://github.com",
      username: "alice",
      password: "new-pw",
    });
    expect(updated.record_version).toBe(2);
    expect((await vault.get(a.id)).password).toBe("new-pw");
    expect(updated.created_at).toBe(a.created_at);

    await vault.delete(a.id);
    expect((await vault.list()).map((e) => e.id)).toEqual([b.id]);
    await expect(vault.get(a.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(vault.update(a.id, { url: "x", username: "y", password: "z" })).rejects.toThrow(
      VaultError
    );

    const tombstone = await store.getRecord(a.id);
    expect(tombstone?.record_version).toBe(3);
    const payload = await decryptRecord(vault.exportSessionKey(), tombstone!);
    expect(payload).toMatchObject({ kind: "login", deleted: true, password: "", username: "" });
  });

  it("stores only ciphertext", async () => {
    const { store, vault } = await newVault();
    await vault.add({
      url: "https://secret.example",
      username: "uniqueuser",
      password: "uniquepw",
    });
    const serialized = JSON.stringify([await store.getHeader(), await store.listRecords()]);
    for (const needle of ["secret.example", "uniqueuser", "uniquepw", PASSWORD]) {
      expect(serialized).not.toContain(needle);
    }
  });

  it("skips and reports records that fail authentication", async () => {
    const { store, vault } = await newVault();
    const good = await vault.add({ url: "https://ok.example", username: "u", password: "p" });
    const bad = await vault.add({ url: "https://bad.example", username: "u", password: "p" });
    const file = await store.getRecord(bad.id);
    await store.putRecord({ ...file!, record_version: file!.record_version + 5 });

    const result = await vault.readAll();
    expect(result.entries.map((e) => e.id)).toEqual([good.id]);
    expect(result.rejectedIds).toEqual([bad.id]);
  });
});

describe("master password change", () => {
  it("keeps every record readable with the new password only", async () => {
    const { store, vault } = await newVault();
    const entry = await vault.add({ url: "https://a.example", username: "u", password: "p" });
    const before = await store.getHeader();
    const recordBefore = await store.getRecord(entry.id);

    await vault.changeMasterPassword(PASSWORD, "second-master-password");

    const after = await store.getHeader();
    expect(after?.header_version).toBe((before?.header_version ?? 0) + 1);
    expect(after?.salt).not.toBe(before?.salt);
    expect(after?.wrapped_vek).not.toEqual(before?.wrapped_vek);
    expect(await store.getRecord(entry.id)).toEqual(recordBefore); // records untouched

    const reopened = await unlock("second-master-password", store, options);
    expect((await reopened.get(entry.id)).password).toBe("p");
    await expect(unlock(PASSWORD, store, options)).rejects.toMatchObject({ code: "BAD_PASSWORD" });
  });

  it("requires the correct current password", async () => {
    const { store, vault } = await newVault();
    await expect(vault.changeMasterPassword("not-the-password", "whatever-new")).rejects.toThrow(
      VaultError
    );
    expect((await store.getHeader())?.header_version).toBe(1);
  });
});
