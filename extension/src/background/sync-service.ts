import {
  type HeaderStatus,
  type LocalStore,
  type StorageAdapter,
  StorageError,
  SyncError,
  type SyncStateStore,
  type SyncStatusData,
  adoptPendingHeader,
  countPending,
  findRemoteHeader,
  setupFromRemote,
  syncOnce,
} from "@password-manager/shared";
import { type KeyValueStore } from "../storage/key-value.js";
import { type VaultService } from "./vault-service.js";

const SETTING_ENABLED = "syncEnabled";
const DEBOUNCE_MS = 3000;

/** Storage sign-in, kept apart from the vault keys. */
export interface SyncAuth {
  /** Interactive sign-in (consent). Throws StorageError("AUTH") if declined. */
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}

export interface SyncServiceDeps {
  store: LocalStore;
  state: SyncStateStore;
  adapter: StorageAdapter;
  auth: SyncAuth;
  vault: VaultService;
  settings: KeyValueStore;
  now?: () => Date;
  /** Test hooks for the debounce timer. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Runs the sync engine in the service worker: sign-in, setup from the cloud, status, and the
 * triggers (after unlock, shortly after a local change, on an alarm, and manually).
 * It needs the unlocked vault key to verify cloud records, so it never runs while locked,
 * and it never counts as user activity.
 */
export class SyncService {
  private running = false;
  private rerun = false;
  private timer: unknown = null;
  private phase: "idle" | "syncing" | "error" = "idle";
  private lastError: string | null = null;
  private lastRejected = 0;
  private lastHeaderStatus: HeaderStatus = "unchanged";

  constructor(private readonly deps: SyncServiceDeps) {}

  async isEnabled(): Promise<boolean> {
    return (await this.deps.settings.get<boolean>(SETTING_ENABLED)) === true;
  }

  async getStatus(): Promise<SyncStatusData> {
    const enabled = await this.isEnabled();
    const state = await this.deps.state.load();
    const header = await this.deps.store.getHeader();
    const pendingChanges = header ? await countPending(this.deps.store, this.deps.state) : 0;
    const needsNewPassword = state.pending_remote_header !== null;

    let error = this.lastError;
    if (this.lastHeaderStatus === "vault-mismatch") {
      error = new SyncError("VAULT_MISMATCH").message;
    }
    let phase: SyncStatusData["phase"];
    if (!enabled) phase = "off";
    else if (this.phase === "syncing") phase = "syncing";
    else if (error) phase = "error";
    else if (pendingChanges > 0) phase = "pending";
    else phase = "idle";

    return {
      enabled,
      phase,
      lastSyncAt: state.last_sync_at,
      pendingChanges,
      error: enabled ? error : null,
      needsNewPassword,
      rejected: this.lastRejected,
    };
  }

  /** Interactive Google sign-in, then a first sync if the vault is unlocked. */
  async signIn(): Promise<SyncStatusData> {
    await this.deps.auth.signIn();
    await this.deps.settings.set(SETTING_ENABLED, true);
    this.lastError = null;
    await this.syncNow();
    return this.getStatus();
  }

  async signOut(): Promise<SyncStatusData> {
    this.clearScheduled();
    await this.deps.auth.signOut();
    await this.deps.settings.set(SETTING_ENABLED, false);
    this.lastError = null;
    this.lastHeaderStatus = "unchanged";
    this.phase = "idle";
    return this.getStatus();
  }

  /** After signing in on a device without a vault: is there one in the cloud to join? */
  async remoteVaultExists(): Promise<boolean> {
    return (await findRemoteHeader(this.deps.adapter)) !== null;
  }

  /** New-device flow: check the master password against the cloud header, then pull records. */
  async setupFromCloud(password: string): Promise<void> {
    const vek = await setupFromRemote(password, {
      adapter: this.deps.adapter,
      store: this.deps.store,
      state: this.deps.state,
    });
    await this.deps.vault.adoptKey(vek);
    await this.deps.settings.set(SETTING_ENABLED, true);
    this.lastError = null;
    await this.syncNow();
  }

  async hasPendingHeader(): Promise<boolean> {
    return (await this.deps.state.load()).pending_remote_header !== null;
  }

  /** Applies a master password changed on another device. A wrong password changes nothing. */
  async applyNewPassword(password: string): Promise<void> {
    const vek = await adoptPendingHeader(password, {
      store: this.deps.store,
      state: this.deps.state,
    });
    await this.deps.vault.adoptKey(vek);
    this.lastHeaderStatus = "unchanged";
    await this.syncNow();
  }

  // ----- Triggers -----

  /** Shortly after a local change. Several quick changes become one sync. */
  scheduleSync(delayMs = DEBOUNCE_MS): void {
    this.clearScheduled();
    const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.timer = setTimer(() => {
      this.timer = null;
      void this.syncNow();
    }, delayMs);
  }

  /** After the vault is unlocked. */
  onUnlocked(): void {
    this.scheduleSync(500);
  }

  private clearScheduled(): void {
    if (this.timer === null) return;
    (this.deps.clearTimer ?? ((h) => clearTimeout(h as number)))(this.timer);
    this.timer = null;
  }

  /** Runs one sync now (also used by the alarm and the Sync now button). */
  async syncNow(): Promise<SyncStatusData> {
    if (!(await this.isEnabled())) return this.getStatus();
    if (this.running) {
      this.rerun = true; // Changes made mid-run get their own run right after.
      return this.getStatus();
    }
    const vek = await this.deps.vault.peekSessionKey();
    if (!vek) return this.getStatus(); // Locked or no vault: changes stay queued.

    this.running = true;
    this.phase = "syncing";
    try {
      do {
        this.rerun = false;
        const report = await syncOnce({
          store: this.deps.store,
          state: this.deps.state,
          adapter: this.deps.adapter,
          vek,
          ...(this.deps.now ? { now: this.deps.now } : {}),
        });
        this.lastRejected = report.rejected.length;
        this.lastHeaderStatus = report.headerStatus;
      } while (this.rerun);
      this.lastError = null;
      this.phase = "idle";
    } catch (err) {
      this.phase = "error";
      this.lastError =
        err instanceof StorageError || err instanceof SyncError
          ? err.message
          : "Sync failed. Your changes are kept and will retry.";
    } finally {
      this.running = false;
    }
    return this.getStatus();
  }
}
