import { type Bytes } from "../crypto/index.js";
import { type RemoteFile, type StorageAdapter } from "../storage-adapter/index.js";
import { type VaultHeader, isValidVaultHeader } from "../types/vault.js";
import { type LocalStore, unlockVek } from "../vault/vault.js";
import { HEADER_NAME } from "./engine.js";
import { SyncError } from "./errors.js";
import { type SyncStateStore } from "./types.js";

/** The newest valid header in the cloud folder, or null if there is none. */
export async function findRemoteHeader(
  adapter: StorageAdapter
): Promise<{ file: RemoteFile; header: VaultHeader } | null> {
  let best: { file: RemoteFile; header: VaultHeader } | null = null;
  for (const file of await adapter.list()) {
    if (file.name !== HEADER_NAME) continue;
    let header: unknown;
    try {
      header = JSON.parse(await adapter.download(file.id));
    } catch (err) {
      if (err instanceof SyntaxError) continue;
      throw err;
    }
    if (!isValidVaultHeader(header)) continue;
    if (!best || header.header_version > best.header.header_version) best = { file, header };
  }
  return best;
}

/**
 * New-device flow: download the header, check the master password by unwrapping the VEK,
 * and only then store the header locally. A wrong password stores nothing. The next sync
 * downloads and verifies every record.
 */
export async function setupFromRemote(
  password: string,
  deps: { adapter: StorageAdapter; store: LocalStore; state: SyncStateStore }
): Promise<Bytes> {
  if ((await deps.store.getHeader()) !== null) throw new SyncError("ALREADY_EXISTS");
  const remote = await findRemoteHeader(deps.adapter);
  if (!remote) throw new SyncError("NO_REMOTE_VAULT");

  const vek = await unlockVek(password, remote.header); // Throws BAD_PASSWORD when wrong.
  await deps.store.putHeader(remote.header);
  const state = await deps.state.load();
  state.header = {
    file_id: remote.file.id,
    revision: remote.file.revision,
    last_synced_header_version: remote.header.header_version,
    remote_header_version: remote.header.header_version,
  };
  state.pending_remote_header = null;
  await deps.state.save(state);
  return vek;
}

/**
 * Applies a newer cloud header after the user typed the new master password. Returns the
 * VEK it unwraps. A wrong password changes nothing.
 */
export async function adoptPendingHeader(
  password: string,
  deps: { store: LocalStore; state: SyncStateStore }
): Promise<Bytes> {
  const state = await deps.state.load();
  const pending = state.pending_remote_header;
  if (!pending) throw new SyncError("NO_PENDING_HEADER");

  const vek = await unlockVek(password, pending);
  await deps.store.putHeader(pending);
  if (state.header) {
    state.header.last_synced_header_version = pending.header_version;
    state.header.remote_header_version = Math.max(
      state.header.remote_header_version,
      pending.header_version
    );
  }
  state.pending_remote_header = null;
  await deps.state.save(state);
  return vek;
}
