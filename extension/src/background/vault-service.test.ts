import { describe, it, expect } from "vitest";
import { InMemoryLocalStore } from "@password-manager/shared";
import { VaultService } from "./vault-service.js";
import { MemoryKeyValueStore } from "../storage/key-value.js";

const KDF = { memory_kib: 64, iterations: 1, parallelism: 1 };
const MASTER = "a-long-master-password";

function setup() {
  const store = new InMemoryLocalStore();
  const session = new MemoryKeyValueStore();
  const settings = new MemoryKeyValueStore();
  let clock = 1_000_000;
  const make = () => new VaultService({ store, session, settings, kdf: KDF, now: () => clock });
  return {
    store,
    session,
    settings,
    make,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("session handling", () => {
  it("auto-locks after the configured inactivity and clears the key", async () => {
    const { make, advance, session } = setup();
    const service = make();
    await service.create(MASTER);
    expect(await service.getStatus()).toBe("unlocked");

    advance(9 * 60_000);
    await service.requireVault(); // activity resets the timer
    advance(9 * 60_000);
    expect(await service.getStatus()).toBe("unlocked");

    advance(2 * 60_000);
    expect(await service.getStatus()).toBe("locked");
    await expect(service.requireVault()).rejects.toMatchObject({ code: "LOCKED" });
    expect(await session.get("vek")).toBeUndefined();
  });

  it("the alarm check locks an idle vault", async () => {
    const { make, advance, session } = setup();
    const service = make();
    await service.create(MASTER);
    advance(11 * 60_000);
    await service.checkAutoLock();
    expect(await session.get("vek")).toBeUndefined();
  });

  it("honours a configured timeout and validates it", async () => {
    const { make, advance } = setup();
    const service = make();
    await service.create(MASTER);
    await service.setAutoLockMinutes(2);
    advance(3 * 60_000);
    expect(await service.getStatus()).toBe("locked");
    await expect(service.setAutoLockMinutes(0)).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await expect(service.setAutoLockMinutes(1000)).rejects.toMatchObject({
      code: "INVALID_SETTING",
    });
  });

  it("survives a worker restart while the session lasts (vault stays unlocked)", async () => {
    const { make } = setup();
    const first = make();
    await first.create(MASTER);
    const restarted = make(); // new worker instance, same session storage
    expect(await restarted.getStatus()).toBe("unlocked");
    expect(await (await restarted.requireVault()).list()).toEqual([]);
  });

  it("a browser restart (session storage cleared) leaves the vault present but locked", async () => {
    const { make, session } = setup();
    const service = make();
    await service.create(MASTER);
    await (
      await service.requireVault()
    ).add({ url: "https://a.example", username: "u", password: "p" });

    await session.remove("vek", "lastActivity"); // what the browser does on restart
    const afterRestart = make();
    expect(await afterRestart.getStatus()).toBe("locked");
    await afterRestart.unlock(MASTER);
    expect(await (await afterRestart.requireVault()).list()).toHaveLength(1);
  });

  it("never writes the key to the settings store", async () => {
    const { make, settings } = setup();
    const service = make();
    await service.create(MASTER);
    await service.setAutoLockMinutes(5);
    expect(await settings.get("vek")).toBeUndefined();
    expect(await settings.get("autoLockMinutes")).toBe(5);
  });
});
