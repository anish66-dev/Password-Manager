package com.personal.passwordmanager.sync

import com.personal.passwordmanager.Prefs
import com.personal.passwordmanager.Session
import com.personal.passwordmanager.core.StorageException
import com.personal.passwordmanager.core.SyncErrorCode
import com.personal.passwordmanager.core.SyncException
import com.personal.passwordmanager.core.storage.StorageAdapter
import com.personal.passwordmanager.core.sync.HeaderStatus
import com.personal.passwordmanager.core.sync.SyncDeps
import com.personal.passwordmanager.core.sync.SyncStateStore
import com.personal.passwordmanager.core.sync.adoptPendingHeader
import com.personal.passwordmanager.core.sync.countPending
import com.personal.passwordmanager.core.sync.findRemoteHeader
import com.personal.passwordmanager.core.sync.setupFromRemote
import com.personal.passwordmanager.core.sync.syncOnce
import com.personal.passwordmanager.core.vault.LocalStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex

enum class SyncPhase { OFF, IDLE, SYNCING, PENDING, ERROR }

data class SyncStatus(
    val enabled: Boolean = false,
    val phase: SyncPhase = SyncPhase.OFF,
    val lastSyncAt: String? = null,
    val pendingChanges: Int = 0,
    val error: String? = null,
    /** The master password was changed on another device: the new one is needed. */
    val needsNewPassword: Boolean = false,
    /** Cloud files that failed verification in the last run. They are never merged. */
    val rejected: Int = 0,
)

/**
 * Runs the sync engine inside the app process: setup from the cloud, status, and triggers
 * (after unlock, shortly after a local change, WorkManager, and the Sync now button). It needs
 * the unlocked vault key to verify cloud records, so it never runs while the vault is locked.
 */
class SyncManager(
    private val store: LocalStore,
    private val state: SyncStateStore,
    private val adapter: StorageAdapter,
    private val session: Session,
    private val prefs: Prefs,
    private val scope: CoroutineScope,
    private val onEnabledChanged: (Boolean) -> Unit = {},
) {
    private val mutex = Mutex()
    private var debounce: Job? = null
    private var rerun = false
    private var syncing = false
    private var lastError: String? = null
    private var lastRejected = 0
    private var lastHeaderStatus = HeaderStatus.UNCHANGED

    private val _status = MutableStateFlow(SyncStatus())
    val status: StateFlow<SyncStatus> = _status.asStateFlow()

    init { refresh() }

    fun refresh() {
        val enabled = prefs.syncEnabled
        val s = state.load()
        val hasVault = store.getHeader() != null
        val pending = if (hasVault) countPending(store, state) else 0
        var error = lastError
        if (lastHeaderStatus == HeaderStatus.VAULT_MISMATCH) error = SyncErrorCode.VAULT_MISMATCH.message
        val phase = when {
            !enabled -> SyncPhase.OFF
            syncing -> SyncPhase.SYNCING
            error != null -> SyncPhase.ERROR
            pending > 0 -> SyncPhase.PENDING
            else -> SyncPhase.IDLE
        }
        _status.value = SyncStatus(
            enabled = enabled, phase = phase, lastSyncAt = s.lastSyncAt, pendingChanges = pending,
            error = if (enabled) error else null, needsNewPassword = s.pendingRemoteHeader != null,
            rejected = lastRejected,
        )
    }

    /** After the user granted Google access (interactive consent done). */
    suspend fun enable() {
        prefs.syncEnabled = true
        lastError = null
        onEnabledChanged(true)
        syncNow()
    }

    fun disable() {
        debounce?.cancel()
        prefs.syncEnabled = false
        lastError = null
        lastHeaderStatus = HeaderStatus.UNCHANGED
        syncing = false
        onEnabledChanged(false)
        refresh()
    }

    /** After signing in on a device without a vault: is there one in the cloud to join? */
    suspend fun remoteVaultExists(): Boolean = findRemoteHeader(adapter) != null

    /** New-device flow: check the master password against the cloud header, then pull records. */
    suspend fun setupFromCloud(password: String): ByteArray {
        val vek = setupFromRemote(password, adapter, store, state)
        session.unlock(vek)
        prefs.syncEnabled = true
        lastError = null
        onEnabledChanged(true)
        syncNow()
        return vek
    }

    /** Applies a master password changed on another device. A wrong password changes nothing. */
    suspend fun applyNewPassword(password: String) {
        val vek = adoptPendingHeader(password, store, state)
        session.unlock(vek)
        lastHeaderStatus = HeaderStatus.UNCHANGED
        syncNow()
    }

    /** Shortly after a local change. Several quick changes become one sync. */
    fun scheduleSync(delayMs: Long = 3000) {
        if (!prefs.syncEnabled) { refresh(); return }
        debounce?.cancel()
        debounce = scope.launch {
            delay(delayMs)
            syncNow()
        }
        refresh()
    }

    fun onUnlocked() = scheduleSync(500)

    /** Runs one sync now (also used by WorkManager and the Sync now button). */
    suspend fun syncNow() {
        if (!prefs.syncEnabled) return refresh()
        if (!mutex.tryLock()) {
            rerun = true // Changes made mid-run get their own run right after.
            return
        }
        try {
            val vek = session.peekKey() ?: return refresh() // Locked: changes stay queued.
            syncing = true
            refresh()
            try {
                do {
                    rerun = false
                    val report = syncOnce(SyncDeps(store, state, adapter, vek))
                    lastRejected = report.rejected.size
                    lastHeaderStatus = report.headerStatus
                } while (rerun)
                lastError = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: StorageException) {
                lastError = e.message
            } catch (e: SyncException) {
                lastError = e.message
            } catch (_: Exception) {
                lastError = "Sync failed. Your changes are kept and will retry."
            } finally {
                vek.fill(0)
                syncing = false
            }
        } finally {
            mutex.unlock()
            refresh()
        }
    }
}
