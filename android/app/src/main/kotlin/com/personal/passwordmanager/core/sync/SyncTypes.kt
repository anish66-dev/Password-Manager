package com.personal.passwordmanager.core.sync

import com.personal.passwordmanager.core.model.VaultHeader
import com.personal.passwordmanager.core.model.VaultJson
import com.personal.passwordmanager.core.storage.StorageAdapter
import com.personal.passwordmanager.core.vault.Clock
import com.personal.passwordmanager.core.vault.LocalStore
import com.personal.passwordmanager.core.vault.atomicWrite
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.io.File

/** What is known about one record's relationship with the cloud. */
@Serializable
data class RecordSyncEntry(
    /** record_version of the copy that was last in sync with the cloud. */
    @SerialName("last_synced_version") val lastSyncedVersion: Int,
    /** Provider file ID. Names are not unique in Drive, so the ID is remembered. */
    @SerialName("file_id") val fileId: String?,
    /** The cloud revision marker (checksum or modified time) seen at the last sync. */
    val revision: String?,
)

@Serializable
data class HeaderSyncEntry(
    @SerialName("file_id") val fileId: String?,
    val revision: String?,
    /** header_version of the local header at the last sync. */
    @SerialName("last_synced_header_version") val lastSyncedHeaderVersion: Int,
    /** Highest header_version seen in the cloud. A local header is never uploaded below it. */
    @SerialName("remote_header_version") val remoteHeaderVersion: Int,
)

/**
 * Sync index, stored beside the vault. A record has a pending local change exactly when its
 * local record_version is higher than lastSyncedVersion (or it has no entry yet), so "pending"
 * is derived, never stored separately. Contains no secrets.
 */
@Serializable
data class SyncState(
    val records: MutableMap<String, RecordSyncEntry> = mutableMapOf(),
    var header: HeaderSyncEntry? = null,
    /** A newer header found in the cloud, waiting for the new master password. */
    @SerialName("pending_remote_header") var pendingRemoteHeader: VaultHeader? = null,
    @SerialName("last_sync_at") var lastSyncAt: String? = null,
)

interface SyncStateStore {
    fun load(): SyncState
    fun save(state: SyncState)
}

class InMemorySyncStateStore : SyncStateStore {
    private var json = VaultJson.encodeToString(SyncState.serializer(), SyncState())
    override fun load(): SyncState = VaultJson.decodeFromString(SyncState.serializer(), json)
    override fun save(state: SyncState) { json = VaultJson.encodeToString(SyncState.serializer(), state) }
}

class FileSyncStateStore(private val file: File) : SyncStateStore {
    @Synchronized
    override fun load(): SyncState = try {
        if (file.isFile) VaultJson.decodeFromString(SyncState.serializer(), file.readText(Charsets.UTF_8))
        else SyncState()
    } catch (_: Exception) {
        SyncState() // A damaged index only costs a full re-check; records stay safe.
    }

    @Synchronized
    override fun save(state: SyncState) =
        atomicWrite(file, VaultJson.encodeToString(SyncState.serializer(), state))
}

enum class HeaderStatus(val wire: String) {
    UNCHANGED("unchanged"),
    UPLOADED("uploaded"),

    /** The cloud has a newer header: the new master password is needed to adopt it. */
    REMOTE_NEWER("remote-newer"),

    /** The cloud header is not a valid vault header and was left alone. */
    REMOTE_INVALID("remote-invalid"),

    /** The cloud holds a different vault than this device. Nothing is merged. */
    VAULT_MISMATCH("vault-mismatch"),
}

enum class RejectReason(val wire: String) { AUTH("auth"), FORMAT("format"), NAME_MISMATCH("name-mismatch") }

data class RejectedFile(val recordId: String, val reason: RejectReason)

data class SyncReport(
    var uploaded: Int = 0,
    var downloaded: Int = 0,
    /** Conflict copies created. */
    var conflicts: Int = 0,
    /** Cloud files that failed verification. They are reported and never merged. */
    val rejected: MutableList<RejectedFile> = mutableListOf(),
    /** Records whose cloud copy was older than what was already synced and was ignored. */
    val stale: MutableList<String> = mutableListOf(),
    var duplicatesRemoved: Int = 0,
    var headerStatus: HeaderStatus = HeaderStatus.UNCHANGED,
    /** Local changes still waiting to be uploaded after this run. */
    var pending: Int = 0,
)

class SyncDeps(
    val store: LocalStore,
    val state: SyncStateStore,
    val adapter: StorageAdapter,
    /** Needed to verify and decrypt cloud records. Sync cannot run while the vault is locked. */
    val vek: ByteArray,
    val clock: Clock = System::currentTimeMillis,
)
