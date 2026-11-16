package com.personal.passwordmanager

import com.personal.passwordmanager.core.vault.CapturedCredential

/**
 * A credential captured by the autofill save flow while the vault was locked. Kept in memory
 * only, for 60 seconds, never written to storage, so the user can unlock and confirm.
 */
class PendingSave(private val clock: () -> Long = System::currentTimeMillis) {
    private var credential: CapturedCredential? = null
    private var capturedAt = 0L

    @Synchronized
    fun hold(value: CapturedCredential) {
        credential = value
        capturedAt = clock()
    }

    /** The held credential if it is still fresh, without removing it. */
    @Synchronized
    fun peek(): CapturedCredential? {
        if (credential != null && clock() - capturedAt > TTL_MS) credential = null
        return credential
    }

    @Synchronized
    fun clear() {
        credential = null
    }

    companion object {
        const val TTL_MS = 60_000L
    }
}
