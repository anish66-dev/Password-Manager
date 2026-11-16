package com.personal.passwordmanager

import android.content.Context
import android.content.SharedPreferences
import com.personal.passwordmanager.core.vault.Clock
import com.personal.passwordmanager.core.vault.LocalStore
import com.personal.passwordmanager.core.vault.Vault
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Holds the unlocked vault key in process memory only. It is never written to disk, logged or
 * synced. A killed process means "locked". An inactivity timer locks it (checked on resume and
 * by a timer while the app is in the foreground).
 */
class Session(private val clock: Clock = System::currentTimeMillis) {
    @Volatile private var vek: ByteArray? = null
    @Volatile private var lastActivity = 0L
    private val _unlocked = MutableStateFlow(false)
    val unlocked: StateFlow<Boolean> = _unlocked.asStateFlow()

    val isUnlocked: Boolean get() = vek != null

    @Synchronized
    fun unlock(key: ByteArray) {
        vek?.fill(0)
        vek = key.copyOf()
        lastActivity = clock()
        _unlocked.value = true
    }

    @Synchronized
    fun lock() {
        vek?.fill(0)
        vek = null
        _unlocked.value = false
    }

    /** A copy of the key for sync, or null while locked. Sync never counts as user activity. */
    fun peekKey(): ByteArray? = vek?.copyOf()

    fun vault(store: LocalStore): Vault? = vek?.let { Vault(store, it.copyOf(), null, clock) }

    /** Call on user interaction. */
    fun touch() {
        if (vek != null) lastActivity = clock()
    }

    /** Locks when idle for longer than [timeoutMs]. Returns true when it locked. */
    fun lockIfIdle(timeoutMs: Long): Boolean {
        if (vek != null && clock() - lastActivity >= timeoutMs) {
            lock()
            return true
        }
        return false
    }
}

/** Plain app settings. Nothing secret lives here. */
class Prefs(context: Context) {
    private val sp: SharedPreferences = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var syncEnabled: Boolean
        get() = sp.getBoolean("syncEnabled", false)
        set(v) = sp.edit().putBoolean("syncEnabled", v).apply()

    var autoLockMinutes: Int
        get() = sp.getInt("autoLockMinutes", 10)
        set(v) = sp.edit().putInt("autoLockMinutes", v.coerceIn(1, 120)).apply()

    var biometricEnabled: Boolean
        get() = sp.getBoolean("biometricEnabled", false)
        set(v) = sp.edit().putBoolean("biometricEnabled", v).apply()

    /** The VEK encrypted by the Android Keystore key (iv + ciphertext, Base64). Useless alone. */
    var biometricBlob: String?
        get() = sp.getString("biometricBlob", null)
        set(v) = sp.edit().apply { if (v == null) remove("biometricBlob") else putString("biometricBlob", v) }.apply()

    var biometricIv: String?
        get() = sp.getString("biometricIv", null)
        set(v) = sp.edit().apply { if (v == null) remove("biometricIv") else putString("biometricIv", v) }.apply()
}
