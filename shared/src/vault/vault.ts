import {
  type Bytes,
  DEFAULT_KDF_PARAMS,
  type KdfParams,
  SALT_BYTES,
  VaultCryptoError,
  decryptRecord,
  deriveKek,
  deriveMasterKey,
  encryptRecord,
  fromBase64,
  generateVek,
  randomBytes,
  toBase64,
  unwrapVek,
  wrapVek,
} from "../crypto/index.js";
import {
  FORMAT_VERSION,
  type LoginPayload,
  type RecordFile,
  SCHEMA_VERSION,
  type VaultHeader,
  isValidVaultHeader,
} from "../types/vault.js";

/** Storage for the header and the record files exactly as they exist in the cloud. */
export interface LocalStore {
  getHeader(): Promise<VaultHeader | null>;
  putHeader(header: VaultHeader): Promise<void>;
  getRecord(recordId: string): Promise<RecordFile | null>;
  putRecord(record: RecordFile): Promise<void>;
  listRecords(): Promise<RecordFile[]>;
}

export class InMemoryLocalStore implements LocalStore {
  private header: VaultHeader | null = null;
  private readonly records = new Map<string, RecordFile>();

  async getHeader(): Promise<VaultHeader | null> {
    return this.header ? structuredClone(this.header) : null;
  }

  async putHeader(header: VaultHeader): Promise<void> {
    this.header = structuredClone(header);
  }

  async getRecord(recordId: string): Promise<RecordFile | null> {
    const found = this.records.get(recordId);
    return found ? structuredClone(found) : null;
  }

  async putRecord(record: RecordFile): Promise<void> {
    this.records.set(record.record_id, structuredClone(record));
  }

  async listRecords(): Promise<RecordFile[]> {
    return [...this.records.values()].map((r) => structuredClone(r));
  }
}

export type VaultErrorCode = "ALREADY_EXISTS" | "NOT_FOUND" | "NO_VAULT" | "BAD_PASSWORD";

const VAULT_ERROR_MESSAGES: Record<VaultErrorCode, string> = {
  ALREADY_EXISTS: "A vault already exists.",
  NOT_FOUND: "Entry not found.",
  NO_VAULT: "No vault has been created yet.",
  BAD_PASSWORD: "Incorrect master password.",
};

/** Non-crypto vault failures. Messages are fixed and safe to show to the user. */
export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode) {
    super(VAULT_ERROR_MESSAGES[code]);
    this.name = "VaultError";
    this.code = code;
  }
}

export interface LoginInput {
  url: string;
  username: string;
  password: string;
}

export interface LoginEntry extends LoginInput {
  id: string;
  created_at: string;
  modified_at: string;
  record_version: number;
  /** Present on conflict copies created by sync. */
  conflict_of?: string;
}

export interface ReadAllResult {
  entries: LoginEntry[];
  /** Record IDs that failed authentication or were malformed. Never merged or shown. */
  rejectedIds: string[];
}

export interface VaultOptions {
  kdf?: KdfParams;
  now?: () => Date;
}

/** Derives the KEK from the password and unwraps the VEK. Wrong password fails. */
export async function unlockVek(password: string, header: VaultHeader): Promise<Bytes> {
  if (!isValidVaultHeader(header)) {
    throw new VaultCryptoError("INVALID_FORMAT");
  }
  const masterKey = await deriveMasterKey(password, fromBase64(header.salt), header);
  const kek = await deriveKek(masterKey);
  try {
    return await unwrapVek(kek, header.wrapped_vek, header.format_version);
  } catch (err) {
    if (err instanceof VaultCryptoError && err.code === "AUTH_FAILED") {
      throw new VaultError("BAD_PASSWORD");
    }
    throw err;
  }
}

