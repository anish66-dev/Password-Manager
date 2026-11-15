import { describe, it, expect, beforeEach } from "vitest";
import {
  InMemoryLocalStore,
  type CapturePrompt,
  type CapturedCredentials,
  type FocusResponseData,
} from "@password-manager/shared";
import { handleExtensionMessage, type RouterDeps, type SenderInfo } from "./router.js";
import { VaultService } from "./vault-service.js";
import { CAPTURE_TTL_MS, PendingCaptures } from "./capture-flow.js";
import { MemoryKeyValueStore } from "../storage/key-value.js";

const MASTER = "a-long-master-password";
const SITE = "https://www.example.com/signup";

function page(url: string, tabId = 1): SenderInfo {
  return { url, isExtensionPage: false, isContentScript: true, isSuggestionFrame: false, tabId };
}
const popup: SenderInfo = {
  url: "chrome-extension://abc/popup.html",
  isExtensionPage: true,
  isContentScript: false,
  isSuggestionFrame: false,
};
const frame: SenderInfo = {
  url: "chrome-extension://abc/suggestions.html",
  isExtensionPage: false,
  isContentScript: false,
  isSuggestionFrame: true,
  tabId: 1,
};

let store: InMemoryLocalStore;
let service: VaultService;
let deps: RouterDeps;
let clock: number;
let unlockNotifications: number;
/** Every response body the page-facing side ever saw, for secret scanning. */
let seen: string[];

async function send(message: unknown, sender: SenderInfo) {
  const res = await handleExtensionMessage(message, sender, deps);
  if (sender.isContentScript) seen.push(JSON.stringify(res));
  return res;
}

function captured(
  username: string,
  password: string,
  kind: CapturedCredentials["kind"] = "register"
) {
  return { type: "CREDENTIAL_CAPTURED", payload: { kind, username, password } };
}

async function promptOf(
  message: unknown,
  sender: SenderInfo = page(SITE)
): Promise<CapturePrompt | null> {
  const res = await send(message, sender);
  if (!res.ok) throw new Error(res.error);
  return (res.data as { prompt: CapturePrompt | null }).prompt;
}

const decide = (decision: string, sender: SenderInfo = page(SITE)) =>
  send({ type: "CAPTURE_DECISION", payload: { decision } }, sender);

async function addLogin(url: string, username: string, password: string): Promise<string> {
  const res = await send({ type: "VAULT_ADD", payload: { url, username, password } }, popup);
  if (!res.ok) throw new Error(res.error);
  return (res.data as { entry: { id: string } }).entry.id;
}

async function suggestionsOn(url: string): Promise<FocusResponseData> {
  const res = await send({ type: "LOGIN_FIELD_FOCUSED" }, page(url));
  if (!res.ok) throw new Error(res.error);
  return res.data as FocusResponseData;
}

beforeEach(async () => {
  clock = 1_000_000;
  seen = [];
  unlockNotifications = 0;
  store = new InMemoryLocalStore();
  service = new VaultService({
    store,
    session: new MemoryKeyValueStore(),
    settings: new MemoryKeyValueStore(),
    kdf: { memory_kib: 64, iterations: 1, parallelism: 1 },
    now: () => clock,
  });
  deps = {
    service,
    allowLocalhost: false,
    frameNonces: new Map(),
    captures: new PendingCaptures(() => clock),
    onUnlocked: () => {
      unlockNotifications++;
    },
  };
  await send({ type: "VAULT_CREATE", payload: { password: MASTER } }, popup);
});

