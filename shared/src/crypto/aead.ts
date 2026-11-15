import { type Bytes } from "./bytes.js";
import { VaultCryptoError } from "./errors.js";

export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const SALT_BYTES = 16;

function assertLength(value: Uint8Array, length: number): void {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new VaultCryptoError("INVALID_INPUT");
  }
}

async function importKey(key: Bytes, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  assertLength(key, KEY_BYTES);
  return crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, [usage]);
}

/**
 * AES-256-GCM encryption with an explicit nonce. Callers must pass a fresh random
 * nonce for every call; only test vectors may pass a fixed one.
 */
export async function aesGcmEncrypt(
  key: Bytes,
  nonce: Bytes,
  plaintext: Bytes,
  aad: Bytes
): Promise<Bytes> {
  assertLength(nonce, NONCE_BYTES);
  const cryptoKey = await importKey(key, "encrypt");
  const out = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
    cryptoKey,
    plaintext
  );
  return new Uint8Array(out);
}

export async function aesGcmDecrypt(
  key: Bytes,
  nonce: Bytes,
  ciphertext: Bytes,
  aad: Bytes
): Promise<Bytes> {
  assertLength(nonce, NONCE_BYTES);
  const cryptoKey = await importKey(key, "decrypt");
  try {
    const out = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
      cryptoKey,
      ciphertext
    );
    return new Uint8Array(out);
  } catch {
    throw new VaultCryptoError("AUTH_FAILED");
  }
}
