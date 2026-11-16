package com.personal.passwordmanager.core.crypto

import com.personal.passwordmanager.core.CryptoErrorCode
import com.personal.passwordmanager.core.VaultCryptoException
import com.personal.passwordmanager.core.model.RecordFile
import com.personal.passwordmanager.core.model.RecordPayload
import com.personal.passwordmanager.core.model.WrappedVek
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.digests.SHA256Digest
import java.security.GeneralSecurityException
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

const val KEY_BYTES = 32
const val NONCE_BYTES = 12
const val SALT_BYTES = 16
private const val TAG_BITS = 128
private const val HKDF_INFO = "vault-kek"
private const val MAX_MEMORY_KIB = 262_144 // The header is untrusted input, so cap it.
private const val MAX_ITERATIONS = 10
private const val MAX_PARALLELISM = 4

data class KdfParams(val memoryKib: Int, val iterations: Int, val parallelism: Int) {
    companion object {
        /** Starting values from the plan: 64 MiB, 3 iterations, 1 lane. Same on every platform. */
        val DEFAULT = KdfParams(memoryKib = 65_536, iterations = 3, parallelism = 1)
    }
}

data class RecordMeta(
    val recordId: String,
    val schemaVersion: Int,
    val recordVersion: Int,
    val updatedAt: String,
)

/**
 * The exact scheme from the plan (Section 5), implemented over maintained libraries only:
 * Argon2id + HKDF-SHA256 from Bouncy Castle, AES-256-GCM from the platform provider.
 * Mirrors shared/src/crypto; the JSON files in shared/test-vectors must pass here.
 */
object VaultCrypto {
    private val random = SecureRandom()

    fun randomBytes(length: Int): ByteArray = ByteArray(length).also { random.nextBytes(it) }

    fun toBase64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    fun fromBase64(text: String): ByteArray = try {
        Base64.getDecoder().decode(text)
    } catch (_: IllegalArgumentException) {
        throw VaultCryptoException(CryptoErrorCode.INVALID_FORMAT)
    }

    fun assertValidKdfParams(p: KdfParams) {
        val ok = p.parallelism in 1..MAX_PARALLELISM &&
            p.iterations in 1..MAX_ITERATIONS &&
            p.memoryKib >= 8 * p.parallelism &&
            p.memoryKib <= MAX_MEMORY_KIB
        if (!ok) throw VaultCryptoException(CryptoErrorCode.INVALID_INPUT)
    }

    /** Argon2id over the UTF-8 bytes of the password (no normalization), 32-byte output. */
    fun deriveMasterKey(password: String, salt: ByteArray, params: KdfParams): ByteArray {
        if (password.isEmpty() || salt.size != SALT_BYTES) {
            throw VaultCryptoException(CryptoErrorCode.INVALID_INPUT)
        }
        assertValidKdfParams(params)
        return try {
            val generator = Argon2BytesGenerator()
            generator.init(
                Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
                    .withVersion(Argon2Parameters.ARGON2_VERSION_13)
                    .withIterations(params.iterations)
                    .withMemoryAsKB(params.memoryKib)
                    .withParallelism(params.parallelism)
                    .withSalt(salt)
                    .build()
            )
            ByteArray(KEY_BYTES).also { generator.generateBytes(password.toByteArray(Charsets.UTF_8), it) }
        } catch (_: Exception) {
            throw VaultCryptoException(CryptoErrorCode.KDF_FAILED)
        }
    }

    /** HKDF-SHA256, zero-filled 32-byte salt, info = "vault-kek", 32-byte output. */
    fun deriveKek(masterKey: ByteArray): ByteArray {
        if (masterKey.size != KEY_BYTES) throw VaultCryptoException(CryptoErrorCode.INVALID_INPUT)
        val hkdf = HKDFBytesGenerator(SHA256Digest())
        hkdf.init(HKDFParameters(masterKey, ByteArray(32), HKDF_INFO.toByteArray(Charsets.UTF_8)))
        return ByteArray(KEY_BYTES).also { hkdf.generateBytes(it, 0, KEY_BYTES) }
    }

    fun generateVek(): ByteArray = randomBytes(KEY_BYTES)

    /** AAD for wrapping the VEK: UTF-8 of "vek|<format_version>". */
    fun vekAad(formatVersion: Int): ByteArray = "vek|$formatVersion".toByteArray(Charsets.UTF_8)

