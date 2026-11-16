package com.personal.passwordmanager.core.vault

import com.personal.passwordmanager.core.CryptoErrorCode
import com.personal.passwordmanager.core.VaultCryptoException
import com.personal.passwordmanager.core.VaultErrorCode
import com.personal.passwordmanager.core.VaultException
import com.personal.passwordmanager.core.crypto.KdfParams
import com.personal.passwordmanager.core.crypto.RecordMeta
import com.personal.passwordmanager.core.crypto.SALT_BYTES
import com.personal.passwordmanager.core.crypto.VaultCrypto
import com.personal.passwordmanager.core.model.FORMAT_VERSION
import com.personal.passwordmanager.core.model.LoginPayload
import com.personal.passwordmanager.core.model.NeverSavePayload
import com.personal.passwordmanager.core.model.RecordFile
import com.personal.passwordmanager.core.model.SCHEMA_VERSION
import com.personal.passwordmanager.core.model.VaultHeader
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.UUID

/** Millisecond clock, injectable so tests control which edit is "later". */
typealias Clock = () -> Long

private val ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

/** ISO-8601 UTC with milliseconds, identical to JavaScript's Date.toISOString(). */
fun isoString(millis: Long): String = ISO.format(Instant.ofEpochMilli(millis))

/** Milliseconds for a timestamp string, or 0 when it cannot be parsed. */
fun parseIso(text: String): Long = try {
    Instant.parse(text).toEpochMilli()
} catch (_: Exception) {
    0L
}

data class LoginInput(val url: String, val username: String, val password: String)

data class LoginEntry(
    val id: String,
    val url: String,
    val username: String,
    val password: String,
    val createdAt: String,
    val modifiedAt: String,
    val recordVersion: Int,
    /** Present on conflict copies created by sync. */
    val conflictOf: String? = null,
    /** Native app package this login is linked to (Android autofill), if any. */
    val appPackage: String? = null,
) {
    // Never print secrets by accident.
    override fun toString(): String = "LoginEntry(id=$id, url=$url)"
}

data class ReadAllResult(val entries: List<LoginEntry>, val rejectedIds: List<String>)

/** Derives the KEK from the password and unwraps the VEK. A wrong password fails. */
fun unlockVek(password: String, header: VaultHeader): ByteArray {
    if (!header.isValid()) throw VaultCryptoException(CryptoErrorCode.INVALID_FORMAT)
    val masterKey = VaultCrypto.deriveMasterKey(
        password, VaultCrypto.fromBase64(header.salt),
        KdfParams(header.memoryKib, header.iterations, header.parallelism)
    )
    val kek = VaultCrypto.deriveKek(masterKey)
    return try {
        VaultCrypto.unwrapVek(kek, header.wrappedVek, header.formatVersion)
    } catch (e: VaultCryptoException) {
        if (e.code == CryptoErrorCode.AUTH_FAILED) throw VaultException(VaultErrorCode.BAD_PASSWORD)
        throw e
    }
}

private fun buildHeader(password: String, vek: ByteArray, kdf: KdfParams, headerVersion: Int): VaultHeader {
    val salt = VaultCrypto.randomBytes(SALT_BYTES)
    val kek = VaultCrypto.deriveKek(VaultCrypto.deriveMasterKey(password, salt, kdf))
    val wrapped = VaultCrypto.wrapVek(kek, vek, FORMAT_VERSION)
    return VaultHeader(
        formatVersion = FORMAT_VERSION,
        headerVersion = headerVersion,
        kdf = "argon2id",
        salt = VaultCrypto.toBase64(salt),
        memoryKib = kdf.memoryKib,
        iterations = kdf.iterations,
        parallelism = kdf.parallelism,
        wrappedVek = wrapped,
    )
}

/** Creates a new vault: random VEK wrapped under the password-derived KEK. */
fun createVault(
    password: String,
    store: LocalStore,
    kdf: KdfParams = KdfParams.DEFAULT,
    clock: Clock = System::currentTimeMillis,
): Vault {
    if (store.getHeader() != null) throw VaultException(VaultErrorCode.ALREADY_EXISTS)
    val vek = VaultCrypto.generateVek()
    store.putHeader(buildHeader(password, vek, kdf, 1))
    return Vault(store, vek, kdf, clock)
}

/** Unlocks an existing vault. Throws VaultException(BAD_PASSWORD) on a wrong password. */
fun unlockVault(
    password: String,
    store: LocalStore,
    clock: Clock = System::currentTimeMillis,
): Vault {
    val header = store.getHeader() ?: throw VaultException(VaultErrorCode.NO_VAULT)
    return Vault(store, unlockVek(password, header), null, clock)
}

