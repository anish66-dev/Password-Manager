import { VaultCryptoError, decryptRecord, encryptRecord, utf8Encode } from "../crypto/index.js";
import { type RemoteFile } from "../storage-adapter/index.js";
import {
  SCHEMA_VERSION,
  type RecordFile,
  type RecordPayload,
  type VaultHeader,
  isValidRecordFile,
  isValidVaultHeader,
} from "../types/vault.js";
import { SyncError } from "./errors.js";
import {
  type RejectReason,
  type SyncDeps,
  type SyncReport,
  type SyncState,
  type SyncStateStore,
} from "./types.js";
import { type LocalStore } from "../vault/vault.js";

export const HEADER_NAME = "header.json";
const RECORD_NAME_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;

class Reject extends Error {
  constructor(readonly reason: RejectReason) {
    super("Rejected cloud file.");
  }
}

interface Context {
  deps: SyncDeps;
  state: SyncState;
  report: SyncReport;
  byName: Map<string, RemoteFile[]>;
  /** Conflict copies created during this run. They are uploaded at the end of it. */
  created: string[];
  now: () => Date;
}

interface VerifiedRemote {
  file: RemoteFile;
  record: RecordFile;
  payload: RecordPayload;
}

// ---------------------------------------------------------------- helpers

function headersEqual(a: VaultHeader, b: VaultHeader): boolean {
  return JSON.stringify(normalizeHeader(a)) === JSON.stringify(normalizeHeader(b));
}

function normalizeHeader(h: VaultHeader): unknown[] {
  return [
    h.format_version,
    h.header_version,
    h.kdf,
    h.salt,
    h.memory_kib,
    h.iterations,
    h.parallelism,
    h.wrapped_vek.nonce,
    h.wrapped_vek.ciphertext,
  ];
}

function payloadsEqual(a: RecordPayload, b: RecordPayload): boolean {
  if (a.kind === "login" && b.kind === "login") {
    return (
      a.url === b.url &&
      a.username === b.username &&
      a.password === b.password &&
      a.created_at === b.created_at &&
      a.modified_at === b.modified_at &&
      a.deleted === b.deleted &&
      (a.conflict_of ?? null) === (b.conflict_of ?? null)
    );
  }
  if (a.kind === "never_save" && b.kind === "never_save") {
    return JSON.stringify([...a.domains].sort()) === JSON.stringify([...b.domains].sort());
  }
  return false;
}

