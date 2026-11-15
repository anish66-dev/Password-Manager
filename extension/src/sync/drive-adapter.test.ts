import { describe, it, expect, beforeEach } from "vitest";
import {
  InMemoryLocalStore,
  InMemorySyncStateStore,
  StorageError,
  createVault,
  setupFromRemote,
  syncOnce,
} from "@password-manager/shared";
import { DriveAdapter, type TokenProvider } from "./drive-adapter.js";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

interface DriveFileRecord {
  id: string;
  name: string;
  content: string;
  version: number;
  parents: string[];
}

/** A tiny fake of the Drive v3 endpoints the adapter uses, with scripted failures. */
class FakeDrive {
  files: DriveFileRecord[] = [];
  calls: Call[] = [];
  script: Array<Response | "network"> = [];
  pageSize = 1000;
  private nextId = 1;
  private version = 1;
  validToken = "token-1";

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    this.calls.push(call);

    const scripted = this.script.shift();
    if (scripted === "network") throw new TypeError("network down");
    if (scripted) return scripted;

    if (headers["Authorization"] !== `Bearer ${this.validToken}`) {
      return new Response("", { status: 401 });
    }
    const parsed = new URL(url);
    const params = parsed.searchParams;
    const fileMatch = /\/files\/([^/]+)$/.exec(parsed.pathname);

    if (call.method === "GET" && !fileMatch) {
      if (params.get("spaces") !== "appDataFolder") return new Response("{}", { status: 400 });
      const start = Number(params.get("pageToken") ?? 0);
      const page = this.files.slice(start, start + this.pageSize);
      const next =
        start + this.pageSize < this.files.length ? String(start + this.pageSize) : undefined;
      return Response.json({ files: page.map((f) => this.meta(f)), nextPageToken: next });
    }
    if (call.method === "GET" && fileMatch) {
      const file = this.files.find((f) => f.id === fileMatch[1]);
      if (!file) return new Response("", { status: 404 });
      return new Response(file.content, { status: 200 });
    }
    if (call.method === "POST") {
      const boundary = /boundary=(.+)$/.exec(headers["Content-Type"] ?? "")?.[1] ?? "";
      const parts = (call.body ?? "")
        .split(`--${boundary}`)
        .filter((p) => p.trim() && p.trim() !== "--");
      const metadata = JSON.parse(parts[0]?.split("\r\n\r\n")[1]?.trim() ?? "{}");
      const content = (parts[1]?.split("\r\n\r\n")[1] ?? "").replace(/\r\n$/, "");
      const file: DriveFileRecord = {
        id: `drive-${this.nextId++}`,
        name: metadata.name,
        content,
        version: this.version++,
        parents: metadata.parents,
      };
      this.files.push(file);
      return Response.json(this.meta(file));
    }
    if (call.method === "PATCH" && fileMatch) {
      const file = this.files.find((f) => f.id === fileMatch[1]);
      if (!file) return new Response("", { status: 404 });
      file.content = call.body ?? "";
      file.version = this.version++;
      return Response.json(this.meta(file));
    }
    if (call.method === "DELETE" && fileMatch) {
      const before = this.files.length;
      this.files = this.files.filter((f) => f.id !== fileMatch[1]);
      return new Response(null, { status: before === this.files.length ? 404 : 204 });
    }
    return new Response("", { status: 400 });
  };

  private meta(file: DriveFileRecord) {
    return {
      id: file.id,
      name: file.name,
      md5Checksum: `md5-${file.content.length}-${file.content.slice(0, 20)}-${file.version}`,
      version: String(file.version),
      modifiedTime: "2026-01-01T00:00:00.000Z",
    };
  }
}

class FakeTokens implements TokenProvider {
  token = "token-1";
  next: string | null = null;
  invalidated: string[] = [];
  failing = false;

  async getToken(): Promise<string> {
    if (this.failing) throw new StorageError("AUTH");
    return this.token;
  }

  async invalidate(token: string): Promise<void> {
    this.invalidated.push(token);
    if (this.next) this.token = this.next;
  }
}

let drive: FakeDrive;
let tokens: FakeTokens;
let sleeps: number[];
let adapter: DriveAdapter;

beforeEach(() => {
  drive = new FakeDrive();
  tokens = new FakeTokens();
  sleeps = [];
  adapter = new DriveAdapter({
    tokens,
    fetchFn: drive.fetch as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    maxAttempts: 4,
  });
});