/** An unlocked vault. Holds the VEK in memory only. */
class Vault(
    private val store: LocalStore,
    private val vek: ByteArray,
    private val kdf: KdfParams? = null,
    private val clock: Clock = System::currentTimeMillis,
) {
    /** The raw VEK, for session handling only. Never log or persist it unencrypted. */
    fun exportSessionKey(): ByteArray = vek.copyOf()

    private fun entry(file: RecordFile, p: LoginPayload) = LoginEntry(
        id = file.recordId, url = p.url, username = p.username, password = p.password,
        createdAt = p.createdAt, modifiedAt = p.modifiedAt, recordVersion = file.recordVersion,
        conflictOf = p.conflictOf, appPackage = p.appPackage,
    )

    fun readAll(): ReadAllResult {
        val entries = mutableListOf<LoginEntry>()
        val rejected = mutableListOf<String>()
        for (file in store.listRecords()) {
            try {
                val payload = VaultCrypto.decryptRecord(vek, file)
                if (payload is LoginPayload && !payload.deleted) entries += entry(file, payload)
            } catch (_: VaultCryptoException) {
                rejected += file.recordId
            }
        }
        entries.sortWith(
            compareBy<LoginEntry, String>(String.CASE_INSENSITIVE_ORDER) { it.url }
                .thenBy(String.CASE_INSENSITIVE_ORDER) { it.username }
        )
        return ReadAllResult(entries, rejected)
    }

    fun list(): List<LoginEntry> = readAll().entries

    fun search(query: String): ReadAllResult {
        val all = readAll()
        val needle = query.trim().lowercase()
        if (needle.isEmpty()) return all
        return all.copy(entries = all.entries.filter {
            it.url.lowercase().contains(needle) || it.username.lowercase().contains(needle)
        })
    }

    fun get(id: String): LoginEntry {
        val file = store.getRecord(id) ?: throw VaultException(VaultErrorCode.NOT_FOUND)
        val payload = VaultCrypto.decryptRecord(vek, file)
        if (payload !is LoginPayload || payload.deleted) throw VaultException(VaultErrorCode.NOT_FOUND)
        return entry(file, payload)
    }

    fun add(input: LoginInput, appPackage: String? = null): LoginEntry {
        val stamp = isoString(clock())
        val payload = LoginPayload(
            url = input.url, username = input.username, password = input.password,
            createdAt = stamp, modifiedAt = stamp, deleted = false, appPackage = appPackage,
        )
        val file = VaultCrypto.encryptRecord(
            vek, RecordMeta(UUID.randomUUID().toString(), SCHEMA_VERSION, 1, stamp), payload
        )
        store.putRecord(file)
        return entry(file, payload)
    }

    fun update(id: String, input: LoginInput, appPackage: String? = null, keepAppPackage: Boolean = true): LoginEntry {
        val existing = store.getRecord(id) ?: throw VaultException(VaultErrorCode.NOT_FOUND)
        val current = VaultCrypto.decryptRecord(vek, existing)
        if (current !is LoginPayload || current.deleted) throw VaultException(VaultErrorCode.NOT_FOUND)
        val stamp = isoString(clock())
        val payload = current.copy(
            url = input.url, username = input.username, password = input.password, modifiedAt = stamp,
            appPackage = if (keepAppPackage && appPackage == null) current.appPackage else appPackage,
        )
        val file = VaultCrypto.encryptRecord(
            vek, RecordMeta(id, existing.schemaVersion, existing.recordVersion + 1, stamp), payload
        )
        store.putRecord(file)
        return entry(file, payload)
    }

    /** Registrable domains the user chose never to be asked to save passwords for. */
    fun readNeverSave(): Set<String> {
        val domains = linkedSetOf<String>()
        for (file in store.listRecords()) {
            try {
                val payload = VaultCrypto.decryptRecord(vek, file)
                if (payload is NeverSavePayload) domains += payload.domains
            } catch (_: VaultCryptoException) {
                // Reported by readAll(); never merged here.
            }
        }
        return domains
    }

    /** Stored as its own encrypted never_save record, so it syncs and leaks nothing. */
    fun addNeverSave(domain: String) {
        val normalized = domain.trim().lowercase()
        if (normalized.isEmpty()) throw VaultCryptoException(CryptoErrorCode.INVALID_INPUT)
        if (normalized in readNeverSave()) return
        val stamp = isoString(clock())
        store.putRecord(
            VaultCrypto.encryptRecord(
                vek, RecordMeta(UUID.randomUUID().toString(), SCHEMA_VERSION, 1, stamp),
                NeverSavePayload(listOf(normalized))
            )
        )
    }

    /** Writes a tombstone: a new record version with deleted = true and no secrets. */
    fun delete(id: String) {
        val existing = store.getRecord(id) ?: throw VaultException(VaultErrorCode.NOT_FOUND)
        val current = VaultCrypto.decryptRecord(vek, existing)
        if (current !is LoginPayload || current.deleted) throw VaultException(VaultErrorCode.NOT_FOUND)
        val stamp = isoString(clock())
        val tombstone = current.copy(username = "", password = "", modifiedAt = stamp, deleted = true)
        store.putRecord(
            VaultCrypto.encryptRecord(
                vek, RecordMeta(id, existing.schemaVersion, existing.recordVersion + 1, stamp), tombstone
            )
        )
    }

    /**
     * New salt, new KEK, re-wrap the same VEK, header_version + 1. Records are not re-encrypted.
     * The current password must be correct.
     */
    fun changeMasterPassword(currentPassword: String, newPassword: String) {
        val header = store.getHeader() ?: throw VaultException(VaultErrorCode.NO_VAULT)
        val unwrapped = unlockVek(currentPassword, header)
        val params = kdf ?: KdfParams(header.memoryKib, header.iterations, header.parallelism)
        store.putHeader(buildHeader(newPassword, unwrapped, params, header.headerVersion + 1))
    }
}