async function buildHeader(
  password: string,
  vek: Bytes,
  kdf: KdfParams,
  headerVersion: number
): Promise<VaultHeader> {
  const salt = randomBytes(SALT_BYTES);
  const masterKey = await deriveMasterKey(password, salt, kdf);
  const kek = await deriveKek(masterKey);
  const wrapped = await wrapVek(kek, vek, FORMAT_VERSION);
  return {
    format_version: FORMAT_VERSION,
    header_version: headerVersion,
    kdf: "argon2id",
    salt: toBase64(salt),
    memory_kib: kdf.memory_kib,
    iterations: kdf.iterations,
    parallelism: kdf.parallelism,
    wrapped_vek: wrapped,
  };
}

/** Creates a new vault: random VEK wrapped under the password-derived KEK. */
export async function createVault(
  password: string,
  store: LocalStore,
  options: VaultOptions = {}
): Promise<Vault> {
  if ((await store.getHeader()) !== null) {
    throw new VaultError("ALREADY_EXISTS");
  }
  const vek = generateVek();
  const header = await buildHeader(password, vek, options.kdf ?? DEFAULT_KDF_PARAMS, 1);
  await store.putHeader(header);
  return new Vault(store, vek, options);
}

/** Unlocks an existing vault. Throws VaultError(BAD_PASSWORD) on a wrong password. */
export async function unlock(
  password: string,
  store: LocalStore,
  options: VaultOptions = {}
): Promise<Vault> {
  const header = await store.getHeader();
  if (!header) {
    throw new VaultError("NO_VAULT");
  }
  const vek = await unlockVek(password, header);
  return new Vault(store, vek, options);
}

function toEntry(file: RecordFile, payload: LoginPayload): LoginEntry {
  return {
    id: file.record_id,
    url: payload.url,
    username: payload.username,
    password: payload.password,
    created_at: payload.created_at,
    modified_at: payload.modified_at,
    record_version: file.record_version,
    ...(payload.conflict_of !== undefined ? { conflict_of: payload.conflict_of } : {}),
  };
}

/** An unlocked vault. Holds the VEK in memory only. */
export class Vault {
  private readonly now: () => Date;
  private readonly kdf: KdfParams | undefined;

  constructor(
    private readonly store: LocalStore,
    private readonly vek: Bytes,
    options: VaultOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.kdf = options.kdf;
  }

  /** Rebuilds an unlocked vault from a VEK kept in session memory. */
  static fromVek(store: LocalStore, vek: Bytes, options: VaultOptions = {}): Vault {
    return new Vault(store, vek, options);
  }

  /** The raw VEK, for session handling only. Never log or persist it. */
  exportSessionKey(): Bytes {
    return new Uint8Array(this.vek);
  }

  async readAll(): Promise<ReadAllResult> {
    const files = await this.store.listRecords();
    const entries: LoginEntry[] = [];
    const rejectedIds: string[] = [];
    for (const file of files) {
      try {
        const payload = await decryptRecord(this.vek, file);
        if (payload.kind === "login" && !payload.deleted) {
          entries.push(toEntry(file, payload));
        }
      } catch {
        rejectedIds.push(file.record_id);
      }
    }
    entries.sort(
      (a, b) =>
        a.url.localeCompare(b.url, undefined, { sensitivity: "base" }) ||
        a.username.localeCompare(b.username, undefined, { sensitivity: "base" })
    );
    return { entries, rejectedIds };
  }

  async list(): Promise<LoginEntry[]> {
    return (await this.readAll()).entries;
  }

  async search(query: string): Promise<ReadAllResult> {
    const all = await this.readAll();
    const needle = query.trim().toLowerCase();
    if (needle === "") {
      return all;
    }
    return {
      rejectedIds: all.rejectedIds,
      entries: all.entries.filter(
        (e) => e.url.toLowerCase().includes(needle) || e.username.toLowerCase().includes(needle)
      ),
    };
  }

  async get(id: string): Promise<LoginEntry> {
    const file = await this.store.getRecord(id);
    if (!file) throw new VaultError("NOT_FOUND");
    const payload = await decryptRecord(this.vek, file);
    if (payload.kind !== "login" || payload.deleted) {
      throw new VaultError("NOT_FOUND");
    }
    return toEntry(file, payload);
  }

