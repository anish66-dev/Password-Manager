import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Bytes } from "../crypto/index.js";
import { InMemoryStorageAdapter, StorageError } from "../storage-adapter/index.js";
import { InMemoryLocalStore, Vault, VaultError, createVault } from "../vault/vault.js";
import { InMemorySyncStateStore, countPending, setupFromRemote, syncOnce } from "./index.js";

/**
 * Replays shared/test-vectors/sync-scenarios.json. The Android tests replay the same file
 * with the Kotlin engine, so both implementations must agree on every step.
 */
const file = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../test-vectors/sync-scenarios.json"
);

interface Step {
  op: string;
  device?: string;
  ref?: string;
  url?: string;
  username?: string;
  password?: string;
  domain?: string;
  ms?: number;
  value?: boolean;
  count?: number;
  code?: string;
  logins?: string[];
  expect?: Record<string, unknown>;
}
interface Scenario {
  name: string;
  steps: Step[];
}
interface Fixture {
  kdf: { memory_kib: number; iterations: number; parallelism: number };
  password: string;
  start_time: string;
  scenarios: Scenario[];
}

const fixture = JSON.parse(readFileSync(file, "utf8")) as Fixture;

class Device {
  readonly store = new InMemoryLocalStore();
  readonly state = new InMemorySyncStateStore();
  vault!: Vault;
  vek!: Bytes;
}

async function run(scenario: Scenario): Promise<void> {
  let t = Date.parse(fixture.start_time);
  const now = () => new Date(t);
  const cloud = new InMemoryStorageAdapter();
  const devices = new Map<string, Device>();
  const ids = new Map<string, string>();
  const snapshots = new Map<string, string>();
  const dev = (name: string | undefined): Device => {
    const found = devices.get(name ?? "");
    if (!found) throw new Error(`Unknown device ${name}`);
    return found;
  };
  const idOf = (ref: string | undefined): string => {
    const id = ids.get(ref ?? "");
    if (!id) throw new Error(`Unknown ref ${ref}`);
    return id;
  };
  const sync = (d: Device) =>
    syncOnce({ store: d.store, state: d.state, adapter: cloud, vek: d.vek, now });
  const opts = { kdf: fixture.kdf, now };

  for (const step of scenario.steps) {
    switch (step.op) {
      case "create": {
        const d = new Device();
        d.vault = await createVault(fixture.password, d.store, opts);
        d.vek = d.vault.exportSessionKey();
        devices.set(step.device ?? "", d);
        break;
      }
      case "join": {
        const d = new Device();
        d.vek = await setupFromRemote(fixture.password, {
          adapter: cloud,
          store: d.store,
          state: d.state,
        });
        d.vault = Vault.fromVek(d.store, d.vek, opts);
        devices.set(step.device ?? "", d);
        break;
      }
      case "join_fails": {
        const d = new Device();
        const err = await setupFromRemote(step.password ?? "", {
          adapter: cloud,
          store: d.store,
          state: d.state,
        }).then(
          () => null,
          (e: unknown) => e
        );
        expect(err).toBeInstanceOf(VaultError);
        expect((err as VaultError).code).toBe(step.code);
        expect(await d.store.getHeader()).toBeNull();
        break;
      }
      case "add": {
        const entry = await dev(step.device).vault.add({
          url: step.url ?? "",
          username: step.username ?? "",
          password: step.password ?? "",
        });
        ids.set(step.ref ?? "", entry.id);
        break;
      }
      case "edit": {
        const d = dev(step.device);
        const current = await d.vault.get(idOf(step.ref));
        await d.vault.update(current.id, {
          url: step.url ?? current.url,
          username: step.username ?? current.username,
          password: step.password ?? current.password,
        });
        break;
      }
      case "delete":
        await dev(step.device).vault.delete(idOf(step.ref));
        break;
      case "never_save":
        await dev(step.device).vault.addNeverSave(step.domain ?? "");
        break;
      case "tick":
        t += step.ms ?? 1000;
        break;
      case "offline":
        cloud.offline = step.value === true;
        break;
      case "sync": {
        const report = await sync(dev(step.device));
        for (const [key, want] of Object.entries(step.expect ?? {})) {
          const got = (report as unknown as Record<string, unknown>)[key];
          const value = Array.isArray(got) ? got.length : got;
          expect(value, `${scenario.name}: report.${key}`).toEqual(want);
        }
        break;
      }
      case "sync_fails": {
        const err = await sync(dev(step.device)).then(
          () => null,
          (e: unknown) => e
        );
        expect(err).toBeInstanceOf(StorageError);
        expect((err as StorageError).code).toBe(step.code);
        break;
      }
      case "tamper_record":
        cloud.tamper(`${idOf(step.ref)}.json`, (content) => {
          const parsed = JSON.parse(content) as { ciphertext: string };
          parsed.ciphertext =
            (parsed.ciphertext.startsWith("A") ? "B" : "A") + parsed.ciphertext.slice(1);
          return JSON.stringify(parsed);
        });
        break;
      case "snapshot_record":
        snapshots.set(idOf(step.ref), cloud.snapshot(`${idOf(step.ref)}.json`));
        break;
      case "restore_record":
        cloud.restore(`${idOf(step.ref)}.json`, snapshots.get(idOf(step.ref)) ?? "");
        break;
      case "expect_logins": {
        const entries = await dev(step.device).vault.list();
        const got = entries
          .map((e) => `${e.username}|${e.password}|${e.conflict_of ? "conflict" : ""}`)
          .sort();
        expect(got, `${scenario.name}: logins on ${step.device}`).toEqual(
          [...(step.logins ?? [])].sort()
        );
        break;
      }
      case "expect_pending": {
        const d = dev(step.device);
        expect(await countPending(d.store, d.state)).toBe(step.count);
        break;
      }
      case "expect_cloud_file_count":
        expect(cloud.names()).toHaveLength(step.count ?? 0);
        break;
      default:
        throw new Error(`Unknown op ${step.op}`);
    }
  }
}

describe("shared sync scenarios", () => {
  for (const scenario of fixture.scenarios) {
    it(scenario.name, async () => {
      await run(scenario);
    });
  }
});
