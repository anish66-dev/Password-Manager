export const FORMAT_VERSION = 1;
export const SCHEMA_VERSION = 1;

export interface WrappedVek {
  /** Base64 96-bit nonce. */
  nonce: string;
  /** Base64 ciphertext (GCM tag appended). */
  ciphertext: string;
}

/** header.json: not secret. */
export interface VaultHeader {
  format_version: number;
  header_version: number;
  kdf: "argon2id";
  /** Base64, 16 random bytes. */
  salt: string;
  memory_kib: number;
  iterations: number;
  parallelism: number;
  wrapped_vek: WrappedVek;
}

/** records/<record_id>.json: ciphertext only. */
export interface RecordFile {
  record_id: string;
  schema_version: number;
  record_version: number;
  updated_at: string;
  nonce: string;
  ciphertext: string;
}

export interface LoginPayload {
  kind: "login";
  url: string;
  username: string;
  password: string;
  created_at: string;
  modified_at: string;
  deleted: boolean;
}

export interface NeverSavePayload {
  kind: "never_save";
  domains: string[];
}

export type RecordPayload = LoginPayload | NeverSavePayload;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function isBase64String(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && BASE64_RE.test(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidVaultHeader(value: unknown): value is VaultHeader {
  if (!isRecord(value)) return false;
  const wrapped = value["wrapped_vek"];
  return (
    isPositiveInt(value["format_version"]) &&
    isPositiveInt(value["header_version"]) &&
    value["kdf"] === "argon2id" &&
    isBase64String(value["salt"]) &&
    isPositiveInt(value["memory_kib"]) &&
    isPositiveInt(value["iterations"]) &&
    isPositiveInt(value["parallelism"]) &&
    isRecord(wrapped) &&
    isBase64String(wrapped["nonce"]) &&
    isBase64String(wrapped["ciphertext"])
  );
}

export function isValidRecordFile(value: unknown): value is RecordFile {
  if (!isRecord(value)) return false;
  return (
    isUuid(value["record_id"]) &&
    isPositiveInt(value["schema_version"]) &&
    isPositiveInt(value["record_version"]) &&
    typeof value["updated_at"] === "string" &&
    isBase64String(value["nonce"]) &&
    isBase64String(value["ciphertext"])
  );
}

export function isValidRecordPayload(value: unknown): value is RecordPayload {
  if (!isRecord(value)) return false;
  if (value["kind"] === "login") {
    return (
      typeof value["url"] === "string" &&
      typeof value["username"] === "string" &&
      typeof value["password"] === "string" &&
      typeof value["created_at"] === "string" &&
      typeof value["modified_at"] === "string" &&
      typeof value["deleted"] === "boolean"
    );
  }
  if (value["kind"] === "never_save") {
    const domains = value["domains"];
    return Array.isArray(domains) && domains.every((d) => typeof d === "string");
  }
  return false;
}