/** The authenticated modification time used to order conflicting versions. */
function modifiedAt(payload: RecordPayload, file: RecordFile): number {
  const raw = payload.kind === "login" ? payload.modified_at : file.updated_at;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Deterministic ID for a conflict copy, so two devices that resolve the same conflict end up
 * with the same copy instead of two.
 */
async function conflictRecordId(
  originalId: string,
  modified: string,
  version: number
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    utf8Encode(`conflict|${originalId}|${modified}|${version}`)
  );
  const bytes = new Uint8Array(digest);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function save(ctx: Context): Promise<void> {
  await ctx.deps.state.save(ctx.state);
}

// ---------------------------------------------------------------- pending count

/** Local changes not yet uploaded: records ahead of their last synced version, plus the header. */
export async function countPending(store: LocalStore, stateStore: SyncStateStore): Promise<number> {
  const state = await stateStore.load();
  let count = 0;
  for (const record of await store.listRecords()) {
    const synced = state.records[record.record_id]?.last_synced_version ?? 0;
    if (record.record_version > synced) count++;
  }
  const header = await store.getHeader();
  if (
    header &&
    (!state.header || header.header_version > state.header.last_synced_header_version)
  ) {
    count++;
  }
  return count;
}

// ---------------------------------------------------------------- main entry point

/**
 * One client-side sync run:
 *  1. list the cloud folder; download only files whose revision changed
 *  2. verify and decrypt every downloaded record; failures are rejected and never merged
 *  3. per record: remote newer and local unchanged -> take remote; local newer and remote
 *     unchanged -> upload; both changed -> keep the later modification as current and store
 *     the other as a conflict copy
 *  4. a cloud copy older than what was already synced is ignored as stale
 *  5. update the sync index
 * Storage errors (offline, signed out, rate limits) abort the run; progress made so far is
 * already saved, and local changes stay pending for the next run.
 */
export async function syncOnce(deps: SyncDeps): Promise<SyncReport> {
  const state = await deps.state.load();
  const report: SyncReport = {
    uploaded: 0,
    downloaded: 0,
    conflicts: 0,
    rejected: [],
    stale: [],
    duplicatesRemoved: 0,
    headerStatus: "unchanged",
    pending: 0,
  };
  const ctx: Context = {
    deps,
    state,
    report,
    byName: new Map(),
    created: [],
    now: deps.now ?? (() => new Date()),
  };

  for (const file of await deps.adapter.list()) {
    const list = ctx.byName.get(file.name) ?? [];
    list.push(file);
    ctx.byName.set(file.name, list);
  }

  if ((await syncHeader(ctx)) === "stop") {
    report.pending = await countPending(deps.store, deps.state);
    return report;
  }

  const ids = new Set<string>();
  for (const record of await deps.store.listRecords()) ids.add(record.record_id);
  for (const name of ctx.byName.keys()) {
    const match = RECORD_NAME_RE.exec(name);
    if (match?.[1]) ids.add(match[1]);
  }

  for (const id of ids) {
    await syncRecord(ctx, id);
  }
  // Conflict copies made above have no cloud file yet.
  for (let i = 0; i < ctx.created.length; i++) {
    const id = ctx.created[i];
    if (id) await syncRecord(ctx, id);
  }

  ctx.state.last_sync_at = ctx.now().toISOString();
  await save(ctx);
  report.pending = await countPending(deps.store, deps.state);
  return report;
}

// ---------------------------------------------------------------- header

async function syncHeader(ctx: Context): Promise<"continue" | "stop"> {
  const { deps, state, report } = ctx;
  const local = await deps.store.getHeader();
  if (!local) throw new SyncError("NO_VAULT");

  const files = ctx.byName.get(HEADER_NAME) ?? [];
  const entry = state.header;

  if (files.length === 0) {
    const uploaded = await deps.adapter.upload(HEADER_NAME, JSON.stringify(local));
    state.header = {
      file_id: uploaded.id,
      revision: uploaded.revision,
      last_synced_header_version: local.header_version,
      remote_header_version: local.header_version,
    };
    state.pending_remote_header = null;
    report.headerStatus = "uploaded";
    await save(ctx);
    return "continue";
  }

  // Cloud header unchanged since the last sync: no download needed.
  const only = files.length === 1 ? files[0] : undefined;
  if (only && entry && entry.revision === only.revision) {
    if (state.pending_remote_header) {
      report.headerStatus = "remote-newer";
    } else if (
      local.header_version > entry.last_synced_header_version &&
      local.header_version >= entry.remote_header_version
    ) {
      const uploaded = await deps.adapter.upload(HEADER_NAME, JSON.stringify(local), only.id);
      state.header = {
        file_id: uploaded.id,
        revision: uploaded.revision,
        last_synced_header_version: local.header_version,
        remote_header_version: local.header_version,
      };
      report.headerStatus = "uploaded";
      await save(ctx);
    }
    return "continue";
  }

  let best: { file: RemoteFile; header: VaultHeader } | null = null;
  for (const file of files) {
    let header: unknown;
    try {
      header = JSON.parse(await deps.adapter.download(file.id));
    } catch (err) {
      if (err instanceof SyntaxError) continue;
      throw err;
    }
    if (!isValidVaultHeader(header)) continue;
    if (
      !best ||
      header.header_version > best.header.header_version ||
      (header.header_version === best.header.header_version && file.revision > best.file.revision)
    ) {
      best = { file, header };
    }
  }
  if (!best) {
    report.headerStatus = "remote-invalid"; // Left alone; never overwritten or trusted.
    return "continue";
  }
  const remote = best.header;

  if (!entry) {
    // This device never synced with this cloud folder. Only the very same vault may merge.
    if (headersEqual(local, remote)) {
      state.header = {
        file_id: best.file.id,
        revision: best.file.revision,
        last_synced_header_version: local.header_version,
        remote_header_version: remote.header_version,
      };
      await save(ctx);
      return "continue";
    }
    report.headerStatus = "vault-mismatch";
    return "stop";
  }

  if (remote.header_version < local.header_version) {
    // Never let an older cloud header win: ours is newer, so it replaces the cloud copy.
    const uploaded = await deps.adapter.upload(HEADER_NAME, JSON.stringify(local), best.file.id);
    state.header = {
      file_id: uploaded.id,
      revision: uploaded.revision,
      last_synced_header_version: local.header_version,
      remote_header_version: local.header_version,
    };
    state.pending_remote_header = null;
    report.headerStatus = "uploaded";
  } else if (remote.header_version === local.header_version && headersEqual(local, remote)) {
    state.header = {
      file_id: best.file.id,
      revision: best.file.revision,
      last_synced_header_version: local.header_version,
      remote_header_version: remote.header_version,
    };
    state.pending_remote_header = null;
  } else {
    // Newer (or same version but different): never overwrite it. Ask for the new password.
    state.pending_remote_header = remote;
    state.header = {
      file_id: best.file.id,
      revision: best.file.revision,
      last_synced_header_version: entry.last_synced_header_version,
      remote_header_version: Math.max(entry.remote_header_version, remote.header_version),
    };
    report.headerStatus = "remote-newer";
  }
  await save(ctx);
  return "continue";
}

// ---------------------------------------------------------------- records

async function fetchVerified(ctx: Context, id: string, file: RemoteFile): Promise<VerifiedRemote> {
  const text = await ctx.deps.adapter.download(file.id);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Reject("format");
  }
  if (!isValidRecordFile(parsed)) throw new Reject("format");
  if (parsed.record_id !== id) throw new Reject("name-mismatch");
  try {
    return { file, record: parsed, payload: await decryptRecord(ctx.deps.vek, parsed) };
  } catch (err) {
    if (err instanceof VaultCryptoError && err.code === "AUTH_FAILED") throw new Reject("auth");
    throw new Reject("format");
  }
}

