import { VaultCryptoError } from "./errors.js";

/** Uint8Array backed by a plain ArrayBuffer, which Web Crypto accepts as BufferSource. */
export type Bytes = Uint8Array<ArrayBuffer>;

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function randomBytes(length: number): Bytes {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

export function utf8Encode(value: string): Bytes {
  return new Uint8Array(new TextEncoder().encode(value));
}

export function utf8Decode(value: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

/** Standard Base64 (RFC 4648) with padding. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Strict decoder: rejects unpadded or URL-safe input. */
export function fromBase64(value: string): Bytes {
  if (typeof value !== "string" || !BASE64_RE.test(value)) {
    throw new VaultCryptoError("INVALID_FORMAT");
  }
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