describe("save prompt", () => {
  it("offers Save for a new account without ever returning the password", async () => {
    const prompt = await promptOf(captured("alice@example.com", "Pa55-word-secret"));
    expect(prompt).toEqual({
      mode: "save",
      site: "example.com",
      username: "alice@example.com",
      passwordLength: "Pa55-word-secret".length,
    });
    expect(await promptOf({ type: "PENDING_CAPTURE_GET" })).toEqual(prompt);
    expect(seen.join(" ")).not.toContain("Pa55-word-secret");
  });

  it("stores an encrypted record on accept, and the login autofills afterwards", async () => {
    await promptOf(captured("alice@example.com", "Pa55-word-secret"));
    expect((await decide("accept")).ok).toBe(true);

    const records = await store.listRecords();
    expect(JSON.stringify(records)).not.toContain("Pa55-word-secret");
    expect(JSON.stringify(records)).not.toContain("alice@example.com");

    const suggestions = await suggestionsOn("https://example.com/login");
    expect(suggestions.suggestions.map((s) => s.username)).toEqual(["alice@example.com"]);
    // The pending capture is gone after the decision.
    expect(await promptOf({ type: "PENDING_CAPTURE_GET" })).toBeNull();
    expect((await decide("accept")).ok).toBe(false);
  });

  it("stores nothing when the prompt is dismissed", async () => {
    await promptOf(captured("alice@example.com", "Pa55-word-secret"));
    const before = (await store.listRecords()).length;
    expect((await decide("dismiss")).ok).toBe(true);
    expect((await store.listRecords()).length).toBe(before);
    expect(await promptOf({ type: "PENDING_CAPTURE_GET" })).toBeNull();
  });
});

describe("update prompt and dedupe", () => {
  it("offers Update for the same site and username, and never adds a duplicate", async () => {
    await addLogin("https://example.com", "Alice@Example.com", "old-password");

    const prompt = await promptOf(captured("alice@example.com", "new-password-1", "change"));
    expect(prompt?.mode).toBe("update");
    expect((await decide("accept")).ok).toBe(true);

    const list = await send({ type: "VAULT_LIST", payload: { query: "" } }, popup);
    expect((list as { data: { entries: unknown[] } }).data.entries).toHaveLength(1);
    const id = (list as { data: { entries: Array<{ id: string }> } }).data.entries[0]?.id;
    const got = await send({ type: "VAULT_GET", payload: { id } }, popup);
    expect(
      (got as { data: { entry: { password: string; username: string } } }).data.entry
    ).toMatchObject({
      password: "new-password-1",
      username: "Alice@Example.com",
    });
  });

  it("asks nothing when the password is unchanged", async () => {
    await addLogin("https://example.com", "alice", "same-password");
    expect(await promptOf(captured("alice", "same-password"))).toBeNull();
  });

  it("offers Save for a different username on the same site", async () => {
    await addLogin("https://example.com", "alice", "pw-for-alice");
    expect((await promptOf(captured("bob", "pw-for-bob")))?.mode).toBe("save");
    await decide("accept");
    const list = await send({ type: "VAULT_LIST", payload: { query: "" } }, popup);
    expect((list as { data: { entries: unknown[] } }).data.entries).toHaveLength(2);
  });

  it("a change-password page without a username updates the single saved login", async () => {
    await addLogin("https://example.com", "alice", "old-password");
    const prompt = await promptOf(captured("", "brand-new-password", "change"));
    expect(prompt).toMatchObject({ mode: "update", username: "alice" });
    await decide("accept");
    const got = await send({ type: "VAULT_LIST", payload: { query: "" } }, popup);
    expect((got as { data: { entries: unknown[] } }).data.entries).toHaveLength(1);
  });

  it("with no username and several saved logins, it offers Save, not a guess", async () => {
    await addLogin("https://example.com", "alice", "pw-a");
    await addLogin("https://example.com", "bob", "pw-b");
    expect((await promptOf(captured("", "something-new", "change")))?.mode).toBe("save");
  });
});

describe("never save", () => {
  it("stops further prompts on that site and is stored encrypted", async () => {
    await promptOf(captured("alice", "Pa55-word-secret"));
    expect((await decide("never")).ok).toBe(true);

    const records = JSON.stringify(await store.listRecords());
    expect(records).not.toContain("example.com");

    expect(await promptOf(captured("bob", "another-secret"))).toBeNull();
    // Other sites are unaffected.
    expect(
      await promptOf(captured("bob", "another-secret"), page("https://other.org/signup"))
    ).toMatchObject({ mode: "save", site: "other.org" });
    // Never-save records are not logins.
    const list = await send({ type: "VAULT_LIST", payload: { query: "" } }, popup);
    expect((list as { data: { entries: unknown[] } }).data.entries).toHaveLength(0);
  });
});