function markSynced(ctx: Context, id: string, version: number, file: RemoteFile): void {
  ctx.state.records[id] = {
    last_synced_version: version,
    file_id: file.id,
    revision: file.revision,
  };
}

async function uploadLocal(
  ctx: Context,
  id: string,
  local: RecordFile,
  existingId: string | null
): Promise<void> {
  const file = await ctx.deps.adapter.upload(
    `${id}.json`,
    JSON.stringify(local),
    existingId ?? undefined
  );
  markSynced(ctx, id, local.record_version, file);
  ctx.report.uploaded++;
  await save(ctx);
}

async function takeRemote(ctx: Context, id: string, remote: VerifiedRemote): Promise<void> {
  await ctx.deps.store.putRecord(remote.record);
  markSynced(ctx, id, remote.record.record_version, remote.file);
  ctx.report.downloaded++;
  await save(ctx);
}

/** Keeps a version that lost a conflict as a normal, syncing record with a conflict badge. */
async function createConflictCopy(
  ctx: Context,
  originalId: string,
  loser: RecordPayload,
  sourceVersion: number
): Promise<void> {
  if (loser.kind !== "login" || loser.deleted) return; // A losing tombstone holds nothing to keep.
  const id = await conflictRecordId(originalId, loser.modified_at, sourceVersion);
  if (await ctx.deps.store.getRecord(id)) return;
  const stamp = ctx.now().toISOString();
  const file = await encryptRecord(
    ctx.deps.vek,
    { record_id: id, schema_version: SCHEMA_VERSION, record_version: 1, updated_at: stamp },
    { ...loser, conflict_of: originalId }
  );
  await ctx.deps.store.putRecord(file);
  ctx.created.push(id);
  ctx.report.conflicts++;
}

