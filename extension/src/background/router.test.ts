import { describe, it, expect, beforeEach } from "vitest";
import {
  InMemoryLocalStore,
  type LoginDetail,
  type VaultListResponseData,
} from "@password-manager/shared";
import { handleExtensionMessage, type SenderInfo } from "./router.js";
import { VaultService } from "./vault-service.js";
import { PendingCaptures } from "./capture-flow.js";
import { MemoryKeyValueStore } from "../storage/key-value.js";

const popup: SenderInfo = {
  url: "chrome-extension://abc/popup.html",
  isExtensionPage: true,
  isContentScript: false,
  isSuggestionFrame: false,
};
const tab: SenderInfo = {
  url: "https://example.com/login",
  isExtensionPage: false,
  isContentScript: true,
  isSuggestionFrame: false,
  tabId: 1,
};

let service: VaultService;
let frameNonces: Map<number, string>;

function send(message: unknown, sender: SenderInfo = popup) {
  return handleExtensionMessage(message, sender, {
    service,
    allowLocalhost: false,
    frameNonces,
    captures: new PendingCaptures(),
  });
}

beforeEach(() => {
  frameNonces = new Map();
  service = new VaultService({
    store: new InMemoryLocalStore(),
    session: new MemoryKeyValueStore(),
    settings: new MemoryKeyValueStore(),
    kdf: { memory_kib: 64, iterations: 1, parallelism: 1 },
  });
});

describe("boundary validation and sender checks", () => {
  it("rejects invalid messages", async () => {
    expect((await send(null)).ok).toBe(false);
    expect((await send({ type: "NON_EXISTENT_TYPE" })).ok).toBe(false);
    expect((await send({ type: "CONTENT_SCRIPT_PING", payload: { wrongField: 1 } }, tab)).ok).toBe(
      false
    );
    expect(
      (await send({ type: "VAULT_ADD", payload: { url: "", username: "u", password: "p" } })).ok
    ).toBe(false);
    expect((await send({ type: "VAULT_SET_AUTOLOCK", payload: { minutes: 0 } })).ok).toBe(false);
  });

  it("answers CONTENT_SCRIPT_PING with the sender url, not the page-supplied one", async () => {
    const res = await send(
      { type: "CONTENT_SCRIPT_PING", payload: { url: "https://evil.example/spoofed" } },
      tab
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.data as { receivedFromUrl: string }).receivedFromUrl).toBe(
        "https://example.com/login"
      );
    }
  });

  it("refuses every vault message from a content script", async () => {
    await send({ type: "VAULT_CREATE", payload: { password: "a-long-master-password" } });
    const messages = [
      { type: "POPUP_GET_STATUS" },
      { type: "VAULT_LIST", payload: { query: "" } },
      { type: "VAULT_GET", payload: { id: "x" } },
      { type: "VAULT_UNLOCK", payload: { password: "a-long-master-password" } },
      { type: "VAULT_LOCK" },
    ];
    for (const message of messages) {
      const res = await send(message, tab);
      expect(res.ok).toBe(false);
    }
  });

  it("refuses a ping from an extension page", async () => {
    const res = await send(
      { type: "CONTENT_SCRIPT_PING", payload: { url: "https://x.example" } },
      popup
    );
    expect(res.ok).toBe(false);
  });
});

describe("vault flow through the router", () => {
  const MASTER = "a-long-master-password";

  it("starts uninitialized, then unlocked after create, locked after lock", async () => {
    const status = async () =>
      ((await send({ type: "POPUP_GET_STATUS" })) as { data: { status: string } }).data.status;
    expect(await status()).toBe("uninitialized");
    expect((await send({ type: "VAULT_CREATE", payload: { password: MASTER } })).ok).toBe(true);
    expect(await status()).toBe("unlocked");
    await send({ type: "VAULT_LOCK" });
    expect(await status()).toBe("locked");
    expect((await send({ type: "VAULT_LIST", payload: { query: "" } })).ok).toBe(false);
    expect(
      (await send({ type: "VAULT_UNLOCK", payload: { password: "wrong-password-here" } })).ok
    ).toBe(false);
    expect((await send({ type: "VAULT_UNLOCK", payload: { password: MASTER } })).ok).toBe(true);
  });

  it("rejects a short master password", async () => {
    const res = await send({ type: "VAULT_CREATE", payload: { password: "short" } });
    expect(res.ok).toBe(false);
  });

  it("adds, lists (without passwords), gets, updates and deletes", async () => {
    await send({ type: "VAULT_CREATE", payload: { password: MASTER } });
    const added = await send({
      type: "VAULT_ADD",
      payload: { url: "https://example.com", username: "alice", password: "pw-one" },
    });
    expect(added.ok).toBe(true);
    const id = (added as { data: { entry: LoginDetail } }).data.entry.id;

    const list = await send({ type: "VAULT_LIST", payload: { query: "exam" } });
    expect(list.ok).toBe(true);
    const listData = (list as { data: VaultListResponseData }).data;
    expect(listData.entries).toHaveLength(1);
    expect(JSON.stringify(listData)).not.toContain("pw-one");

    const got = await send({ type: "VAULT_GET", payload: { id } });
    expect((got as { data: { entry: LoginDetail } }).data.entry.password).toBe("pw-one");

    await send({
      type: "VAULT_UPDATE",
      payload: { id, url: "https://example.com", username: "alice", password: "pw-two" },
    });
    const again = await send({ type: "VAULT_GET", payload: { id } });
    expect((again as { data: { entry: LoginDetail } }).data.entry.password).toBe("pw-two");

    expect((await send({ type: "VAULT_DELETE", payload: { id } })).ok).toBe(true);
    expect((await send({ type: "VAULT_GET", payload: { id } })).ok).toBe(false);
  });

  it("changes the master password", async () => {
    await send({ type: "VAULT_CREATE", payload: { password: MASTER } });
    const bad = await send({
      type: "VAULT_CHANGE_PASSWORD",
      payload: { currentPassword: "not-the-password", newPassword: "another-long-password" },
    });
    expect(bad.ok).toBe(false);
    const good = await send({
      type: "VAULT_CHANGE_PASSWORD",
      payload: { currentPassword: MASTER, newPassword: "another-long-password" },
    });
    expect(good.ok).toBe(true);
    await send({ type: "VAULT_LOCK" });
    expect((await send({ type: "VAULT_UNLOCK", payload: { password: MASTER } })).ok).toBe(false);
    expect(
      (await send({ type: "VAULT_UNLOCK", payload: { password: "another-long-password" } })).ok
    ).toBe(true);
  });

  it("never echoes the master password or internals in error text", async () => {
    await send({ type: "VAULT_CREATE", payload: { password: MASTER } });
    await send({ type: "VAULT_LOCK" });
    const secret = "hunter2-wrong-password";
    const res = await send({ type: "VAULT_UNLOCK", payload: { password: secret } });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain(secret);
  });
});
