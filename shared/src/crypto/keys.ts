import { type Bytes, fromBase64, randomBytes, toBase64, utf8Encode } from "./bytes.js";
import { KEY_BYTES, NONCE_BYTES, aesGcmDecrypt, aesGcmEncrypt } from "./aead.js";
import { VaultCryptoError } from "./errors.js";
import { type WrappedVek } from "../types/vault.js";

export function generateVek(): Bytes {
  return randomBytes(KEY_BYTES);
}

/** AAD for wrapping the VEK: UTF-8 of "vek|<format_version>". */
export function vekAad(formatVersion: number): Bytes {
  return utf8Encode(`vek|${formatVersion}`);
}

export async function wrapVek(kek: Bytes, vek: Bytes, formatVersion: number): Promise<WrappedVek> {
  return wrapVekWithNonce(kek, vek, formatVersion, randomBytes(NONCE_BYTES));
}

/** Exposed for known-answer tests only. Do not use outside tests. */
export async function wrapVekWithNonce(
  kek: Bytes,
  vek: Bytes,
  formatVersion: number,
  nonce: Bytes
): Promise<WrappedVek> {
  if (!(vek instanceof Uint8Array) || vek.length !== KEY_BYTES) {
    throw new VaultCryptoError("INVALID_INPUT");
  }
  const ciphertext = await aesGcmEncrypt(kek, nonce, vek, vekAad(formatVersion));
  return { nonce: toBase64(nonce), ciphertext: toBase64(ciphertext) };
}

/** Fails with AUTH_FAILED on a wrong password (wrong KEK) or any tampering. */
export async function unwrapVek(
  kek: Bytes,
  wrapped: WrappedVek,
  formatVersion: number
): Promise<Bytes> {
  const vek = await aesGcmDecrypt(
    kek,
    fromBase64(wrapped.nonce),
    fromBase64(wrapped.ciphertext),
    vekAad(formatVersion)
  );
  if (vek.length !== KEY_BYTES) {
    throw new VaultCryptoError("AUTH_FAILED");
  }
  return vek;
}