async function syncRecord(ctx: Context, id: string): Promise<void> {
  const { deps, state, report } = ctx;
  const files = ctx.byName.get(`${id}.json`) ?? [];
  const local = await deps.store.getRecord(id);
  const entry = state.records[id];
  const synced = entry?.last_synced_version ?? 0;
  const localPending = local !== null && local.record_version > synced;

  // Nothing in the cloud: upload (also restores a file the provider deleted).
  if (files.length === 0) {
    if (local) await uploadLocal(ctx, id, local, null);
    return;
  }

  // Cloud file unchanged since the last sync: only a pending local change needs action.
  const only = files.length === 1 ? files[0] : undefined;
  if (only && local && entry && entry.revision === only.revision) {
    if (localPending) await uploadLocal(ctx, id, local, only.id);
    return;
  }

  const verified: VerifiedRemote[] = [];
  for (const file of files) {
    try {
      verified.push(await fetchVerified(ctx, id, file));
    } catch (err) {
      if (!(err instanceof Reject)) throw err;
      report.rejected.push({ record_id: id, reason: err.reason });
    }
  }
  if (verified.length === 0) {
    // Everything in the cloud for this ID failed verification. Never merge it. Our own copy
    // replaces it, which also repairs a tampered or swapped file.
    if (local) await uploadLocal(ctx, id, local, files[0]?.id ?? null);
    return;
  }

  verified.sort(
    (a, b) =>
      b.record.record_version - a.record.record_version ||
      (a.file.revision < b.file.revision ? 1 : a.file.revision > b.file.revision ? -1 : 0)
  );
  const best = verified[0];
  if (!best) return;
  const remoteVersion = best.record.record_version;

  if (!local) {
    await takeRemote(ctx, id, best);
  } else {
    let localPayload: RecordPayload;
    try {
      localPayload = await decryptRecord(deps.vek, local);
    } catch {
      report.rejected.push({ record_id: id, reason: "auth" }); // Our own copy is unreadable.
      return;
    }

    if (remoteVersion < synced) {
      // The cloud went backwards past what was already synced: ignore it, then restore it.
      report.stale.push(id);
      await uploadLocal(ctx, id, local, best.file.id);
    } else if (remoteVersion === synced) {
      if (localPending) {
        await uploadLocal(ctx, id, local, best.file.id);
      } else if (payloadsEqual(localPayload, best.payload)) {
        markSynced(ctx, id, remoteVersion, best.file);
        await save(ctx);
      } else {
        await resolveConflict(ctx, id, local, localPayload, best);
      }
    } else if (!localPending || payloadsEqual(localPayload, best.payload)) {
      await takeRemote(ctx, id, best);
    } else {
      await resolveConflict(ctx, id, local, localPayload, best);
    }
  }

  // Duplicate cloud files (two clients created the same name at once): keep any distinct
  // version as a conflict copy, then remove the extras.
  for (const extra of verified.slice(1)) {
    if (!payloadsEqual(extra.payload, best.payload)) {
      await createConflictCopy(ctx, id, extra.payload, extra.record.record_version);
    }
    await deps.adapter.delete(extra.file.id);
    report.duplicatesRemoved++;
  }
}

/**
 * Both sides changed. The later modification (from the authenticated payload) stays current;
 * on a tie the cloud copy wins so every device decides the same way. The other version is
 * kept as a conflict copy. Nothing is silently overwritten or discarded.
 */
async function resolveConflict(
  ctx: Context,
  id: string,
  local: RecordFile,
  localPayload: RecordPayload,
  remote: VerifiedRemote
): Promise<void> {
  const remoteWins = modifiedAt(remote.payload, remote.record) >= modifiedAt(localPayload, local);

  if (remoteWins) {
    await takeRemote(ctx, id, remote);
    await createConflictCopy(ctx, id, localPayload, local.record_version);
    return;
  }

  // Local wins: re-save it above both versions so every device sees it as the newest edit.
  const version = Math.max(local.record_version, remote.record.record_version) + 1;
  const bumped = await encryptRecord(
    ctx.deps.vek,
    {
      record_id: id,
      schema_version: local.schema_version,
      record_version: version,
      updated_at: ctx.now().toISOString(),
    },
    localPayload
  );
  await ctx.deps.store.putRecord(bumped);
  await createConflictCopy(ctx, id, remote.payload, remote.record.record_version);
  await uploadLocal(ctx, id, bumped, remote.file.id);
}
