import {
  DEFAULT_AUTOLOCK_MINUTES,
  type KdfParams,
  type LocalStore,
  MIN_MASTER_PASSWORD_LENGTH,
  Vault,
  type VaultStatus,
  createVault,
  fromBase64,
  isValidAutoLockMinutes,
  toBase64,
  unlock,
} from "@password-manager/shared";
import { type KeyValueStore } from "../storage/key-value.js";

const SESSION_VEK = "vek";
const SESSION_ACTIVITY = "lastActivity";
const SETTING_AUTOLOCK = "autoLockMinutes";

export type ServiceErrorCode = "LOCKED" | "WEAK_PASSWORD" | "INVALID_SETTING";

const SERVICE_ERROR_MESSAGES: Record<ServiceErrorCode, string> = {
  LOCKED: "The vault is locked.",
  WEAK_PASSWORD: `The master password must be at least ${MIN_MASTER_PASSWORD_LENGTH} characters.`,
  INVALID_SETTING: "Invalid setting.",
};

/** Errors whose fixed message is safe to show to the user. */
export class ServiceError extends Error {
  readonly code: ServiceErrorCode;

  constructor(code: ServiceErrorCode) {
    super(SERVICE_ERROR_MESSAGES[code]);
    this.name = "ServiceError";
    this.code = code;
  }
}

export interface VaultServiceDeps {
  store: LocalStore;
  /** RAM-only store (chrome.storage.session). Holds the unlocked key and activity time. */
  session: KeyValueStore;
  /** Non-secret settings. */
  settings: KeyValueStore;
  now?: () => number;
  /** Test hook to make Argon2id cheap. Production uses the defaults. */
  kdf?: KdfParams;
}

/**
 * Owns the vault session. The unlocked VEK lives only in worker memory and in
 * chrome.storage.session (RAM, cleared on browser restart or extension reload), never
 * in IndexedDB, chrome.storage.local or any synced storage.
 */
export class VaultService {
  private readonly store: LocalStore;
  private readonly session: KeyValueStore;
  private readonly settings: KeyValueStore;
  private readonly now: () => number;
  private readonly kdf: KdfParams | undefined;
  private cached: Vault | null = null;

  constructor(deps: VaultServiceDeps) {
    this.store = deps.store;
    this.session = deps.session;
    this.settings = deps.settings;
    this.now = deps.now ?? (() => Date.now());
    this.kdf = deps.kdf;
  }

  private options() {
    return this.kdf ? { kdf: this.kdf } : {};
  }

  async getAutoLockMinutes(): Promise<number> {
    const stored = await this.settings.get<number>(SETTING_AUTOLOCK);
    return isValidAutoLockMinutes(stored) ? stored : DEFAULT_AUTOLOCK_MINUTES;
  }

  async setAutoLockMinutes(minutes: number): Promise<void> {
    if (!isValidAutoLockMinutes(minutes)) throw new ServiceError("INVALID_SETTING");
    await this.settings.set(SETTING_AUTOLOCK, minutes);
  }

  async getStatus(): Promise<VaultStatus> {
    if ((await this.store.getHeader()) === null) return "uninitialized";
    return (await this.isSessionActive()) ? "unlocked" : "locked";
  }

  async create(password: string): Promise<void> {
    if (password.length < MIN_MASTER_PASSWORD_LENGTH) throw new ServiceError("WEAK_PASSWORD");
    const vault = await createVault(password, this.store, this.options());
    await this.startSession(vault);
  }

  async unlock(password: string): Promise<void> {
    const vault = await unlock(password, this.store, this.options());
    await this.startSession(vault);
  }

  async lock(): Promise<void> {
    this.cached = null;
    await this.session.remove(SESSION_VEK, SESSION_ACTIVITY);
  }

  /** Returns the unlocked vault and counts this call as user activity. */
  async requireVault(): Promise<Vault> {
    if (!(await this.isSessionActive())) {
      await this.lock();
      throw new ServiceError("LOCKED");
    }
    if (!this.cached) {
      const encoded = await this.session.get<string>(SESSION_VEK);
      if (!encoded) throw new ServiceError("LOCKED");
      this.cached = Vault.fromVek(this.store, fromBase64(encoded), this.options());
    }
    await this.session.set(SESSION_ACTIVITY, this.now());
    return this.cached;
  }

  /** Called by the periodic alarm so an idle vault locks even if no message arrives. */
  async checkAutoLock(): Promise<void> {
    if (await this.isSessionActive()) return;
    await this.lock();
  }

  private async startSession(vault: Vault): Promise<void> {
    this.cached = vault;
    await this.session.set(SESSION_VEK, toBase64(vault.exportSessionKey()));
    await this.session.set(SESSION_ACTIVITY, this.now());
  }

  private async isSessionActive(): Promise<boolean> {
    const encoded = await this.session.get<string>(SESSION_VEK);
    if (!encoded) {
      this.cached = null;
      return false;
    }
    const last = await this.session.get<number>(SESSION_ACTIVITY);
    if (typeof last !== "number") return false;
    const limitMs = (await this.getAutoLockMinutes()) * 60_000;
    return this.now() - last < limitMs;
  }
}
