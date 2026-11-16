package com.personal.passwordmanager.core.sync

import com.personal.passwordmanager.core.CryptoErrorCode
import com.personal.passwordmanager.core.SyncErrorCode
import com.personal.passwordmanager.core.SyncException
import com.personal.passwordmanager.core.VaultCryptoException
import com.personal.passwordmanager.core.crypto.RecordMeta
import com.personal.passwordmanager.core.crypto.VaultCrypto
import com.personal.passwordmanager.core.model.LoginPayload
import com.personal.passwordmanager.core.model.NeverSavePayload
import com.personal.passwordmanager.core.model.RecordFile
import com.personal.passwordmanager.core.model.RecordPayload
import com.personal.passwordmanager.core.model.SCHEMA_VERSION
import com.personal.passwordmanager.core.model.VaultHeader
import com.personal.passwordmanager.core.storage.RemoteFile
import com.personal.passwordmanager.core.vault.LocalStore
import com.personal.passwordmanager.core.vault.isoString
import com.personal.passwordmanager.core.vault.parseIso
import java.security.MessageDigest

const val HEADER_NAME = "header.json"
private val RECORD_NAME_RE =
    Regex("^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\.json$")

private class Reject(val reason: RejectReason) : Exception("Rejected cloud file.")

private class VerifiedRemote(val file: RemoteFile, val record: RecordFile, val payload: RecordPayload)

private class Context(
    val deps: SyncDeps,
    val state: SyncState,
    val report: SyncReport,
    val byName: MutableMap<String, MutableList<RemoteFile>> = mutableMapOf(),
    /** Conflict copies created during this run. They are uploaded at the end of it. */
    val created: MutableList<String> = mutableListOf(),
)

private fun Context.save() = deps.state.save(state)

private fun headersEqual(a: VaultHeader, b: VaultHeader) = a == b

private fun payloadsEqual(a: RecordPayload, b: RecordPayload): Boolean = when {
    a is LoginPayload && b is LoginPayload ->
        a.url == b.url && a.username == b.username && a.password == b.password &&
            a.createdAt == b.createdAt && a.modifiedAt == b.modifiedAt && a.deleted == b.deleted &&
            a.conflictOf == b.conflictOf
    a is NeverSavePayload && b is NeverSavePayload -> a.domains.sorted() == b.domains.sorted()
    else -> false
}

/** The authenticated modification time used to order conflicting versions. */
private fun modifiedAt(payload: RecordPayload, file: RecordFile): Long =
    parseIso(if (payload is LoginPayload) payload.modifiedAt else file.updatedAt)

/**
 * Deterministic ID for a conflict copy, so two devices that resolve the same conflict end up
 * with the same copy instead of two. Must match the TypeScript implementation byte for byte.
 */
internal fun conflictRecordId(originalId: String, modified: String, version: Int): String {
    val bytes = MessageDigest.getInstance("SHA-256")
        .digest("conflict|$originalId|$modified|$version".toByteArray(Charsets.UTF_8))
    bytes[6] = ((bytes[6].toInt() and 0x0f) or 0x40).toByte()
    bytes[8] = ((bytes[8].toInt() and 0x3f) or 0x80).toByte()
    val hex = bytes.take(16).joinToString("") { "%02x".format(it.toInt() and 0xff) }
    return "${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-" +
        "${hex.substring(16, 20)}-${hex.substring(20, 32)}"
}

/** Local changes not yet uploaded: records ahead of their last synced version, plus the header. */
fun countPending(store: LocalStore, stateStore: SyncStateStore): Int {
    val state = stateStore.load()
    var count = 0
    for (record in store.listRecords()) {
        val synced = state.records[record.recordId]?.lastSyncedVersion ?: 0
        if (record.recordVersion > synced) count++
    }
    val header = store.getHeader()
    val syncedHeader = state.header
    if (header != null && (syncedHeader == null || header.headerVersion > syncedHeader.lastSyncedHeaderVersion)) {
        count++
    }
    return count
}

/**
 * One client-side sync run (same algorithm as shared/src/sync/engine.ts):
 *  1. list the cloud folder; download only files whose revision changed
 *  2. verify and decrypt every downloaded record; failures are rejected and never merged
 *  3. per record: remote newer and local unchanged -> take remote; local newer and remote
 *     unchanged -> upload; both changed -> keep the later modification as current and store the
 *     other as a conflict copy
 *  4. a cloud copy older than what was already synced is ignored as stale
 *  5. update the sync index
 * Storage errors abort the run; progress made so far is already saved and local changes stay
 * pending for the next run.
 */
