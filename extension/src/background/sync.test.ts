import { describe, it, expect, beforeEach } from "vitest";
import {
  InMemoryLocalStore,
  InMemoryStorageAdapter,
  InMemorySyncStateStore,
  StorageError,
  type LoginSummary,
  type SyncStatusData,
} from "@password-manager/shared";
import { handleExtensionMessage, type RouterDeps, type SenderInfo } from "./router.js";
import { VaultService } from "./vault-service.js";
import { SyncService } from "./sync-service.js";
import { PendingCaptures } from "./capture-flow.js";
import { MemoryKeyValueStore } from "../storage/key-value.js";

const MASTER = "a-long-master-password";
const KDF = { memory_kib: 64, iterations: 1, parallelism: 1 };

const popup: SenderInfo = {
  url: "chrome-extension://abc/popup.html",
  isExtensionPage: true,
  isContentScript: false,
  isSuggestionFrame: false,
};
const page: SenderInfo = {
  url: "https://example.com/",
  isExtensionPage: false,
  isContentScript: true,
  isSuggestionFrame: false,
  tabId: 1,
};

const clock = { t: 1_000_000 };

interface Timer {
  fn: () => void;
  cancelled: boolean;
}

class TestDevice {
  readonly store = new InMemoryLocalStore();
  readonly state = new InMemorySyncStateStore();
  readonly timers: Timer[] = [];
  authFails = false;
  readonly service: VaultService;
  readonly sync: SyncService;
  readonly deps: RouterDeps;

  constructor(readonly cloud: InMemoryStorageAdapter) {
    const settings = new MemoryKeyValueStore();
    this.service = new VaultService({
      store: this.store,
      session: new MemoryKeyValueStore(),
      settings,
      kdf: KDF,
      now: () => clock.t,
    });
    this.sync = new SyncService({
      store: this.store,
      state: this.state,
      adapter: cloud,
      auth: {
        signIn: async () => {
          if (this.authFails) throw new StorageError("AUTH");
        },
        signOut: async () => undefined,
      },
      vault: this.service,
      settings,
      now: () => new Date(clock.t),
      setTimer: (fn) => {
        const timer: Timer = { fn, cancelled: false };
        this.timers.push(timer);
        return timer;
      },
      clearTimer: (handle) => {
        (handle as Timer).cancelled = true;
      },
    });
    this.deps = {
      service: this.service,
      allowLocalhost: false,
      frameNonces: new Map(),
      captures: new PendingCaptures(() => clock.t),
      sync: this.sync,
    };
  }

  async send(message: unknown, sender: SenderInfo = popup) {
    return handleExtensionMessage(message, sender, this.deps);
  }

  async ok<T>(message: unknown): Promise<T> {
    const res = await this.send(message);
    if (!res.ok) throw new Error(res.error);
    return res.data as T;
  }