  async add(input: LoginInput): Promise<LoginEntry> {
    const stamp = this.now().toISOString();
    const payload: LoginPayload = {
      kind: "login",
      url: input.url,
      username: input.username,
      password: input.password,
      created_at: stamp,
      modified_at: stamp,
      deleted: false,
    };
    const file = await encryptRecord(
      this.vek,
      {
        record_id: crypto.randomUUID(),
        schema_version: SCHEMA_VERSION,
        record_version: 1,
        updated_at: stamp,
      },
      payload
    );
    await this.store.putRecord(file);
    return toEntry(file, payload);
  }

  async update(id: string, input: LoginInput): Promise<LoginEntry> {
    const existing = await this.store.getRecord(id);
    if (!existing) throw new VaultError("NOT_FOUND");
    const current = await decryptRecord(this.vek, existing);
    if (current.kind !== "login" || current.deleted) {
      throw new VaultError("NOT_FOUND");
    }
    const stamp = this.now().toISOString();
    const payload: LoginPayload = {
      ...current,
      url: input.url,
      username: input.username,
      password: input.password,
      modified_at: stamp,
    };
    const file = await encryptRecord(
      this.vek,
      {
        record_id: id,
        schema_version: existing.schema_version,
        record_version: existing.record_version + 1,
        updated_at: stamp,
      },
      payload
    );
    await this.store.putRecord(file);
    return toEntry(file, payload);
  }

  /** Registrable domains the user chose never to be asked to save passwords for. */
  async readNeverSave(): Promise<string[]> {
    const domains = new Set<string>();
    for (const file of await this.store.listRecords()) {
      try {
        const payload = await decryptRecord(this.vek, file);
        if (payload.kind === "never_save") {
          for (const domain of payload.domains) domains.add(domain);
        }
      } catch {
        // Records that fail authentication are reported by readAll(); never merged here.
      }
    }
    return [...domains];
  }

  /** Stored as its own encrypted never_save record, so it syncs and leaks nothing. */
  async addNeverSave(domain: string): Promise<void> {
    const normalized = domain.trim().toLowerCase();
    if (normalized === "") throw new VaultCryptoError("INVALID_INPUT");
    if ((await this.readNeverSave()).includes(normalized)) return;
    const stamp = this.now().toISOString();
    const file = await encryptRecord(
      this.vek,
      {
        record_id: crypto.randomUUID(),
        schema_version: SCHEMA_VERSION,
        record_version: 1,
        updated_at: stamp,
      },
      { kind: "never_save", domains: [normalized] }
    );
    await this.store.putRecord(file);
  }

  /** Writes a tombstone: a new record version with deleted = true and no secrets. */
  async delete(id: string): Promise<void> {
    const existing = await this.store.getRecord(id);
    if (!existing) throw new VaultError("NOT_FOUND");
    const current = await decryptRecord(this.vek, existing);
    if (current.kind !== "login" || current.deleted) {
      throw new VaultError("NOT_FOUND");
    }
    const stamp = this.now().toISOString();
    const tombstone: LoginPayload = {
      ...current,
      username: "",
      password: "",
      modified_at: stamp,
      deleted: true,
    };
    const file = await encryptRecord(
      this.vek,
      {
        record_id: id,
        schema_version: existing.schema_version,
        record_version: existing.record_version + 1,
        updated_at: stamp,
      },
      tombstone
    );
    await this.store.putRecord(file);
  }

  /**
   * New salt, new KEK, re-wrap the same VEK, header_version + 1.
   * Records are not re-encrypted. The current password must be correct.
   */
  async changeMasterPassword(currentPassword: string, newPassword: string): Promise<void> {
    const header = await this.store.getHeader();
    if (!header) throw new VaultError("NO_VAULT");
    const vek = await unlockVek(currentPassword, header);
    const kdf: KdfParams = this.kdf ?? {
      memory_kib: header.memory_kib,
      iterations: header.iterations,
      parallelism: header.parallelism,
    };
    const next = await buildHeader(newPassword, vek, kdf, header.header_version + 1);
    await this.store.putHeader(next);
  }
}