suspend fun syncOnce(deps: SyncDeps): SyncReport {
    val ctx = Context(deps, deps.state.load(), SyncReport())
    for (file in deps.adapter.list()) ctx.byName.getOrPut(file.name) { mutableListOf() }.add(file)

    if (syncHeader(ctx) == HeaderFlow.STOP) {
        ctx.report.pending = countPending(deps.store, deps.state)
        return ctx.report
    }

    val ids = linkedSetOf<String>()
    deps.store.listRecords().forEach { ids += it.recordId }
    for (name in ctx.byName.keys) RECORD_NAME_RE.find(name)?.let { ids += it.groupValues[1] }

    for (id in ids) syncRecord(ctx, id)
    // Conflict copies made above have no cloud file yet.
    var i = 0
    while (i < ctx.created.size) syncRecord(ctx, ctx.created[i++])

    ctx.state.lastSyncAt = isoString(deps.clock())
    ctx.save()
    ctx.report.pending = countPending(deps.store, deps.state)
    return ctx.report
}

// ---------------------------------------------------------------- header

private enum class HeaderFlow { CONTINUE, STOP }

private suspend fun syncHeader(ctx: Context): HeaderFlow {
    val deps = ctx.deps
    val state = ctx.state
    val report = ctx.report
    val local = deps.store.getHeader() ?: throw SyncException(SyncErrorCode.NO_VAULT)
    val files = ctx.byName[HEADER_NAME] ?: emptyList()
    val entry = state.header

    fun entryFor(file: RemoteFile, lastSynced: Int, remoteVersion: Int) =
        HeaderSyncEntry(file.id, file.revision, lastSynced, remoteVersion)

    if (files.isEmpty()) {
        val uploaded = deps.adapter.upload(HEADER_NAME, local.toJson())
        state.header = entryFor(uploaded, local.headerVersion, local.headerVersion)
        state.pendingRemoteHeader = null
        report.headerStatus = HeaderStatus.UPLOADED
        ctx.save()
        return HeaderFlow.CONTINUE
    }

    // Cloud header unchanged since the last sync: no download needed.
    val only = files.singleOrNull()
    if (only != null && entry != null && entry.revision == only.revision) {
        if (state.pendingRemoteHeader != null) {
            report.headerStatus = HeaderStatus.REMOTE_NEWER
        } else if (local.headerVersion > entry.lastSyncedHeaderVersion &&
            local.headerVersion >= entry.remoteHeaderVersion
        ) {
            val uploaded = deps.adapter.upload(HEADER_NAME, local.toJson(), only.id)
            state.header = entryFor(uploaded, local.headerVersion, local.headerVersion)
            report.headerStatus = HeaderStatus.UPLOADED
            ctx.save()
        }
        return HeaderFlow.CONTINUE
    }

    var bestFile: RemoteFile? = null
    var bestHeader: VaultHeader? = null
    for (file in files) {
        val header = VaultHeader.parse(deps.adapter.download(file.id)) ?: continue
        val current = bestHeader
        val currentFile = bestFile
        if (current == null || currentFile == null ||
            header.headerVersion > current.headerVersion ||
            (header.headerVersion == current.headerVersion && file.revision > currentFile.revision)
        ) {
            bestFile = file
            bestHeader = header
        }
    }
    if (bestFile == null || bestHeader == null) {
        report.headerStatus = HeaderStatus.REMOTE_INVALID // Left alone; never overwritten or trusted.
        return HeaderFlow.CONTINUE
    }
    val remote: VaultHeader = bestHeader

    if (entry == null) {
        // This device never synced with this cloud folder. Only the very same vault may merge.
        if (headersEqual(local, remote)) {
            state.header = entryFor(bestFile, local.headerVersion, remote.headerVersion)
            ctx.save()
            return HeaderFlow.CONTINUE
        }
        report.headerStatus = HeaderStatus.VAULT_MISMATCH
        return HeaderFlow.STOP
    }

    if (remote.headerVersion < local.headerVersion) {
        // Never let an older cloud header win: ours is newer, so it replaces the cloud copy.
        val uploaded = deps.adapter.upload(HEADER_NAME, local.toJson(), bestFile.id)
        state.header = entryFor(uploaded, local.headerVersion, local.headerVersion)
        state.pendingRemoteHeader = null
        report.headerStatus = HeaderStatus.UPLOADED
    } else if (remote.headerVersion == local.headerVersion && headersEqual(local, remote)) {
        state.header = entryFor(bestFile, local.headerVersion, remote.headerVersion)
        state.pendingRemoteHeader = null
    } else {
        // Newer (or same version but different): never overwrite it. Ask for the new password.
        state.pendingRemoteHeader = remote
        state.header = entryFor(
            bestFile, entry.lastSyncedHeaderVersion,
            maxOf(entry.remoteHeaderVersion, remote.headerVersion)
        )
        report.headerStatus = HeaderStatus.REMOTE_NEWER
    }
    ctx.save()
    return HeaderFlow.CONTINUE
}

