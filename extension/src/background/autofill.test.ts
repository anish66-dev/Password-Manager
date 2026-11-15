import { describe, it, expect, beforeEach } from "vitest";
import {
  InMemoryLocalStore,
  type FillResponseData,
  type FocusResponseData,
} from "@password-manager/shared";
import { handleExtensionMessage, type RouterDeps, type SenderInfo } from "./router.js";
import { VaultService } from "./vault-service.js";
import { MemoryKeyValueStore } from "../storage/key-value.js";

const MASTER = "a-long-master-password";
const NONCE = "123e4567-e89b-42d3-a456-426614174000";

function page(url: string, tabId = 1): SenderInfo {
  return { url, isExtensionPage: false, isContentScript: true, isSuggestionFrame: false, tabId };
}
const popup: SenderInfo = {
  url: "chrome-extension://abc/popup.html",
  isExtensionPage: true,
  isContentScript: false,
  isSuggestionFrame: false,
};
const frame = (tabId = 1): SenderInfo => ({
  url: "chrome-extension://abc/suggestions.html",
  isExtensionPage: false,
  isContentScript: false,
  isSuggestionFrame: true,
  tabId,
});

let service: VaultService;
let deps: RouterDeps;

function send(message: unknown, sender: SenderInfo) {
  return handleExtensionMessage(message, sender, deps);
}

async function focus(url: string): Promise<FocusResponseData> {
  const res = await send({ type: "LOGIN_FIELD_FOCUSED" }, page(url));
  if (!res.ok) throw new Error(res.error);
  return res.data as FocusResponseData;
}

async function addLogin(url: string, username: string, password: string): Promise<string> {
  const res = await send({ type: "VAULT_ADD", payload: { url, username, password } }, popup);
  if (!res.ok) throw new Error(res.error);
  return (res.data as { entry: { id: string } }).entry.id;
}

beforeEach(async () => {
  service = new VaultService({
    store: new InMemoryLocalStore(),
    session: new MemoryKeyValueStore(),
    settings: new MemoryKeyValueStore(),
    kdf: { memory_kib: 64, iterations: 1, parallelism: 1 },
  });
  deps = { service, allowLocalhost: false, frameNonces: new Map() };
});

describe("suggestions on field focus", () => {
  it("reports an uninitialized vault, then a locked vault", async () => {
    expect((await focus("https://example.com/login")).state).toBe("uninitialized");
    await send({ type: "VAULT_CREATE", payload: { password: MASTER } }, popup);
    await send({ type: "VAULT_LOCK" }, popup);
    const data = await focus("https://example.com/login");
    expect(data.state).toBe("locked");
    expect(data.suggestions).toEqual([]);
  });

  it("returns only matching suggestions and never a password", async () => {
    await send({ type: "VAULT_CREATE", payload: { password: MASTER } }, popup);
    await addLogin("https://example.com", "alice", "super-secret-1");
    await addLogin("https://example.com", "bob", "super-secret-2");
    await addLogin("https://other.org", "carol", "super-secret-3");

    const data = await focus("https://accounts.example.com/signin");
    expect(data.state).toBe("ready");
    expect(data.suggestions.map((s) => s.username).sort()).toEqual(["alice", "bob"]);
    expect(data.suggestions[0]?.displayDomain).toBe("example.com");
    expect(JSON.stringify(data)).not.toContain("super-secret");
  });

  it("offers nothing on look-alike domains, http pages and non-web pages", async () => {
    await send({ type: "VAULT_CREATE", payload: { password: MASTER } }, popup);
    await addLogin("https://example.com", "alice", "pw");
    for (const url of [
      "https://example.com.evil.com/",
      "https://evil-example.com/",
      "https://xn--xample-9ua.com/",
    ]) {
      const data = await focus(url);
      expect(data.state, url).toBe("ready");
      expect(data.suggestions, url).toEqual([]);
    }
    for (const url of [
      "http://example.com/",
      "ftp://example.com/",
      "about:blank",
      "https://example.com@evil.com/",
    ]) {
      expect((await focus(url)).state, url).toBe("ineligible");
    }
    const noUrl = await send({ type: "LOGIN_FIELD_FOCUSED" }, { ...page(""), url: undefined });
    expect((noUrl as { data: FocusResponseData }).data.state).toBe("ineligible");
  });

  it("matches localhost only in the dev build", async () => {
    await send({ type: "VAULT_CREATE", payload: { password: MASTER } }, popup);
    await addLogin("http://localhost:8080", "dev", "pw");
    expect((await focus("http://localhost:8080/login")).state).toBe("ineligible");
    deps.allowLocalhost = true;
    expect((await focus("http://localhost:8080/login")).suggestions).toHaveLength(1);
  });
});