    /** AAD for a record: UTF-8 of "<record_id>|<schema_version>|<record_version>". */
    fun recordAad(recordId: String, schemaVersion: Int, recordVersion: Int): ByteArray =
        "$recordId|$schemaVersion|$recordVersion".toByteArray(Charsets.UTF_8)

    private fun gcm(mode: Int, key: ByteArray, nonce: ByteArray, aad: ByteArray, input: ByteArray): ByteArray {
        if (key.size != KEY_BYTES || nonce.size != NONCE_BYTES) {
            throw VaultCryptoException(CryptoErrorCode.INVALID_INPUT)
        }
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, nonce))
            cipher.updateAAD(aad)
            cipher.doFinal(input)
        } catch (_: GeneralSecurityException) {
            // A wrong key, tampered data and a bad tag are deliberately indistinguishable.
            throw VaultCryptoException(CryptoErrorCode.AUTH_FAILED)
        }
    }

    fun aesGcmEncrypt(key: ByteArray, nonce: ByteArray, plaintext: ByteArray, aad: ByteArray): ByteArray =
        gcm(Cipher.ENCRYPT_MODE, key, nonce, aad, plaintext)

    fun aesGcmDecrypt(key: ByteArray, nonce: ByteArray, ciphertext: ByteArray, aad: ByteArray): ByteArray =
        gcm(Cipher.DECRYPT_MODE, key, nonce, aad, ciphertext)

    fun wrapVek(kek: ByteArray, vek: ByteArray, formatVersion: Int): WrappedVek =
        wrapVekWithNonce(kek, vek, formatVersion, randomBytes(NONCE_BYTES))

    /** Exposed for known-answer tests only. */
    fun wrapVekWithNonce(kek: ByteArray, vek: ByteArray, formatVersion: Int, nonce: ByteArray): WrappedVek {
        if (vek.size != KEY_BYTES) throw VaultCryptoException(CryptoErrorCode.INVALID_INPUT)
        val ct = aesGcmEncrypt(kek, nonce, vek, vekAad(formatVersion))
        return WrappedVek(toBase64(nonce), toBase64(ct))
    }

    /** Fails with AUTH_FAILED on a wrong password (wrong KEK) or any tampering. */
    fun unwrapVek(kek: ByteArray, wrapped: WrappedVek, formatVersion: Int): ByteArray {
        val vek = aesGcmDecrypt(
            kek, fromBase64(wrapped.nonce), fromBase64(wrapped.ciphertext), vekAad(formatVersion)
        )
        if (vek.size != KEY_BYTES) throw VaultCryptoException(CryptoErrorCode.AUTH_FAILED)
        return vek
    }

    fun encryptRecord(vek: ByteArray, meta: RecordMeta, payload: RecordPayload): RecordFile =
        encryptRecordWithNonce(vek, meta, payload, randomBytes(NONCE_BYTES))

    /** Exposed for known-answer tests only. */
    fun encryptRecordWithNonce(
        vek: ByteArray,
        meta: RecordMeta,
        payload: RecordPayload,
        nonce: ByteArray,
    ): RecordFile {
        val shape = RecordFile(meta.recordId, meta.schemaVersion, meta.recordVersion, meta.updatedAt, toBase64(nonce), "AAAA")
        if (!shape.isValid()) throw VaultCryptoException(CryptoErrorCode.INVALID_INPUT)
        val ct = aesGcmEncrypt(
            vek, nonce, payload.toJson().toByteArray(Charsets.UTF_8),
            recordAad(meta.recordId, meta.schemaVersion, meta.recordVersion)
        )
        return shape.copy(ciphertext = toBase64(ct))
    }

    /**
     * Verifies and decrypts a record. Any change to the ciphertext, nonce, record ID, schema
     * version or record version fails authentication.
     */
    fun decryptRecord(vek: ByteArray, file: RecordFile): RecordPayload {
        if (!file.isValid()) throw VaultCryptoException(CryptoErrorCode.INVALID_FORMAT)
        val plaintext = aesGcmDecrypt(
            vek, fromBase64(file.nonce), fromBase64(file.ciphertext),
            recordAad(file.recordId, file.schemaVersion, file.recordVersion)
        )
        val text = try {
            Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(plaintext)).toString()
        } catch (_: java.nio.charset.CharacterCodingException) {
            throw VaultCryptoException(CryptoErrorCode.INVALID_FORMAT)
        }
        return RecordPayload.parse(text) ?: throw VaultCryptoException(CryptoErrorCode.INVALID_FORMAT)
    }
}