// ---------------------------------------------------------------- records

private suspend fun fetchVerified(ctx: Context, id: String, file: RemoteFile): VerifiedRemote {
    val text = ctx.deps.adapter.download(file.id)
    val parsed = RecordFile.parse(text) ?: throw Reject(RejectReason.FORMAT)
    if (parsed.recordId != id) throw Reject(RejectReason.NAME_MISMATCH)
    return try {
        VerifiedRemote(file, parsed, VaultCrypto.decryptRecord(ctx.deps.vek, parsed))
    } catch (e: VaultCryptoException) {
        throw Reject(if (e.code == CryptoErrorCode.AUTH_FAILED) RejectReason.AUTH else RejectReason.FORMAT)
    }
}

private fun markSynced(ctx: Context, id: String, version: Int, file: RemoteFile) {
    ctx.state.records[id] = RecordSyncEntry(version, file.id, file.revision)
}

private suspend fun uploadLocal(ctx: Context, id: String, local: RecordFile, existingId: String?) {
    val file = ctx.deps.adapter.upload("$id.json", local.toJson(), existingId)
    markSynced(ctx, id, local.recordVersion, file)
    ctx.report.uploaded++
    ctx.save()
}

private fun takeRemote(ctx: Context, id: String, remote: VerifiedRemote) {
    ctx.deps.store.putRecord(remote.record)
    markSynced(ctx, id, remote.record.recordVersion, remote.file)
    ctx.report.downloaded++
    ctx.save()
}

/** Keeps a version that lost a conflict as a normal, syncing record with a conflict badge. */
private fun createConflictCopy(ctx: Context, originalId: String, loser: RecordPayload, sourceVersion: Int) {
    if (loser !is LoginPayload || loser.deleted) return // A losing tombstone holds nothing to keep.
    val id = conflictRecordId(originalId, loser.modifiedAt, sourceVersion)
    if (ctx.deps.store.getRecord(id) != null) return
    val stamp = isoString(ctx.deps.clock())
    val file = VaultCrypto.encryptRecord(
        ctx.deps.vek, RecordMeta(id, SCHEMA_VERSION, 1, stamp), loser.copy(conflictOf = originalId)
    )
    ctx.deps.store.putRecord(file)
    ctx.created += id
    ctx.report.conflicts++
}

private suspend fun syncRecord(ctx: Context, id: String) {
    val deps = ctx.deps
    val report = ctx.report
    val files = ctx.byName["$id.json"] ?: emptyList()
    val local = deps.store.getRecord(id)
    val entry = ctx.state.records[id]
    val synced = entry?.lastSyncedVersion ?: 0
    val localPending = local != null && local.recordVersion > synced

    // Nothing in the cloud: upload (also restores a file the provider deleted).
    if (files.isEmpty()) {
        if (local != null) uploadLocal(ctx, id, local, null)
        return
    }

    // Cloud file unchanged since the last sync: only a pending local change needs action.
    val only = files.singleOrNull()
    if (only != null && local != null && entry != null && entry.revision == only.revision) {
        if (localPending) uploadLocal(ctx, id, local, only.id)
        return
    }

    val verified = mutableListOf<VerifiedRemote>()
    for (file in files) {
        try {
            verified += fetchVerified(ctx, id, file)
        } catch (r: Reject) {
            report.rejected += RejectedFile(id, r.reason)
        }
    }
    if (verified.isEmpty()) {
        // Everything in the cloud for this ID failed verification. Never merge it. Our own copy
        // replaces it, which also repairs a tampered or swapped file.
        if (local != null) uploadLocal(ctx, id, local, files.first().id)
        return
    }

    verified.sortWith(
        compareByDescending<VerifiedRemote> { it.record.recordVersion }.thenByDescending { it.file.revision }
    )
    val best = verified.first()
    val remoteVersion = best.record.recordVersion

    if (local == null) {
        takeRemote(ctx, id, best)
    } else {
        val localPayload = try {
            VaultCrypto.decryptRecord(deps.vek, local)
        } catch (_: VaultCryptoException) {
            report.rejected += RejectedFile(id, RejectReason.AUTH) // Our own copy is unreadable.
            return
        }

        if (remoteVersion < synced) {
            // The cloud went backwards past what was already synced: ignore it, then restore it.
            report.stale += id
            uploadLocal(ctx, id, local, best.file.id)
        } else if (remoteVersion == synced) {
            if (localPending) {
                uploadLocal(ctx, id, local, best.file.id)
            } else if (payloadsEqual(localPayload, best.payload)) {
                markSynced(ctx, id, remoteVersion, best.file)
                ctx.save()
            } else {
                resolveConflict(ctx, id, local, localPayload, best)
            }
        } else if (!localPending || payloadsEqual(localPayload, best.payload)) {
            takeRemote(ctx, id, best)
        } else {
            resolveConflict(ctx, id, local, localPayload, best)
        }
    }

    // Duplicate cloud files (two clients created the same name at once): keep any distinct
    // version as a conflict copy, then remove the extras.
    for (extra in verified.drop(1)) {
        if (!payloadsEqual(extra.payload, best.payload)) {
            createConflictCopy(ctx, id, extra.payload, extra.record.recordVersion)
        }
        deps.adapter.delete(extra.file.id)
        report.duplicatesRemoved++
    }
}

