import { argon2id } from "hash-wasm";
import { type Bytes, utf8Encode } from "./bytes.js";
import { KEY_BYTES, SALT_BYTES } from "./aead.js";
import { VaultCryptoError } from "./errors.js";

export interface KdfParams {
  memory_kib: number;
  iterations: number;
  parallelism: number;
}

/** Starting values from the plan: 64 MiB, 3 iterations, 1 lane. */
export const DEFAULT_KDF_PARAMS: KdfParams = {
  memory_kib: 65536,
  iterations: 3,
  parallelism: 1,
};

const MAX_MEMORY_KIB = 262144; // 256 MiB. The header is untrusted input, so cap it.
const MAX_ITERATIONS = 10;
const MAX_PARALLELISM = 4;
const HKDF_INFO = "vault-kek";

export function assertValidKdfParams(params: KdfParams): void {
  const { memory_kib, iterations, parallelism } = params;
  const ok =
    Number.isSafeInteger(memory_kib) &&
    Number.isSafeInteger(iterations) &&
    Number.isSafeInteger(parallelism) &&
    parallelism >= 1 &&
    parallelism <= MAX_PARALLELISM &&
    iterations >= 1 &&
    iterations <= MAX_ITERATIONS &&
    memory_kib >= 8 * parallelism &&
    memory_kib <= MAX_MEMORY_KIB;
  if (!ok) {
    throw new VaultCryptoError("INVALID_INPUT");
  }
}

/** Argon2id over the UTF-8 bytes of the password (no normalization), 32-byte output. */
export async function deriveMasterKey(
  password: string,
  salt: Bytes,
  params: KdfParams
): Promise<Bytes> {
  if (typeof password !== "string" || password.length === 0) {
    throw new VaultCryptoError("INVALID_INPUT");
  }
  if (!(salt instanceof Uint8Array) || salt.length !== SALT_BYTES) {
    throw new VaultCryptoError("INVALID_INPUT");
  }
  assertValidKdfParams(params);
  try {
    const out = await argon2id({
      password: utf8Encode(password),
      salt,
      parallelism: params.parallelism,
      iterations: params.iterations,
      memorySize: params.memory_kib,
      hashLength: KEY_BYTES,
      outputType: "binary",
    });
    return new Uint8Array(out);
  } catch {
    throw new VaultCryptoError("KDF_FAILED");
  }
}

/** HKDF-SHA256, zero-filled 32-byte salt, info = "vault-kek", 32-byte output. */
export async function deriveKek(masterKey: Bytes): Promise<Bytes> {
  if (!(masterKey instanceof Uint8Array) || masterKey.length !== KEY_BYTES) {
    throw new VaultCryptoError("INVALID_INPUT");
  }
  const baseKey = await crypto.subtle.importKey("raw", masterKey, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: utf8Encode(HKDF_INFO),
    },
    baseKey,
    KEY_BYTES * 8
  );
  return new Uint8Array(bits);
}
