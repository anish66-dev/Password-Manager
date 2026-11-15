import { describe, it, expect, beforeEach } from "vitest";
import { type Bytes, toBase64 } from "../crypto/index.js";
import { InMemoryStorageAdapter, StorageError } from "../storage-adapter/index.js";
import {
  InMemoryLocalStore,
  Vault,
  VaultError,
  createVault,
  unlock,
  type LoginEntry,
} from "../vault/vault.js";
import {
  InMemorySyncStateStore,
  SyncError,
  adoptPendingHeader,
  countPending,
  findRemoteHeader,
  setupFromRemote,
  syncOnce,
  type SyncReport,
} from "./index.js";

const KDF = { memory_kib: 64, iterations: 1, parallelism: 1 };
const PASSWORD = "first-master-password";

/** Shared fake clock, so tests control which edit is "later". */
const clock = { t: Date.UTC(2026, 0, 1) };
const now = () => new Date(clock.t);
const tick = (ms = 1000) => {
  clock.t += ms;
};

/** One simulated device: its own local store, sync index and vault, sharing one cloud folder. */
class Device {
  readonly store = new InMemoryLocalStore();
  readonly state = new InMemorySyncStateStore();
  vault!: Vault;
  vek!: Bytes;

  constructor(readonly cloud: InMemoryStorageAdapter) {}

  async create(password = PASSWORD): Promise<this> {
    this.vault = await createVault(password, this.store, { kdf: KDF, now });
    this.vek = this.vault.exportSessionKey();
    return this;
  }

  async join(password = PASSWORD): Promise<this> {
    this.vek = await setupFromRemote(password, {
      adapter: this.cloud,
      store: this.store,
      state: this.state,
    });
    this.vault = Vault.fromVek(this.store, this.vek, { kdf: KDF, now });
    return this;
  }

  sync(): Promise<SyncReport> {
    return syncOnce({
      store: this.store,
      state: this.state,
      adapter: this.cloud,
      vek: this.vek,
      now,
    });
  }

  pending(): Promise<number> {
    return countPending(this.store, this.state);
  }

  async entries(): Promise<LoginEntry[]> {
    return this.vault.list();
  }

  async passwords(): Promise<string[]> {
    return (await this.entries()).map((e) => e.password).sort();
  }
}

let cloud: InMemoryStorageAdapter;
let a: Device;

beforeEach(async () => {
  clock.t = Date.UTC(2026, 0, 1);
  cloud = new InMemoryStorageAdapter();
  a = await new Device(cloud).create();
});

async function twoDevices(): Promise<{ a: Device; b: Device; id: string }> {
  const entry = await a.vault.add({ url: "https://site.example", username: "u", password: "v1" });
  await a.sync();
  const b = await new Device(cloud).join();
  await b.sync();
  return { a, b, id: entry.id };
}