/**
 * Both sides changed. The later modification (from the authenticated payload) stays current; on
 * a tie the cloud copy wins so every device decides the same way. The other version is kept as
 * a conflict copy. Nothing is silently overwritten or discarded.
 */
private suspend fun resolveConflict(
    ctx: Context,
    id: String,
    local: RecordFile,
    localPayload: RecordPayload,
    remote: VerifiedRemote,
) {
    val remoteWins = modifiedAt(remote.payload, remote.record) >= modifiedAt(localPayload, local)

    if (remoteWins) {
        takeRemote(ctx, id, remote)
        createConflictCopy(ctx, id, localPayload, local.recordVersion)
        return
    }

    // Local wins: re-save it above both versions so every device sees it as the newest edit.
    val version = maxOf(local.recordVersion, remote.record.recordVersion) + 1
    val bumped = VaultCrypto.encryptRecord(
        ctx.deps.vek,
        RecordMeta(id, local.schemaVersion, version, isoString(ctx.deps.clock())),
        localPayload
    )
    ctx.deps.store.putRecord(bumped)
    createConflictCopy(ctx, id, remote.payload, remote.record.recordVersion)
    uploadLocal(ctx, id, bumped, remote.file.id)
}

// ---------------------------------------------------------------- setup flows

/** The newest valid header in the cloud folder, or null if there is none. */
suspend fun findRemoteHeader(adapter: com.personal.passwordmanager.core.storage.StorageAdapter): Pair<RemoteFile, VaultHeader>? {
    var best: Pair<RemoteFile, VaultHeader>? = null
    for (file in adapter.list()) {
        if (file.name != HEADER_NAME) continue
        val header = VaultHeader.parse(adapter.download(file.id)) ?: continue
        val current = best
        if (current == null || header.headerVersion > current.second.headerVersion) best = file to header
    }
    return best
}

/**
 * New-device flow: download the header, check the master password by unwrapping the VEK, and
 * only then store the header locally. A wrong password stores nothing. The next sync downloads
 * and verifies every record.
 */
suspend fun setupFromRemote(
    password: String,
    adapter: com.personal.passwordmanager.core.storage.StorageAdapter,
    store: LocalStore,
    stateStore: SyncStateStore,
): ByteArray {
    if (store.getHeader() != null) throw SyncException(SyncErrorCode.ALREADY_EXISTS)
    val (file, header) = findRemoteHeader(adapter) ?: throw SyncException(SyncErrorCode.NO_REMOTE_VAULT)
    val vek = com.personal.passwordmanager.core.vault.unlockVek(password, header) // Throws BAD_PASSWORD.
    store.putHeader(header)
    val state = stateStore.load()
    state.header = HeaderSyncEntry(file.id, file.revision, header.headerVersion, header.headerVersion)
    state.pendingRemoteHeader = null
    stateStore.save(state)
    return vek
}

/**
 * Applies a newer cloud header after the user typed the new master password. Returns the VEK it
 * unwraps. A wrong password changes nothing.
 */
fun adoptPendingHeader(password: String, store: LocalStore, stateStore: SyncStateStore): ByteArray {
    val state = stateStore.load()
    val pending = state.pendingRemoteHeader ?: throw SyncException(SyncErrorCode.NO_PENDING_HEADER)
    val vek = com.personal.passwordmanager.core.vault.unlockVek(password, pending)
    store.putHeader(pending)
    state.header?.let {
        state.header = it.copy(
            lastSyncedHeaderVersion = pending.headerVersion,
            remoteHeaderVersion = maxOf(it.remoteHeaderVersion, pending.headerVersion),
        )
    }
    state.pendingRemoteHeader = null
    stateStore.save(state)
    return vek
}