  /** Fires the debounce timer, as the real one would after the delay. */
  async runTimers(): Promise<void> {
    const live = this.timers.filter((t) => !t.cancelled);
    this.timers.length = 0;
    for (const timer of live) timer.fn();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  liveTimers(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }

  status(): Promise<SyncStatusData> {
    return this.ok<SyncStatusData>({ type: "SYNC_GET_STATUS" });
  }

  async create(): Promise<this> {
    await this.ok({ type: "VAULT_CREATE", payload: { password: MASTER } });
    return this;
  }

  async add(url: string, username: string, password: string): Promise<string> {
    const data = await this.ok<{ entry: { id: string } }>({
      type: "VAULT_ADD",
      payload: { url, username, password },
    });
    return data.entry.id;
  }

  async list(): Promise<LoginSummary[]> {
    return (
      await this.ok<{ entries: LoginSummary[] }>({ type: "VAULT_LIST", payload: { query: "" } })
    ).entries;
  }
}

let cloud: InMemoryStorageAdapter;
let a: TestDevice;

beforeEach(async () => {
  clock.t = 1_000_000;
  cloud = new InMemoryStorageAdapter();
  a = await new TestDevice(cloud).create();
});

describe("sync messages", () => {
  it("are only accepted from extension pages", async () => {
    for (const message of [
      { type: "SYNC_GET_STATUS" },
      { type: "SYNC_SIGN_IN" },
      { type: "SYNC_SIGN_OUT" },
      { type: "SYNC_NOW" },
      { type: "SYNC_CHECK_REMOTE" },
      { type: "SYNC_SETUP_FROM_CLOUD", payload: { password: MASTER } },
      { type: "SYNC_APPLY_NEW_PASSWORD", payload: { password: MASTER } },
    ]) {
      expect((await a.send(message, page)).ok, message.type).toBe(false);
    }
    expect(cloud.names()).toEqual([]);
  });
});

describe("status and triggers", () => {
  it("is off until the user signs in to the cloud, and shows pending changes afterwards", async () => {
    expect(await a.status()).toMatchObject({ enabled: false, phase: "off", lastSyncAt: null });
    await a.add("https://a.example", "u", "p");
    a.authFails = true;
    expect((await a.send({ type: "SYNC_SIGN_IN" })).ok).toBe(false); // declined consent
    expect((await a.status()).enabled).toBe(false);

    a.authFails = false;
    const status = await a.ok<SyncStatusData>({ type: "SYNC_SIGN_IN" });
    expect(status).toMatchObject({ enabled: true, phase: "idle", pendingChanges: 0, error: null });
    expect(status.lastSyncAt).not.toBeNull();
    expect(cloud.names()).toHaveLength(2); // header + one record
  });

  it("syncs shortly after a local change, with several changes becoming one run", async () => {
    await a.ok({ type: "SYNC_SIGN_IN" });
    await a.add("https://a.example", "u", "p1");
    await a.add("https://b.example", "u", "p2");
    expect(a.liveTimers()).toBe(1); // debounced
    expect((await a.status()).phase).toBe("pending");
    expect((await a.status()).pendingChanges).toBe(2);

    await a.runTimers();
    expect(await a.status()).toMatchObject({ phase: "idle", pendingChanges: 0 });
    expect(cloud.names()).toHaveLength(3);
  });

  it("edits, deletes, password changes and accepted save prompts all schedule a sync", async () => {
    await a.ok({ type: "SYNC_SIGN_IN" });
    const id = await a.add("https://a.example", "u", "p");
    await a.runTimers();

    await a.ok({
      type: "VAULT_UPDATE",
      payload: { id, url: "https://a.example", username: "u", password: "p2" },
    });
    expect(a.liveTimers()).toBe(1);
    await a.runTimers();
    await a.ok({ type: "VAULT_DELETE", payload: { id } });
    expect(a.liveTimers()).toBe(1);
    await a.runTimers();
    await a.ok({
      type: "VAULT_CHANGE_PASSWORD",
      payload: { currentPassword: MASTER, newPassword: "another-long-password" },
    });
    expect(a.liveTimers()).toBe(1);
    await a.runTimers();
    expect((await a.status()).pendingChanges).toBe(0);

    await a.send(
      {
        type: "CREDENTIAL_CAPTURED",
        payload: { kind: "register", username: "n", password: "pw-secret-1" },
      },
      page
    );
    await a.send({ type: "CAPTURE_DECISION", payload: { decision: "accept" } }, page);
    expect(a.liveTimers()).toBe(1);
    await a.runTimers();
    expect((await a.status()).pendingChanges).toBe(0);
  });

  it("does not sync while locked, keeps changes queued, and syncs after unlocking", async () => {
    await a.ok({ type: "SYNC_SIGN_IN" });
    await a.add("https://a.example", "u", "p");
    await a.ok({ type: "VAULT_LOCK" });
    await a.runTimers();
    expect(await a.status()).toMatchObject({ phase: "pending", pendingChanges: 1 });
    expect(cloud.names()).toHaveLength(1); // header only; the record waits

    await a.ok({ type: "VAULT_UNLOCK", payload: { password: MASTER } });
    expect(a.liveTimers()).toBe(1);
    await a.runTimers();
    expect((await a.status()).pendingChanges).toBe(0);
    expect(cloud.names()).toHaveLength(2);
  });

  it("background syncs never count as user activity, so an idle vault still auto-locks", async () => {
    await a.ok({ type: "SYNC_SIGN_IN" });
    clock.t += 9 * 60_000;
    await a.sync.syncNow();
    clock.t += 2 * 60_000;
    await a.sync.syncNow(); // vault has been idle for 11 minutes: it is locked now
    expect(await a.service.getStatus()).toBe("locked");
  });

  it("reports offline, rate-limit and sign-in failures with fixed messages and keeps changes", async () => {
    await a.ok({ type: "SYNC_SIGN_IN" });
    await a.add("https://a.example", "u", "p");

    cloud.offline = true;
    let status = await a.ok<SyncStatusData>({ type: "SYNC_NOW" });
    expect(status).toMatchObject({ phase: "error", pendingChanges: 1 });
    expect(status.error).toBe("The cloud storage could not be reached.");

    cloud.offline = false;
    cloud.failNext("AUTH");
    status = await a.ok<SyncStatusData>({ type: "SYNC_NOW" });
    expect(status.error).toBe("Cloud sign-in is required.");

    status = await a.ok<SyncStatusData>({ type: "SYNC_NOW" });
    expect(status).toMatchObject({ phase: "idle", pendingChanges: 0, error: null });
  });

  it("sign out turns sync off and keeps local data", async () => {
    await a.ok({ type: "SYNC_SIGN_IN" });
    await a.add("https://a.example", "u", "p");
    expect((await a.ok<SyncStatusData>({ type: "SYNC_SIGN_OUT" })).phase).toBe("off");
    await a.runTimers();
    expect((await a.list()).length).toBe(1);
  });
});

describe("new device", () => {
  async function secondDevice(): Promise<TestDevice> {
    await a.add("https://a.example", "alice", "pw-a");
    await a.ok({ type: "SYNC_SIGN_IN" });
    return new TestDevice(cloud);
  }

  it("joins with only the cloud sign-in and the master password", async () => {
    const b = await secondDevice();
    expect(await b.service.getStatus()).toBe("uninitialized");
    await b.ok({ type: "SYNC_SIGN_IN" });
    expect(await b.ok({ type: "SYNC_CHECK_REMOTE" })).toEqual({ exists: true });

    const wrong = await b.send({
      type: "SYNC_SETUP_FROM_CLOUD",
      payload: { password: "wrong-password-here" },
    });
    expect(wrong.ok).toBe(false);
    expect(await b.service.getStatus()).toBe("uninitialized"); // nothing was stored

    await b.ok({ type: "SYNC_SETUP_FROM_CLOUD", payload: { password: MASTER } });
    expect(await b.service.getStatus()).toBe("unlocked");
    expect((await b.list()).map((e) => e.username)).toEqual(["alice"]);
    expect(await b.status()).toMatchObject({ enabled: true, phase: "idle", pendingChanges: 0 });
  });

  it("says so when there is no vault in the cloud", async () => {
    const empty = new TestDevice(new InMemoryStorageAdapter());
    await empty.ok({ type: "SYNC_SIGN_IN" });
    expect(await empty.ok({ type: "SYNC_CHECK_REMOTE" })).toEqual({ exists: false });
    expect(
      (await empty.send({ type: "SYNC_SETUP_FROM_CLOUD", payload: { password: MASTER } })).ok
    ).toBe(false);
  });

  it("refuses to merge a different local vault into the cloud", async () => {
    await secondDevice();
    const stranger = await new TestDevice(cloud).create();
    await stranger.add("https://x.example", "other", "other-pw");
    const uploadsBefore = cloud.uploads.length;
    const status = await stranger.ok<SyncStatusData>({ type: "SYNC_SIGN_IN" });
    expect(status.phase).toBe("error");
    expect(status.error).toContain("different vault");
    expect(cloud.uploads.length).toBe(uploadsBefore);
  });
});

describe("conflicts and master password changes", () => {
  it("flags conflict copies in the list", async () => {
    const id = await a.add("https://site.example", "u", "v1");
    await a.ok({ type: "SYNC_SIGN_IN" });
    const b = new TestDevice(cloud);
    await b.ok({ type: "SYNC_SIGN_IN" });
    await b.ok({ type: "SYNC_SETUP_FROM_CLOUD", payload: { password: MASTER } });

    cloud.offline = true;
    clock.t += 1000;
    await a.ok({
      type: "VAULT_UPDATE",
      payload: { id, url: "https://site.example", username: "u", password: "from-a" },
    });
    clock.t += 1000;
    await b.ok({
      type: "VAULT_UPDATE",
      payload: { id, url: "https://site.example", username: "u", password: "from-b" },
    });
    cloud.offline = false;
    for (const device of [a, b, a, b]) await device.ok({ type: "SYNC_NOW" });

    for (const device of [a, b]) {
      const entries = await device.list();
      expect(entries).toHaveLength(2);
      expect(entries.filter((e) => e.conflict)).toHaveLength(1);
      expect(entries.filter((e) => !e.conflict)).toHaveLength(1);
    }
  });

  it("asks for the new password after a change on another device, and applies it", async () => {
    await a.ok({ type: "SYNC_SIGN_IN" });
    const b = new TestDevice(cloud);
    await b.ok({ type: "SYNC_SIGN_IN" });
    await b.ok({ type: "SYNC_SETUP_FROM_CLOUD", payload: { password: MASTER } });

    await b.ok({
      type: "VAULT_CHANGE_PASSWORD",
      payload: { currentPassword: MASTER, newPassword: "brand-new-master-password" },
    });
    await b.ok({ type: "SYNC_NOW" });

    const status = await a.ok<SyncStatusData>({ type: "SYNC_NOW" });
    expect(status.needsNewPassword).toBe(true);

    expect(
      (
        await a.send({
          type: "SYNC_APPLY_NEW_PASSWORD",
          payload: { password: "wrong-password-here" },
        })
      ).ok
    ).toBe(false);
    expect((await a.status()).needsNewPassword).toBe(true);

    await a.ok({
      type: "SYNC_APPLY_NEW_PASSWORD",
      payload: { password: "brand-new-master-password" },
    });
    expect((await a.status()).needsNewPassword).toBe(false);
    expect(await a.service.getStatus()).toBe("unlocked");
  });

  it("unlocking with the new password works directly, wrong passwords still fail", async () => {
    await a.ok({ type: "SYNC_SIGN_IN" });
    const b = new TestDevice(cloud);
    await b.ok({ type: "SYNC_SIGN_IN" });
    await b.ok({ type: "SYNC_SETUP_FROM_CLOUD", payload: { password: MASTER } });
    await b.ok({
      type: "VAULT_CHANGE_PASSWORD",
      payload: { currentPassword: MASTER, newPassword: "brand-new-master-password" },
    });
    await b.ok({ type: "SYNC_NOW" });
    await a.ok({ type: "SYNC_NOW" });
    await a.ok({ type: "VAULT_LOCK" });

    const wrong = await a.send({
      type: "VAULT_UNLOCK",
      payload: { password: "wrong-password-here" },
    });
    expect(wrong.ok).toBe(false);
    expect((wrong as { error: string }).error).toBe("Incorrect master password.");
    expect(await a.service.getStatus()).toBe("locked");

    await a.ok({ type: "VAULT_UNLOCK", payload: { password: "brand-new-master-password" } });
    expect(await a.service.getStatus()).toBe("unlocked");
    expect((await a.status()).needsNewPassword).toBe(false);
  });
});
