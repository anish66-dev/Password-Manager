export type VaultCryptoErrorCode =
  "INVALID_INPUT" | "INVALID_FORMAT" | "AUTH_FAILED" | "KDF_FAILED";

const MESSAGES: Record<VaultCryptoErrorCode, string> = {
  INVALID_INPUT: "Invalid input.",
  INVALID_FORMAT: "Invalid data format.",
  AUTH_FAILED: "Authentication failed.",
  KDF_FAILED: "Key derivation failed.",
};

/**
 * Error type for all crypto and vault failures. Messages are fixed strings and
 * never include keys, passwords, plaintext, nonces or ciphertext.
 */
export class VaultCryptoError extends Error {
  readonly code: VaultCryptoErrorCode;

  constructor(code: VaultCryptoErrorCode) {
    super(MESSAGES[code]);
    this.name = "VaultCryptoError";
    this.code = code;
  }
}