describe("first device", () => {
  it("uploads the header and every record, and only ciphertext leaves the device", async () => {
    await a.vault.add({
      url: "https://secret.example",
      username: "uniqueuser",
      password: "uniquepw",
    });
    await a.vault.addNeverSave("never.example");
    const report = await a.sync();

    expect(report.headerStatus).toBe("uploaded");
    expect(report.uploaded).toBe(2);
    const names = cloud.names();
    expect(names.filter((n) => n === "header.json")).toHaveLength(1);
    expect(names.filter((n) => /^[0-9a-f-]{36}\.json$/.test(n))).toHaveLength(2);
    expect(names).toHaveLength(3);

    const everything = cloud.dump() + cloud.uploads.map((u) => u.content).join("");
    for (const secret of [
      "secret.example",
      "uniqueuser",
      "uniquepw",
      "never.example",
      PASSWORD,
      toBase64(a.vek),
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("a second run changes nothing", async () => {
    await a.vault.add({ url: "https://a.example", username: "u", password: "p" });
    await a.sync();
    const uploadsBefore = cloud.uploads.length;
    const report = await a.sync();
    expect(report).toMatchObject({ uploaded: 0, downloaded: 0, conflicts: 0, pending: 0 });
    expect(cloud.uploads.length).toBe(uploadsBefore);
  });

  it("tracks pending changes until they are uploaded", async () => {
    expect(await a.pending()).toBe(1); // the header
    await a.sync();
    expect(await a.pending()).toBe(0);
    await a.vault.add({ url: "https://a.example", username: "u", password: "p" });
    expect(await a.pending()).toBe(1);
    expect((await a.sync()).pending).toBe(0);
  });
});

describe("new device", () => {
  it("sets up from only the storage and the master password", async () => {
    const entry = await a.vault.add({ url: "https://a.example", username: "u", password: "p" });
    await a.sync();

    const b = await new Device(cloud).join();
    const report = await b.sync();
    expect(report.downloaded).toBe(1);
    expect((await b.vault.get(entry.id)).password).toBe("p");
  });

  it("a wrong master password stores nothing", async () => {
    await a.sync();
    const b = new Device(cloud);
    await expect(
      setupFromRemote("not-the-password", { adapter: cloud, store: b.store, state: b.state })
    ).rejects.toThrow(VaultError);
    expect(await b.store.getHeader()).toBeNull();
    expect((await b.state.load()).header).toBeNull();
  });

  it("fails clearly when the cloud holds no vault or the device already has one", async () => {
    const b = new Device(cloud);
    await expect(
      setupFromRemote(PASSWORD, { adapter: cloud, store: b.store, state: b.state })
    ).rejects.toMatchObject({ code: "NO_REMOTE_VAULT" });
    await a.sync();
    await expect(
      setupFromRemote(PASSWORD, { adapter: cloud, store: a.store, state: a.state })
    ).rejects.toThrow(SyncError);
    expect((await findRemoteHeader(cloud))?.header.header_version).toBe(1);
  });
});

describe("edits and deletes", () => {
  it("syncs an edit in both directions", async () => {
    const { a, b, id } = await twoDevices();
    tick();
    await a.vault.update(id, { url: "https://site.example", username: "u", password: "from-a" });
    await a.sync();
    await b.sync();
    expect((await b.vault.get(id)).password).toBe("from-a");

    tick();
    await b.vault.update(id, { url: "https://site.example", username: "u", password: "from-b" });
    await b.sync();
    await a.sync();
    expect((await a.vault.get(id)).password).toBe("from-b");
  });

  it("syncs a delete as a tombstone", async () => {
    const { a, b, id } = await twoDevices();
    tick();
    await a.vault.delete(id);
    await a.sync();
    expect((await b.sync()).downloaded).toBe(1);
    expect(await b.entries()).toEqual([]);
    await expect(b.vault.get(id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The file is still in the cloud, as a higher version, not removed.
    expect(cloud.names().filter((n) => n === `${id}.json`)).toHaveLength(1);
  });

  it("syncs never-save sites", async () => {
    const { a, b } = await twoDevices();
    await a.vault.addNeverSave("never.example");
    await a.sync();
    await b.sync();
    expect(await b.vault.readNeverSave()).toEqual(["never.example"]);
  });
});

describe("offline", () => {
  it("queues edits while offline and syncs them after reconnecting", async () => {
    const { a, b, id } = await twoDevices();
    cloud.offline = true;
    tick();
    await a.vault.update(id, {
      url: "https://site.example",
      username: "u",
      password: "offline-edit",
    });
    await expect(a.sync()).rejects.toThrow(StorageError);
    expect(await a.pending()).toBe(1);
    expect((await a.vault.get(id)).password).toBe("offline-edit"); // still usable locally

    cloud.offline = false;
    expect((await a.sync()).pending).toBe(0);
    await b.sync();
    expect((await b.vault.get(id)).password).toBe("offline-edit");
  });

  it("surfaces sign-in and rate-limit errors without losing anything", async () => {
    const { a, id } = await twoDevices();
    tick();
    await a.vault.update(id, { url: "https://site.example", username: "u", password: "queued" });
    cloud.failNext("AUTH");
    await expect(a.sync()).rejects.toMatchObject({ code: "AUTH" });
    cloud.failNext("RATE_LIMITED");
    await expect(a.sync()).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(await a.pending()).toBe(1);
    expect((await a.sync()).pending).toBe(0);
  });
});

describe("conflicts", () => {
  async function offlineEdits(
    first: { who: "a" | "b"; password: string; after: number },
    second: { who: "a" | "b"; password: string; after: number }
  ) {
    const { a, b, id } = await twoDevices();
    const devices = { a, b };
    cloud.offline = true;
    for (const edit of [first, second]) {
      clock.t += edit.after;
      await devices[edit.who].vault.update(id, {
        url: "https://site.example",
        username: "u",
        password: edit.password,
      });
    }
    cloud.offline = false;
    return { a, b, id };
  }

  async function converge(a: Device, b: Device): Promise<void> {
    await a.sync();
    await b.sync();
    await a.sync();
    await b.sync();
  }

  it("keeps the later edit as current and the other as a conflict copy (local later)", async () => {
    const { a, b, id } = await offlineEdits(
      { who: "a", password: "edit-from-a", after: 1000 },
      { who: "b", password: "edit-from-b", after: 1000 }
    );
    await converge(a, b);

    for (const device of [a, b]) {
      expect((await device.vault.get(id)).password).toBe("edit-from-b");
      const copies = (await device.entries()).filter((e) => e.conflict_of === id);
      expect(copies.map((c) => c.password)).toEqual(["edit-from-a"]);
      expect(await device.passwords()).toEqual(["edit-from-a", "edit-from-b"]);
    }
  });

  it("keeps the later edit as current and the other as a conflict copy (remote later)", async () => {
    const { a, b, id } = await offlineEdits(
      { who: "b", password: "edit-from-b", after: 1000 },
      { who: "a", password: "edit-from-a", after: 1000 }
    );
    await converge(a, b);

    for (const device of [a, b]) {
      expect((await device.vault.get(id)).password).toBe("edit-from-a");
      const copies = (await device.entries()).filter((e) => e.conflict_of === id);
      expect(copies.map((c) => c.password)).toEqual(["edit-from-b"]);
    }
  });

  it("never loses either edit and creates exactly one copy even if both devices resolve it", async () => {
    const { a, b } = await offlineEdits(
      { who: "a", password: "edit-from-a", after: 1000 },
      { who: "b", password: "edit-from-b", after: 1000 }
    );
    const [ra, rb] = [await a.sync(), await b.sync()];
    await converge(a, b);
    expect(ra.conflicts + rb.conflicts).toBeGreaterThanOrEqual(1);
    expect((await a.entries()).length).toBe(2);
    expect((await b.entries()).length).toBe(2);
    expect(cloud.names().filter((n) => n !== "header.json")).toHaveLength(2);
  });

  it("a delete that loses to a later edit leaves the edit alone", async () => {
    const { a, b, id } = await twoDevices();
    cloud.offline = true;
    tick();
    await a.vault.delete(id);
    tick(5000);
    await b.vault.update(id, { url: "https://site.example", username: "u", password: "kept-edit" });
    cloud.offline = false;
    await converge(a, b);
    for (const device of [a, b]) {
      expect((await device.vault.get(id)).password).toBe("kept-edit");
      expect((await device.entries()).filter((e) => e.conflict_of)).toEqual([]);
    }
  });

  it("an edit that loses to a later delete is kept as a conflict copy", async () => {
    const { a, b, id } = await twoDevices();
    cloud.offline = true;
    tick();
    await b.vault.update(id, { url: "https://site.example", username: "u", password: "late-edit" });
    tick(5000);
    await a.vault.delete(id);
    cloud.offline = false;
    await converge(a, b);
    for (const device of [a, b]) {
      await expect(device.vault.get(id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      const rest = await device.entries();
      expect(rest.map((e) => e.password)).toEqual(["late-edit"]);
      expect(rest[0]?.conflict_of).toBe(id);
    }
  });

  it("a conflict copy is an ordinary record: it can be deleted and the delete syncs", async () => {
    const { a, b, id } = await offlineEdits(
      { who: "a", password: "edit-from-a", after: 1000 },
      { who: "b", password: "edit-from-b", after: 1000 }
    );
    await converge(a, b);
    const copy = (await b.entries()).find((e) => e.conflict_of === id);
    expect(copy).toBeDefined();
    tick();
    await b.vault.delete(copy!.id);
    await converge(a, b);
    expect((await a.entries()).map((e) => e.password)).toEqual(["edit-from-b"]);
  });

  it("deleting on both devices converges without a conflict copy", async () => {
    const { a, b, id } = await twoDevices();
    cloud.offline = true;
    tick();
    await a.vault.delete(id);
    tick();
    await b.vault.delete(id);
    cloud.offline = false;
    await converge(a, b);
    expect(await a.entries()).toEqual([]);
    expect(await b.entries()).toEqual([]);
  });
});

describe("stale, tampered and swapped files", () => {
  it("ignores an older cloud copy as stale, never merges it, and restores the newer one", async () => {
    const { a, b, id } = await twoDevices();
    const oldCopy = cloud.snapshot(`${id}.json`);
    tick();
    await a.vault.update(id, { url: "https://site.example", username: "u", password: "v2" });
    await a.sync();
    await b.sync();
    const current = cloud.snapshot(`${id}.json`);

    cloud.restore(`${id}.json`, oldCopy); // the provider serves an old copy
    const report = await b.sync();
    expect(report.stale).toEqual([id]);
    expect((await b.vault.get(id)).password).toBe("v2");
    expect(cloud.snapshot(`${id}.json`)).toBe(current); // healed
    expect((await a.sync()).stale).toEqual([]);
  });

  it("rejects and reports a tampered file, and never merges it", async () => {
    const { a, b, id } = await twoDevices();
    tick();
    await a.vault.update(id, { url: "https://site.example", username: "u", password: "v2" });
    await a.sync();
    cloud.tamper(`${id}.json`, (content) => {
      const file = JSON.parse(content);
      const bytes = Buffer.from(file.ciphertext, "base64");
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      file.ciphertext = bytes.toString("base64");
      return JSON.stringify(file);
    });

    const report = await b.sync();
    expect(report.rejected).toEqual([{ record_id: id, reason: "auth" }]);
    expect((await b.vault.get(id)).password).toBe("v1"); // untouched
  });

  it("rejects a tampered file on a fresh device instead of importing it", async () => {
    await a.vault.add({ url: "https://a.example", username: "u", password: "p" });
    await a.sync();
    const name = cloud.names().find((n) => n !== "header.json")!;
    cloud.tamper(name, (c) => c.replace(/"nonce":"./, '"nonce":"A'));
    const b = await new Device(cloud).join();
    const report = await b.sync();
    expect(report.rejected).toHaveLength(1);
    expect(await b.entries()).toEqual([]);
  });

  it("rejects malformed cloud files", async () => {
    const { b, id } = await twoDevices();
    cloud.tamper(`${id}.json`, () => "this is not json");
    expect((await b.sync()).rejected).toEqual([{ record_id: id, reason: "format" }]);
    cloud.tamper(`${id}.json`, () => JSON.stringify({ record_id: id }));
    expect((await b.sync()).rejected).toEqual([{ record_id: id, reason: "format" }]);
  });

  it("rejects swapped files (content of one record under another name)", async () => {
    const one = await a.vault.add({ url: "https://one.example", username: "u", password: "p1" });
    const two = await a.vault.add({ url: "https://two.example", username: "u", password: "p2" });
    await a.sync();
    const b = await new Device(cloud).join();
    await b.sync();

    const oneContent = cloud.snapshot(`${one.id}.json`);
    const twoContent = cloud.snapshot(`${two.id}.json`);

    // 1. The provider swaps whole files.
    cloud.restore(`${one.id}.json`, twoContent);
    cloud.restore(`${two.id}.json`, oneContent);
    const swapped = await b.sync();
    expect(swapped.rejected.map((r) => r.reason).sort()).toEqual([
      "name-mismatch",
      "name-mismatch",
    ]);

    // 2. The provider moves a ciphertext into another file and rewrites the ID to match.
    const forged = JSON.parse(twoContent);
    forged.record_id = one.id;
    cloud.restore(`${one.id}.json`, JSON.stringify(forged));
    const forgedReport = await b.sync();
    expect(forgedReport.rejected).toContainEqual({ record_id: one.id, reason: "auth" });

    expect((await b.vault.get(one.id)).password).toBe("p1");
    expect((await b.vault.get(two.id)).password).toBe("p2");
  });

  it("restores a record the provider deleted", async () => {
    const { a, id } = await twoDevices();
    cloud.remove(`${id}.json`);
    const report = await a.sync();
    expect(report.uploaded).toBe(1);
    expect(cloud.names()).toContain(`${id}.json`);
  });

  it("merges duplicate cloud files, keeping a distinct version as a conflict copy", async () => {
    const { a, b, id } = await twoDevices();
    const first = cloud.snapshot(`${id}.json`);
    tick();
    await a.vault.update(id, { url: "https://site.example", username: "u", password: "v2" });
    await a.sync();
    cloud.addDuplicate(`${id}.json`, first); // a racing client created the same name

    const report = await b.sync();
    expect(report.duplicatesRemoved).toBe(1);
    expect(cloud.find(`${id}.json`)).toHaveLength(1);
    expect((await b.vault.get(id)).password).toBe("v2");
    expect((await b.entries()).some((e) => e.conflict_of === id && e.password === "v1")).toBe(true);
  });
});

describe("header handling", () => {
  it("a master password change uploads a newer header, and other devices ask for the new password", async () => {
    const { a, b, id } = await twoDevices();
    tick();
    await b.vault.changeMasterPassword(PASSWORD, "new-master-password");
    expect((await b.sync()).headerStatus).toBe("uploaded");
    const cloudHeader = cloud.snapshot("header.json");

    const report = await a.sync();
    expect(report.headerStatus).toBe("remote-newer");
    expect((await a.store.getHeader())?.header_version).toBe(1); // not overwritten
    expect(cloud.snapshot("header.json")).toBe(cloudHeader); // nothing older uploaded

    // Records keep syncing under the unchanged vault key.
    tick();
    await a.vault.update(id, {
      url: "https://site.example",
      username: "u",
      password: "still-works",
    });
    expect((await a.sync()).headerStatus).toBe("remote-newer");
    await b.sync();
    expect((await b.vault.get(id)).password).toBe("still-works");
    expect(cloud.snapshot("header.json")).toBe(cloudHeader);

    // Adopting needs the new password. A wrong one changes nothing.
    await expect(
      adoptPendingHeader("wrong-password-here", { store: a.store, state: a.state })
    ).rejects.toMatchObject({ code: "BAD_PASSWORD" });
    expect((await a.store.getHeader())?.header_version).toBe(1);

    const vek = await adoptPendingHeader("new-master-password", { store: a.store, state: a.state });
    expect(toBase64(vek)).toBe(toBase64(a.vek));
    expect((await a.store.getHeader())?.header_version).toBe(2);
    expect((await a.sync()).headerStatus).toBe("unchanged");
    await expect(unlock(PASSWORD, a.store, { kdf: KDF })).rejects.toMatchObject({
      code: "BAD_PASSWORD",
    });
    await expect(unlock("new-master-password", a.store, { kdf: KDF })).resolves.toBeDefined();
  });

  it("adopting with nothing pending is an error", async () => {
    await a.sync();
    await expect(
      adoptPendingHeader(PASSWORD, { store: a.store, state: a.state })
    ).rejects.toMatchObject({ code: "NO_PENDING_HEADER" });
  });

  it("uploads a locally changed header when the cloud one is older", async () => {
    await a.sync();
    tick();
    await a.vault.changeMasterPassword(PASSWORD, "changed-master-password");
    expect(await a.pending()).toBe(1);
    expect((await a.sync()).headerStatus).toBe("uploaded");
    expect((await findRemoteHeader(cloud))?.header.header_version).toBe(2);
  });

  it("never overwrites a newer cloud header when both devices changed the password", async () => {
    const { a, b } = await twoDevices();
    cloud.offline = true;
    await a.vault.changeMasterPassword(PASSWORD, "password-chosen-on-a");
    await b.vault.changeMasterPassword(PASSWORD, "password-chosen-on-b");
    cloud.offline = false;

    await b.sync();
    const bHeader = cloud.snapshot("header.json");
    const report = await a.sync();
    expect(report.headerStatus).toBe("remote-newer");
    expect(cloud.snapshot("header.json")).toBe(bHeader);

    await adoptPendingHeader("password-chosen-on-b", { store: a.store, state: a.state });
    expect((await a.sync()).headerStatus).toBe("unchanged");
  });

  it("does not adopt an older cloud header served by the provider", async () => {
    const { a, b } = await twoDevices();
    const oldHeader = cloud.snapshot("header.json");
    tick();
    await a.vault.changeMasterPassword(PASSWORD, "newer-master-password");
    await a.sync();
    await b.sync();

    cloud.restore("header.json", oldHeader);
    const report = await a.sync();
    expect(report.headerStatus).toBe("uploaded");
    expect((await findRemoteHeader(cloud))?.header.header_version).toBe(2);
    expect((await a.store.getHeader())?.header_version).toBe(2);
  });

  it("leaves a garbage cloud header alone", async () => {
    await a.sync();
    cloud.tamper("header.json", () => "garbage");
    expect((await a.sync()).headerStatus).toBe("remote-invalid");
    expect(cloud.snapshot("header.json")).toBe("garbage");
  });

  it("refuses to merge into a different vault", async () => {
    await a.vault.add({ url: "https://a.example", username: "u", password: "p" });
    await a.sync();
    const uploadsBefore = cloud.uploads.length;

    const stranger = await new Device(cloud).create("some-other-master-password");
    await stranger.vault.add({ url: "https://x.example", username: "u", password: "other" });
    const report = await stranger.sync();
    expect(report.headerStatus).toBe("vault-mismatch");
    expect(report).toMatchObject({ uploaded: 0, downloaded: 0 });
    expect(cloud.uploads.length).toBe(uploadsBefore);
    expect(await stranger.entries()).toHaveLength(1);
  });
});
