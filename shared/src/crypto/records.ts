import { type Bytes, fromBase64, randomBytes, toBase64, utf8Decode, utf8Encode } from "./bytes.js";
import { NONCE_BYTES, aesGcmDecrypt, aesGcmEncrypt } from "./aead.js";
import { VaultCryptoError } from "./errors.js";
import {
  type RecordFile,
  type RecordPayload,
  isValidRecordFile,
  isValidRecordPayload,
} from "../types/vault.js";

export interface RecordMeta {
  record_id: string;
  schema_version: number;
  record_version: number;
  updated_at: string;
}

/** AAD: UTF-8 of "<record_id>|<schema_version>|<record_version>". */
export function recordAad(
  meta: Pick<RecordMeta, "record_id" | "schema_version" | "record_version">
): Bytes {
  return utf8Encode(`${meta.record_id}|${meta.schema_version}|${meta.record_version}`);
}

export async function encryptRecord(
  vek: Bytes,
  meta: RecordMeta,
  payload: RecordPayload
): Promise<RecordFile> {
  return encryptRecordWithNonce(vek, meta, payload, randomBytes(NONCE_BYTES));
}

/** Exposed for known-answer tests only. Do not use outside tests. */
export async function encryptRecordWithNonce(
  vek: Bytes,
  meta: RecordMeta,
  payload: RecordPayload,
  nonce: Bytes
): Promise<RecordFile> {
  const shape: RecordFile = {
    record_id: meta.record_id,
    schema_version: meta.schema_version,
    record_version: meta.record_version,
    updated_at: meta.updated_at,
    nonce: toBase64(nonce),
    ciphertext: "AAAA",
  };
  if (!isValidRecordFile(shape) || !isValidRecordPayload(payload)) {
    throw new VaultCryptoError("INVALID_INPUT");
  }
  const ciphertext = await aesGcmEncrypt(
    vek,
    nonce,
    utf8Encode(JSON.stringify(payload)),
    recordAad(meta)
  );
  return { ...shape, ciphertext: toBase64(ciphertext) };
}

/**
 * Verifies and decrypts a record. Any change to the ciphertext, nonce, record ID,
 * schema version or record version fails authentication.
 */
export async function decryptRecord(vek: Bytes, file: RecordFile): Promise<RecordPayload> {
  if (!isValidRecordFile(file)) {
    throw new VaultCryptoError("INVALID_FORMAT");
  }
  const plaintext = await aesGcmDecrypt(
    vek,
    fromBase64(file.nonce),
    fromBase64(file.ciphertext),
    recordAad(file)
  );
  let payload: unknown;
  try {
    payload = JSON.parse(utf8Decode(plaintext));
  } catch {
    throw new VaultCryptoError("INVALID_FORMAT");
  }
  if (!isValidRecordPayload(payload)) {
    throw new VaultCryptoError("INVALID_FORMAT");
  }
  return payload;
}