describe("locked vault", () => {
  it("shows Unlock to save, keeps the capture, and saves after unlocking", async () => {
    await send({ type: "VAULT_LOCK" }, popup);
    const prompt = await promptOf(captured("alice", "Pa55-word-secret"));
    expect(prompt).toMatchObject({ mode: "unlock", site: "example.com" });

    const refused = await decide("accept");
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).not.toContain("Pa55-word-secret");
    // Still pending after the refused attempt.
    expect((await promptOf({ type: "PENDING_CAPTURE_GET" }))?.mode).toBe("unlock");

    const before = unlockNotifications;
    await send({ type: "VAULT_UNLOCK", payload: { password: MASTER } }, popup);
    expect(unlockNotifications).toBe(before + 1);
    expect((await promptOf({ type: "PENDING_CAPTURE_GET" }))?.mode).toBe("save");
    expect((await decide("accept")).ok).toBe(true);
  });

  it("expires after the short timeout and cannot be decided", async () => {
    await send({ type: "VAULT_LOCK" }, popup);
    await promptOf(captured("alice", "Pa55-word-secret"));
    clock += CAPTURE_TTL_MS + 1000;
    expect(await promptOf({ type: "PENDING_CAPTURE_GET" })).toBeNull();
    await send({ type: "VAULT_UNLOCK", payload: { password: MASTER } }, popup);
    expect((await decide("accept")).ok).toBe(false);
    expect(await store.listRecords()).toEqual([]);
  });

  it("an uninitialized vault gives no prompt", async () => {
    // Uninitialized vault: nothing to save into.
    deps.service = new VaultService({
      store: new InMemoryLocalStore(),
      session: new MemoryKeyValueStore(),
      settings: new MemoryKeyValueStore(),
    });
    expect(await promptOf(captured("alice", "pw-secret-123"))).toBeNull();
  });
});

describe("keyed by tab and bound to the site", () => {
  it("another tab cannot see or decide a tab's capture", async () => {
    await promptOf(captured("alice", "Pa55-word-secret"), page(SITE, 1));
    expect(await promptOf({ type: "PENDING_CAPTURE_GET" }, page(SITE, 2))).toBeNull();
    expect((await decide("accept", page(SITE, 2))).ok).toBe(false);
    expect((await promptOf({ type: "PENDING_CAPTURE_GET" }, page(SITE, 1)))?.mode).toBe("save");
  });

  it("the prompt survives a redirect within the site but not to another site", async () => {
    await promptOf(captured("alice", "Pa55-word-secret"));
    for (const url of [
      "https://evil.com/",
      "https://example.com.evil.com/",
      "https://evil-example.com/",
    ]) {
      expect(await promptOf({ type: "PENDING_CAPTURE_GET" }, page(url)), url).toBeNull();
      expect((await decide("accept", page(url))).ok, url).toBe(false);
    }
    const next = page("https://accounts.example.com/welcome");
    expect((await promptOf({ type: "PENDING_CAPTURE_GET" }, next))?.mode).toBe("save");
    expect((await decide("accept", next)).ok).toBe(true);
  });

  it("closing a tab can drop its capture", async () => {
    await promptOf(captured("alice", "Pa55-word-secret"));
    expect(deps.captures.tabIds()).toEqual([1]);
    deps.captures.delete(1);
    expect(await promptOf({ type: "PENDING_CAPTURE_GET" })).toBeNull();
  });

  it("ignores captures from http pages and non-web pages", async () => {
    expect(
      await promptOf(captured("alice", "pw-secret-123"), page("http://example.com/"))
    ).toBeNull();
    expect(
      await promptOf(captured("alice", "pw-secret-123"), page("ftp://example.com/"))
    ).toBeNull();
    expect(deps.captures.tabIds()).toEqual([]);
  });

  it("only content scripts may send capture messages", async () => {
    for (const sender of [popup, frame]) {
      expect((await send(captured("a", "pw-secret-123"), sender)).ok).toBe(false);
      expect((await send({ type: "PENDING_CAPTURE_GET" }, sender)).ok).toBe(false);
      expect((await decide("accept", sender)).ok).toBe(false);
    }
  });

  it("rejects malformed captures and decisions at the boundary", async () => {
    expect((await send(captured("a", ""), page(SITE))).ok).toBe(false);
    expect(
      (
        await send(
          { type: "CREDENTIAL_CAPTURED", payload: { kind: "x", username: "", password: "p" } },
          page(SITE)
        )
      ).ok
    ).toBe(false);
    expect((await decide("save-everything")).ok).toBe(false);
  });
});
