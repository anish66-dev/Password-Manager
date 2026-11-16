package com.personal.passwordmanager.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.personal.passwordmanager.PasswordManagerApp
import com.personal.passwordmanager.core.StorageException
import com.personal.passwordmanager.core.SyncException
import com.personal.passwordmanager.core.VaultCryptoException
import com.personal.passwordmanager.core.VaultErrorCode
import com.personal.passwordmanager.core.VaultException
import com.personal.passwordmanager.core.crypto.KdfParams
import com.personal.passwordmanager.core.crypto.SALT_BYTES
import com.personal.passwordmanager.core.crypto.VaultCrypto
import com.personal.passwordmanager.core.vault.CapturedCredential
import com.personal.passwordmanager.core.vault.LoginEntry
import com.personal.passwordmanager.core.vault.LoginInput
import com.personal.passwordmanager.core.vault.SaveLogic
import com.personal.passwordmanager.core.vault.createVault
import com.personal.passwordmanager.core.vault.unlockVek
import com.personal.passwordmanager.sync.SyncStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class Screen { LOADING, SETUP, LOCKED, VAULT }

sealed interface Route {
    data object List : Route
    data class Edit(val id: String?) : Route
    data object Settings : Route
}

data class UiState(
    val screen: Screen = Screen.LOADING,
    val route: Route = Route.List,
    val entries: List<LoginEntry> = emptyList(),
    val query: String = "",
    val busy: Boolean = false,
    val message: String? = null,
    val error: String? = null,
    /** After Google sign-in on an empty device: a vault exists in Drive to restore. */
    val restoreAvailable: Boolean = false,
    val biometricAvailable: Boolean = false,
    val biometricEnabled: Boolean = false,
    val autoLockMinutes: Int = 10,
    val pendingSave: CapturedCredential? = null,
    val rejectedCount: Int = 0,
)

