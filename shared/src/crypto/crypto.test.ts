import { describe, it, expect } from "vitest";
import {
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
  utf8Encode,
  wrapVek,
} from "./index.js";
import { type LoginPayload, type RecordFile } from "../types/vault.js";

const FAST_KDF = { memory_kib: 64, iterations: 1, parallelism: 1 };
const SALT = new Uint8Array(16).fill(7);

const payload: LoginPayload = {
  kind: "login",
  url: "https://example.com",
  username: "alice",
  password: "correct horse battery staple",
  created_at: "2026-01-01T00:00:00.000Z",
  modified_at: "2026-01-01T00:00:00.000Z",
  deleted: false,
};

const meta = {
  record_id: "5b2f2b9e-6a2c-4a43-9f0e-3e1f6c1d2a10",
  schema_version: 1,
  record_version: 1,
  updated_at: "2026-01-01T00:00:00.000Z",
};

async function expectAuthFailure(promise: Promise<unknown>): Promise<VaultCryptoError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(VaultCryptoError);
    expect((err as VaultCryptoError).code).toBe("AUTH_FAILED");
    return err as VaultCryptoError;
  }
  throw new Error("expected authentication failure");
}

function flipBase64Byte(value: string): string {
  const bytes = fromBase64(value);
  bytes[0] = (bytes[0] ?? 0) ^ 0x01;
  return toBase64(bytes);
}

describe("base64", () => {
  it("round-trips and is strict", () => {
    const bytes = randomBytes(33);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(() => fromBase64("abc")).toThrow(VaultCryptoError); // unpadded
    expect(() => fromBase64("ab-_")).toThrow(VaultCryptoError); // url-safe
    expect(() => fromBase64("ab\ncd==")).toThrow(VaultCryptoError);
  });
});

describe("key derivation", () => {
  it("is deterministic and password/salt sensitive", async () => {
    const a = await deriveMasterKey("password-one", SALT, FAST_KDF);
    const b = await deriveMasterKey("password-one", SALT, FAST_KDF);
    const c = await deriveMasterKey("password-two", SALT, FAST_KDF);
    const d = await deriveMasterKey("password-one", new Uint8Array(16).fill(8), FAST_KDF);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).not.toEqual(d);
    expect(a.length).toBe(32);
    expect((await deriveKek(a)).length).toBe(32);
    expect(await deriveKek(a)).not.toEqual(a);
  });

  it("rejects unsafe or malformed parameters", async () => {
    await expect(deriveMasterKey("pw", SALT, { ...FAST_KDF, memory_kib: 4 })).rejects.toThrow(
      VaultCryptoError
    );
    await expect(
      deriveMasterKey("pw", SALT, { ...FAST_KDF, memory_kib: 4 * 1024 * 1024 })
    ).rejects.toThrow(VaultCryptoError);
    await expect(deriveMasterKey("pw", SALT, { ...FAST_KDF, iterations: 0 })).rejects.toThrow(
      VaultCryptoError
    );
    await expect(deriveMasterKey("", SALT, FAST_KDF)).rejects.toThrow(VaultCryptoError);
    await expect(deriveMasterKey("pw", new Uint8Array(8), FAST_KDF)).rejects.toThrow(
      VaultCryptoError
    );
  });
});

describe("VEK wrapping", () => {
  it("unwraps with the right KEK only", async () => {
    const kek = await deriveKek(await deriveMasterKey("right-password", SALT, FAST_KDF));
    const wrongKek = await deriveKek(await deriveMasterKey("wrong-password", SALT, FAST_KDF));
    const vek = generateVek();
    const wrapped = await wrapVek(kek, vek, 1);

    expect(await unwrapVek(kek, wrapped, 1)).toEqual(vek);
    await expectAuthFailure(unwrapVek(wrongKek, wrapped, 1));
  });

  it("fails on a changed nonce, ciphertext or format version", async () => {
    const kek = generateVek();
    const wrapped = await wrapVek(kek, generateVek(), 1);
    await expectAuthFailure(
      unwrapVek(kek, { ...wrapped, nonce: flipBase64Byte(wrapped.nonce) }, 1)
    );
    await expectAuthFailure(
      unwrapVek(kek, { ...wrapped, ciphertext: flipBase64Byte(wrapped.ciphertext) }, 1)
    );
    await expectAuthFailure(unwrapVek(kek, wrapped, 2));
  });
});