describe("DriveAdapter basics", () => {
  it("uploads into the app data folder, lists, downloads and updates", async () => {
    const created = await adapter.upload("header.json", '{"a":1}');
    expect(drive.files[0]?.parents).toEqual(["appDataFolder"]);
    expect(created.name).toBe("header.json");

    const listed = await adapter.list();
    expect(listed).toEqual([created]);
    expect(await adapter.download(created.id)).toBe('{"a":1}');

    const updated = await adapter.upload("header.json", '{"a":2}', created.id);
    expect(updated.id).toBe(created.id);
    expect(updated.revision).not.toBe(created.revision);
    expect(await adapter.download(created.id)).toBe('{"a":2}');
    expect(drive.files).toHaveLength(1);

    await adapter.delete(created.id);
    expect(await adapter.list()).toEqual([]);
  });

  it("only talks to the Drive API, sends the token as a bearer header, and nothing else in the URL", async () => {
    await adapter.upload("a.json", "{}");
    await adapter.list();
    for (const call of drive.calls) {
      expect(call.url.startsWith("https://www.googleapis.com/")).toBe(true);
      expect(call.headers["Authorization"]).toBe("Bearer token-1");
      expect(call.url).not.toContain("token-1");
    }
  });

  it("follows pagination and keeps duplicate names", async () => {
    drive.pageSize = 2;
    for (let i = 0; i < 5; i++) await adapter.upload(i < 2 ? "dup.json" : `f${i}.json`, `c${i}`);
    drive.calls = [];
    const listed = await adapter.list();
    expect(listed).toHaveLength(5);
    expect(listed.filter((f) => f.name === "dup.json")).toHaveLength(2);
    expect(new Set(listed.map((f) => f.id)).size).toBe(5);
    expect(drive.calls.length).toBe(3);
  });

  it("maps 404 to NOT_FOUND without retrying", async () => {
    await expect(adapter.download("missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(sleeps).toEqual([]);
    await expect(adapter.upload("x.json", "{}", "missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("DriveAdapter token refresh", () => {
  it("drops a rejected token and retries once with a fresh one", async () => {
    tokens.token = "stale-token";
    tokens.next = "token-1";
    await adapter.list();
    expect(tokens.invalidated).toEqual(["stale-token"]);
    expect(drive.calls.map((c) => c.headers["Authorization"])).toEqual([
      "Bearer stale-token",
      "Bearer token-1",
    ]);
  });

  it("gives up with AUTH when a fresh token is rejected too", async () => {
    tokens.token = "stale-token";
    tokens.next = "also-bad";
    await expect(adapter.list()).rejects.toMatchObject({ code: "AUTH" });
    expect(drive.calls).toHaveLength(2);
  });

  it("reports AUTH when no token is available", async () => {
    tokens.failing = true;
    await expect(adapter.list()).rejects.toMatchObject({ code: "AUTH" });
    expect(drive.calls).toHaveLength(0);
  });

  it("treats a 403 permission error as AUTH but a 403 rate limit as retryable", async () => {
    drive.script = [
      Response.json(
        { error: { errors: [{ reason: "insufficientPermissions" }] } },
        { status: 403 }
      ),
    ];
    await expect(adapter.list()).rejects.toMatchObject({ code: "AUTH" });

    drive.script = [
      Response.json({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }, { status: 403 }),
    ];
    await expect(adapter.list()).resolves.toEqual([]);
    expect(sleeps).toHaveLength(1);
  });
});

describe("DriveAdapter backoff", () => {
  it("honours Retry-After on 429, then succeeds", async () => {
    drive.script = [new Response("", { status: 429, headers: { "Retry-After": "2" } })];
    await expect(adapter.list()).resolves.toEqual([]);
    expect(sleeps).toEqual([2000]);
  });

  it("backs off exponentially on 5xx and gives up with SERVER", async () => {
    drive.script = [500, 502, 503, 500].map((status) => new Response("", { status }));
    await expect(adapter.list()).rejects.toMatchObject({ code: "SERVER" });
    expect(sleeps).toEqual([375, 750, 1500]); // 500 * 2^n * (0.5 + 0.5 / 2)
  });

  it("gives up with RATE_LIMITED after repeated 429", async () => {
    drive.script = Array.from({ length: 4 }, () => new Response("", { status: 429 }));
    await expect(adapter.list()).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("retries network failures and then reports NETWORK", async () => {
    drive.script = ["network", "network"];
    await expect(adapter.list()).resolves.toEqual([]);

    drive.script = ["network", "network", "network", "network"];
    await expect(adapter.list()).rejects.toMatchObject({ code: "NETWORK" });
  });

  it("errors never contain the token or file contents", async () => {
    drive.script = Array.from({ length: 4 }, () => new Response("secret-body", { status: 500 }));
    try {
      await adapter.upload("x.json", "ciphertext-content");
    } catch (err) {
      expect(String((err as Error).message)).not.toContain("token-1");
      expect(String((err as Error).message)).not.toContain("ciphertext-content");
      expect(String((err as Error).message)).not.toContain("secret-body");
      return;
    }
    throw new Error("expected failure");
  });
});

describe("DriveAdapter with the sync engine", () => {
  const KDF = { memory_kib: 64, iterations: 1, parallelism: 1 };

  it("syncs two devices through the (fake) Drive REST API and uploads only ciphertext", async () => {
    const storeA = new InMemoryLocalStore();
    const stateA = new InMemorySyncStateStore();
    const vault = await createVault("a-long-master-password", storeA, { kdf: KDF });
    const vekA = vault.exportSessionKey();
    const entry = await vault.add({
      url: "https://secret.example",
      username: "uniqueuser",
      password: "uniquepw",
    });
    await syncOnce({ store: storeA, state: stateA, adapter, vek: vekA });

    const storeB = new InMemoryLocalStore();
    const stateB = new InMemorySyncStateStore();
    const vekB = await setupFromRemote("a-long-master-password", {
      adapter,
      store: storeB,
      state: stateB,
    });
    const report = await syncOnce({ store: storeB, state: stateB, adapter, vek: vekB });
    expect(report.downloaded).toBe(1);
    expect(await storeB.getRecord(entry.id)).not.toBeNull();

    // A second sync finds nothing changed (revision markers round-trip through the adapter).
    const again = await syncOnce({ store: storeB, state: stateB, adapter, vek: vekB });
    expect(again).toMatchObject({ downloaded: 0, uploaded: 0 });

    expect(drive.files.map((f) => f.name).sort()).toEqual(
      ["header.json", `${entry.id}.json`].sort()
    );
    const everything = JSON.stringify(drive.files) + drive.calls.map((c) => c.body ?? "").join("");
    for (const secret of ["secret.example", "uniqueuser", "uniquepw", "a-long-master-password"]) {
      expect(everything).not.toContain(secret);
    }
  });
});