describe("fill requests", () => {
  it("returns credentials only for a matching page, rechecked against the record", async () => {
    await send({ type: "VAULT_CREATE", payload: { password: MASTER } }, popup);
    const id = await addLogin("https://example.com", "alice", "super-secret-1");

    const ok = await send(
      { type: "FILL_REQUEST", payload: { id } },
      page("https://www.example.com/")
    );
    expect(ok.ok).toBe(true);
    expect((ok as { data: FillResponseData }).data).toEqual({
      username: "alice",
      password: "super-secret-1",
    });

    for (const url of [
      "https://example.com.evil.com/",
      "https://evil.com/",
      "http://example.com/",
      "https://example.com@evil.com/",
    ]) {
      const res = await send({ type: "FILL_REQUEST", payload: { id } }, page(url));
      expect(res.ok, url).toBe(false);
      expect(JSON.stringify(res), url).not.toContain("super-secret");
    }
  });

  it("refuses when locked, for unknown ids, and from the wrong kind of sender", async () => {
    await send({ type: "VAULT_CREATE", payload: { password: MASTER } }, popup);
    const id = await addLogin("https://example.com", "alice", "super-secret-1");
    const fill = { type: "FILL_REQUEST", payload: { id } };

    expect((await send(fill, popup)).ok).toBe(false);
    expect((await send(fill, frame())).ok).toBe(false);
    expect(
      (
        await send(
          { type: "FILL_REQUEST", payload: { id: "00000000-0000-4000-8000-000000000000" } },
          page("https://example.com/")
        )
      ).ok
    ).toBe(false);

    await send({ type: "VAULT_LOCK" }, popup);
    const locked = await send(fill, page("https://example.com/"));
    expect(locked.ok).toBe(false);
    expect(JSON.stringify(locked)).not.toContain("super-secret");
  });

  it("does not let a content script or frame use vault or focus APIs it should not", async () => {
    await send({ type: "VAULT_CREATE", payload: { password: MASTER } }, popup);
    const list = { type: "VAULT_LIST", payload: { query: "" } };
    expect((await send(list, page("https://example.com/"))).ok).toBe(false);
    expect((await send(list, frame())).ok).toBe(false);
    expect((await send({ type: "LOGIN_FIELD_FOCUSED" }, popup)).ok).toBe(false);
    expect((await send({ type: "LOGIN_FIELD_FOCUSED" }, frame())).ok).toBe(false);
  });
});

describe("suggestion frame authentication", () => {
  it("accepts the nonce registered by the content script for the same tab, once", async () => {
    const register = { type: "FRAME_REGISTER", payload: { nonce: NONCE } };
    const claim = { type: "FRAME_CLAIM", payload: { nonce: NONCE } };

    expect((await send(register, page("https://example.com/", 7))).ok).toBe(true);
    expect((await send(claim, frame(8))).ok).toBe(false); // another tab
    expect(
      (
        await send(
          { type: "FRAME_CLAIM", payload: { nonce: "00000000-0000-4000-8000-00000000000a" } },
          frame(7)
        )
      ).ok
    ).toBe(false); // wrong nonce, as a page forging an init would use
    expect((await send(claim, frame(7))).ok).toBe(true);
    expect((await send(claim, frame(7))).ok).toBe(false); // single use
  });

  it("only the matching sender kinds may register or claim", async () => {
    const register = { type: "FRAME_REGISTER", payload: { nonce: NONCE } };
    const claim = { type: "FRAME_CLAIM", payload: { nonce: NONCE } };
    expect((await send(register, popup)).ok).toBe(false);
    expect((await send(register, frame())).ok).toBe(false);
    expect((await send(claim, page("https://example.com/"))).ok).toBe(false);
    expect((await send(claim, popup)).ok).toBe(false);
    expect(
      (await send({ type: "FRAME_REGISTER", payload: { nonce: "short" } }, page("https://x.com/")))
        .ok
    ).toBe(false);
  });
});