/** Screen state and actions. Heavy key derivation always runs off the main thread. */
class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val container = (app as PasswordManagerApp).container
    private val store = container.store
    private val session = container.session
    private val prefs = container.prefs

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()
    val syncStatus: StateFlow<SyncStatus> = container.sync.status

    init {
        refreshScreen()
        viewModelScope.launch {
            session.unlocked.collect { refreshScreen() }
        }
    }

    // ------------------------------------------------------------------ screen state

    private fun refreshScreen() {
        val hasVault = store.getHeader() != null
        val screen = when {
            !hasVault -> Screen.SETUP
            session.isUnlocked -> Screen.VAULT
            else -> Screen.LOCKED
        }
        _state.update {
            it.copy(
                screen = screen,
                route = if (screen == Screen.VAULT) it.route else Route.List,
                biometricAvailable = container.biometric.isAvailable(),
                biometricEnabled = container.biometric.isEnabled(),
                autoLockMinutes = prefs.autoLockMinutes,
                pendingSave = if (screen == Screen.VAULT) container.pendingSave.peek() else null,
                entries = if (screen == Screen.VAULT) it.entries else emptyList(),
                query = if (screen == Screen.VAULT) it.query else "",
            )
        }
        if (screen == Screen.VAULT) loadEntries()
        container.sync.refresh()
    }

    fun onForeground() {
        session.lockIfIdle(prefs.autoLockMinutes * 60_000L)
        refreshScreen()
    }

    fun touch() = session.touch()

    private fun loadEntries() {
        val vault = session.vault(store) ?: return
        val query = _state.value.query
        viewModelScope.launch(Dispatchers.Default) {
            val result = vault.search(query)
            _state.update { it.copy(entries = result.entries, rejectedCount = result.rejectedIds.size) }
        }
    }

    fun setQuery(query: String) {
        session.touch()
        _state.update { it.copy(query = query) }
        loadEntries()
    }

    fun navigate(route: Route) {
        session.touch()
        _state.update { it.copy(route = route, error = null, message = null) }
    }

    fun clearMessage() = _state.update { it.copy(message = null, error = null) }

    private fun fail(message: String) = _state.update { it.copy(busy = false, error = message, message = null) }

    private fun describe(e: Throwable): String = when (e) {
        is VaultException -> e.message ?: "Something went wrong."
        is VaultCryptoException -> e.message ?: "Something went wrong."
        is SyncException -> e.message ?: "Something went wrong."
        is StorageException -> e.message ?: "Something went wrong."
        else -> "Something went wrong."
    }

    // ------------------------------------------------------------------ vault lifecycle

    fun createNewVault(password: String, confirm: String) {
        if (password.length < MIN_PASSWORD) return fail("Use at least $MIN_PASSWORD characters. A long passphrase is best.")
        if (password != confirm) return fail("The passwords do not match.")
        launchBusy {
            val vault = withContext(Dispatchers.Default) { createVault(password, store, KdfParams.DEFAULT) }
            session.unlock(vault.exportSessionKey())
            _state.update { it.copy(message = "Vault created. A forgotten master password cannot be recovered.") }
            container.sync.refresh()
        }
    }

    fun unlock(password: String) {
        if (password.isEmpty()) return fail("Enter your master password.")
        launchBusy {
            val header = store.getHeader() ?: throw VaultException(VaultErrorCode.NO_VAULT)
            val vek = withContext(Dispatchers.Default) { unlockVek(password, header) }
            session.unlock(vek)
            container.sync.onUnlocked()
        }
    }

    /** Biometric unlock produced the key. */
    fun unlockWithKey(vek: ByteArray) {
        session.unlock(vek)
        container.sync.onUnlocked()
    }

    fun biometricFallback(message: String?) {
        refreshScreen()
        if (message != null) _state.update { it.copy(error = message) }
    }

    fun lock() {
        session.lock()
        refreshScreen()
    }

    private fun launchBusy(block: suspend () -> Unit) {
        _state.update { it.copy(busy = true, error = null, message = null) }
        viewModelScope.launch {
            try {
                block()
                _state.update { it.copy(busy = false) }
            } catch (e: VaultException) {
                fail(if (e.code == VaultErrorCode.BAD_PASSWORD) "Incorrect master password." else describe(e))
            } catch (e: Exception) {
                fail(describe(e))
            }
        }
    }

    // ------------------------------------------------------------------ logins

    fun save(id: String?, url: String, username: String, password: String, appPackage: String?) {
        val vault = session.vault(store) ?: return
        if (url.isBlank() && appPackage.isNullOrBlank()) return fail("Enter the website or app.")
        viewModelScope.launch(Dispatchers.Default) {
            try {
                val link = appPackage?.trim()?.takeIf { it.isNotEmpty() }
                val finalUrl = url.trim().ifEmpty { SaveLogic.appUrl(link ?: "") }
                if (id == null) vault.add(LoginInput(finalUrl, username, password), link)
                else vault.update(id, LoginInput(finalUrl, username, password), link, keepAppPackage = false)
                session.touch()
                container.sync.scheduleSync()
                _state.update { it.copy(route = Route.List, error = null) }
                loadEntries()
            } catch (e: Exception) {
                fail(describe(e))
            }
        }
    }

    fun delete(id: String) {
        val vault = session.vault(store) ?: return
        viewModelScope.launch(Dispatchers.Default) {
            try {
                vault.delete(id)
                session.touch()
                container.sync.scheduleSync()
                _state.update { it.copy(route = Route.List) }
                loadEntries()
            } catch (e: Exception) {
                fail(describe(e))
            }
        }
    }

    fun entry(id: String): LoginEntry? = _state.value.entries.firstOrNull { it.id == id }

    // ------------------------------------------------------------------ pending autofill save

    fun confirmPendingSave() {
        val vault = session.vault(store) ?: return
        val credential = container.pendingSave.peek() ?: return
        viewModelScope.launch(Dispatchers.Default) {
            if (!SaveLogic.isNeverSave(vault, credential)) SaveLogic.save(vault, credential)
            container.pendingSave.clear()
            container.sync.scheduleSync()
            _state.update { it.copy(pendingSave = null, message = "Saved.") }
            loadEntries()
        }
    }

    fun dismissPendingSave() {
        container.pendingSave.clear()
        _state.update { it.copy(pendingSave = null) }
    }

    // ------------------------------------------------------------------ settings

    fun setAutoLockMinutes(minutes: Int) {
        prefs.autoLockMinutes = minutes
        _state.update { it.copy(autoLockMinutes = prefs.autoLockMinutes) }
    }

    fun changeMasterPassword(current: String, next: String, confirm: String) {
        if (next.length < MIN_PASSWORD) return fail("Use at least $MIN_PASSWORD characters.")
        if (next != confirm) return fail("The new passwords do not match.")
        val vault = session.vault(store) ?: return
        launchBusy {
            withContext(Dispatchers.Default) { vault.changeMasterPassword(current, next) }
            container.biometric.disable() // The key chain changed; re-enable if wanted.
            container.sync.scheduleSync()
            _state.update { it.copy(message = "Master password changed. Other devices will ask for the new one.") }
            refreshScreen()
        }
    }

    /** Times the key derivation with this vault's parameters, so unlock speed can be checked on the phone. */
    fun benchmarkKdf() {
        val header = store.getHeader() ?: return
        launchBusy {
            val params = KdfParams(header.memoryKib, header.iterations, header.parallelism)
            val salt = VaultCrypto.randomBytes(SALT_BYTES)
            val millis = withContext(Dispatchers.Default) {
                val start = System.nanoTime()
                VaultCrypto.deriveMasterKey("benchmark-password", salt, params)
                (System.nanoTime() - start) / 1_000_000
            }
            _state.update {
                it.copy(message = "Unlocking takes about $millis ms (${params.memoryKib / 1024} MiB, ${params.iterations} iterations). Aim for 500 to 1000 ms.")
            }
        }
    }

    fun biometricEnabled(enabled: Boolean, message: String? = null) {
        _state.update { it.copy(biometricEnabled = enabled, message = message ?: it.message) }
    }

    fun disableBiometric() {
        container.biometric.disable()
        refreshScreen()
    }

    fun currentKeyForBiometric(): ByteArray? = session.peekKey()

    // ------------------------------------------------------------------ cloud sync

    /** The user finished Google consent. */
    fun onDriveAuthorized() {
        launchBusy {
            if (store.getHeader() != null) {
                container.sync.enable()
            } else {
                val exists = container.sync.remoteVaultExists()
                _state.update {
                    it.copy(
                        restoreAvailable = exists,
                        error = if (exists) null else "No vault was found in Google Drive.",
                    )
                }
            }
        }
    }

    fun drivePermissionFailed(message: String) = fail(message)

    fun restoreFromCloud(password: String) {
        if (password.isEmpty()) return fail("Enter your master password.")
        launchBusy {
            withContext(Dispatchers.Default) { container.sync.setupFromCloud(password) }
            _state.update { it.copy(restoreAvailable = false, message = "Restored from Google Drive.") }
        }
    }

    fun applyNewPassword(password: String) {
        if (password.isEmpty()) return fail("Enter the new master password.")
        launchBusy {
            withContext(Dispatchers.Default) { container.sync.applyNewPassword(password) }
            container.biometric.disable()
            refreshScreen()
        }
    }

    fun syncNow() {
        session.touch()
        viewModelScope.launch { container.sync.syncNow() }
    }

    fun disconnectDrive() {
        container.auth.signOutLocal()
        container.sync.disable()
    }

    fun cancelRestore() = _state.update { it.copy(restoreAvailable = false, error = null) }

    private companion object {
        const val MIN_PASSWORD = 8
    }
}
