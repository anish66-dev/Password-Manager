import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveKek,
  deriveMasterKey,
  fromBase64,
  toBase64,
  unwrapVek,
  utf8Encode,
} from "./index.js";
import { wrapVekWithNonce } from "./keys.js";
import { decryptRecord, encryptRecordWithNonce, recordAad } from "./records.js";
import { type LoginPayload, type RecordFile } from "../types/vault.js";

/**
 * Known-answer tests. Inputs are fixed in this file only (never used by app code).
 * The JSON files in shared/test-vectors/ are reused by the Android tests.
 *
 * Regenerate with: UPDATE_VECTORS=1 npx vitest run shared/src/crypto/vectors.test.ts
 */
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../test-vectors");
const UPDATE = process.env["UPDATE_VECTORS"] === "1";

function seq(length: number, start: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length }, (_, i) => (start + i) & 0xff);
}

function load<T>(file: string, build: () => Promise<T>): Promise<{ expected: T; actual: T }> {
  return build().then((actual) => {
    const target = path.join(dir, file);
    if (UPDATE) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(target, JSON.stringify(actual, null, 2) + "\n");
    }
    if (!existsSync(target)) {
      throw new Error(`Missing test vector file ${file}. Run with UPDATE_VECTORS=1.`);
    }
    return { expected: JSON.parse(readFileSync(target, "utf8")) as T, actual };
  });
}

const KDF_CASES = [
  {
    description: "Argon2id with small parameters (fast)",
    password: "correct horse battery staple",
    memory_kib: 64,
    iterations: 2,
    parallelism: 1,
  },
  {
    description: "Argon2id with the default parameters (64 MiB, 3 iterations, 1 lane)",
    password: "pässwörd-✓-🔑",
    memory_kib: 65536,
    iterations: 3,
    parallelism: 1,
  },
];

describe("known-answer test vectors", () => {
  it("kdf.json: Argon2id master key and HKDF KEK", async () => {
    const salt = seq(16, 0x00);
    const { expected, actual } = await load("kdf.json", async () => ({
      description:
        "master_key = Argon2id(utf8(password), salt, params); kek = HKDF-SHA256(master_key, zero-salt-32, 'vault-kek')",
      salt_b64: toBase64(salt),
      cases: await Promise.all(
        KDF_CASES.map(async (c) => {
          const masterKey = await deriveMasterKey(c.password, salt, c);
          const kek = await deriveKek(masterKey);
          return { ...c, master_key_b64: toBase64(masterKey), kek_b64: toBase64(kek) };
        })
      ),
    }));
    expect(actual).toEqual(expected);
  }, 30000);

  it("wrap.json: VEK wrapping with AAD vek|<format_version>", async () => {
    const kek = seq(32, 0x40);
    const vek = seq(32, 0x80);
    const nonce = seq(12, 0xa0);
    const { expected, actual } = await load("wrap.json", async () => {
      const wrapped = await wrapVekWithNonce(kek, vek, 1, nonce);
      const good = {
        kek_b64: toBase64(kek),
        vek_b64: toBase64(vek),
        format_version: 1,
        aad_utf8: "vek|1",
        wrapped_vek: wrapped,
      };
      return {
        description: "AES-256-GCM(KEK, VEK), AAD = utf8('vek|' + format_version), tag appended",
        ...good,
        must_fail: [
          {
            reason: "wrong format_version (AAD mismatch)",
            format_version: 2,
            wrapped_vek: wrapped,
          },
          {
            reason: "ciphertext bit flipped",
            format_version: 1,
            wrapped_vek: {
              nonce: wrapped.nonce,
              ciphertext: toBase64(flip(fromBase64(wrapped.ciphertext))),
            },
          },
          {
            reason: "wrong KEK",
            kek_b64: toBase64(seq(32, 0x41)),
            format_version: 1,
            wrapped_vek: wrapped,
          },
        ],
      };
    });
    expect(actual).toEqual(expected);
    // Verify the stored vector independently of generation.
    const stored = expected as typeof actual;
    expect(await unwrapVek(fromBase64(stored.kek_b64), stored.wrapped_vek, 1)).toEqual(vek);
    for (const bad of stored.must_fail) {
      const kekForCase = fromBase64("kek_b64" in bad ? bad.kek_b64 : stored.kek_b64);
      await expect(unwrapVek(kekForCase, bad.wrapped_vek, bad.format_version)).rejects.toThrow();
    }
  });

  it("record.json: record encryption with AAD <id>|<schema>|<version>", async () => {
    const vek = seq(32, 0x10);
    const nonce = seq(12, 0xc0);
    const meta = {
      record_id: "0f8fad5b-d9cb-469f-a165-70867728950e",
      schema_version: 1,
      record_version: 3,
      updated_at: "2026-11-14T10:00:00.000Z",
    };
    const payload: LoginPayload = {
      kind: "login",
      url: "https://example.com/login",
      username: "alice@example.com",
      password: "hunter2-✓",
      created_at: "2026-11-14T09:00:00.000Z",
      modified_at: "2026-11-14T10:00:00.000Z",
      deleted: false,
    };
    const { expected, actual } = await load("record.json", async () => {
      const file = await encryptRecordWithNonce(vek, meta, payload, nonce);
      const other = "6ba7b810-9dad-41d1-80ed-00c04fd430c8";
      const mutate = (reason: string, changes: Partial<RecordFile>) => ({
        reason,
        record_file: { ...file, ...changes },
      });
      return {
        description:
          "AES-256-GCM(VEK, utf8(JSON payload)), AAD = utf8(record_id|schema_version|record_version). Decrypt and parse the JSON; do not re-serialize.",
        vek_b64: toBase64(vek),
        aad_utf8: new TextDecoder().decode(recordAad(meta)),
        payload,
        plaintext_utf8: JSON.stringify(payload),
        record_file: file,
        must_fail: [
          mutate("ciphertext bit flipped", {
            ciphertext: toBase64(flip(fromBase64(file.ciphertext))),
          }),
          mutate("nonce bit flipped", { nonce: toBase64(flip(fromBase64(file.nonce))) }),
          mutate("record_id changed (swapped file)", { record_id: other }),
          mutate("schema_version changed", { schema_version: 2 }),
          mutate("record_version changed", { record_version: 4 }),
        ],
      };
    });
    expect(actual).toEqual(expected);
    const stored = expected as typeof actual;
    expect(await decryptRecord(fromBase64(stored.vek_b64), stored.record_file)).toEqual(payload);
    expect(utf8Encode(stored.plaintext_utf8).length).toBeGreaterThan(0);
    for (const bad of stored.must_fail) {
      await expect(decryptRecord(fromBase64(stored.vek_b64), bad.record_file)).rejects.toThrow();
    }
  });
});

function flip(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes);
  copy[0] = (copy[0] ?? 0) ^ 0x01;
  return copy;
}