describe("record encryption", () => {
  it("round-trips a login payload", async () => {
    const vek = generateVek();
    const file = await encryptRecord(vek, meta, payload);
    expect(file.record_id).toBe(meta.record_id);
    expect(file.ciphertext).not.toContain(payload.password);
    expect(await decryptRecord(vek, file)).toEqual(payload);
  });

  it("round-trips a never_save payload", async () => {
    const vek = generateVek();
    const never = { kind: "never_save" as const, domains: ["example.com"] };
    const file = await encryptRecord(vek, meta, never);
    expect(await decryptRecord(vek, file)).toEqual(never);
  });

  it("fails with the wrong key", async () => {
    const file = await encryptRecord(generateVek(), meta, payload);
    await expectAuthFailure(decryptRecord(generateVek(), file));
  });

  const tampers: Array<[string, (f: RecordFile) => RecordFile]> = [
    ["ciphertext", (f) => ({ ...f, ciphertext: flipBase64Byte(f.ciphertext) })],
    ["nonce", (f) => ({ ...f, nonce: flipBase64Byte(f.nonce) })],
    ["record ID", (f) => ({ ...f, record_id: "11111111-1111-4111-8111-111111111111" })],
    ["schema version", (f) => ({ ...f, schema_version: f.schema_version + 1 })],
    ["record version", (f) => ({ ...f, record_version: f.record_version + 1 })],
  ];

  for (const [name, tamper] of tampers) {
    it(`fails authentication when the ${name} is changed`, async () => {
      const vek = generateVek();
      const file = await encryptRecord(vek, meta, payload);
      await expectAuthFailure(decryptRecord(vek, tamper(file)));
    });
  }

  it("rejects a swapped file (ciphertext moved into another record)", async () => {
    const vek = generateVek();
    const a = await encryptRecord(vek, meta, payload);
    const b = await encryptRecord(
      vek,
      { ...meta, record_id: "22222222-2222-4222-8222-222222222222" },
      { ...payload, username: "bob" }
    );
    await expectAuthFailure(decryptRecord(vek, { ...a, record_id: b.record_id }));
  });

  it("uses a distinct nonce for each of 1,000 encryptions", async () => {
    const vek = generateVek();
    const nonces = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const file = await encryptRecord(vek, meta, payload);
      nonces.add(file.nonce);
    }
    expect(nonces.size).toBe(1000);
  });

  it("rejects malformed record files and payloads", async () => {
    const vek = generateVek();
    const file = await encryptRecord(vek, meta, payload);
    await expect(decryptRecord(vek, { ...file, record_id: "not-a-uuid" })).rejects.toThrow(
      VaultCryptoError
    );
    await expect(
      encryptRecord(vek, meta, { kind: "login", url: 1 } as unknown as LoginPayload)
    ).rejects.toThrow(VaultCryptoError);
  });
});

describe("error hygiene", () => {
  it("never puts key material, passwords or plaintext in error messages", async () => {
    const secretPassword = "Sup3r-Secret-Passphrase-Value";
    const vek = generateVek();
    const kek = generateVek();
    const file = await encryptRecord(vek, meta, { ...payload, password: secretPassword });
    const wrapped = await wrapVek(kek, vek, 1);

    const errors: unknown[] = [];
    const attempts: Array<() => Promise<unknown>> = [
      () => decryptRecord(kek, file),
      () => decryptRecord(vek, { ...file, ciphertext: flipBase64Byte(file.ciphertext) }),
      () => unwrapVek(vek, wrapped, 1),
      () => deriveMasterKey(secretPassword, new Uint8Array(3), FAST_KDF),
      () => deriveMasterKey(secretPassword, SALT, { ...FAST_KDF, iterations: 99 }),
    ];
    for (const attempt of attempts) {
      try {
        await attempt();
      } catch (err) {
        errors.push(err);
      }
    }
    expect(errors.length).toBe(attempts.length);

    const forbidden = [
      secretPassword,
      toBase64(vek),
      toBase64(kek),
      Buffer.from(vek).toString("hex"),
      Buffer.from(kek).toString("hex"),
      toBase64(utf8Encode(secretPassword)),
      file.ciphertext,
      file.nonce,
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(VaultCryptoError);
      const text = `${(err as Error).message} ${(err as Error).stack ?? ""} ${JSON.stringify(err)}`;
      for (const secret of forbidden) {
        expect(text).not.toContain(secret);
      }
    }
  });
});
