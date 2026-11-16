package com.personal.passwordmanager

import android.app.Application
import com.personal.passwordmanager.core.storage.DriveAdapter
import com.personal.passwordmanager.core.sync.FileSyncStateStore
import com.personal.passwordmanager.core.vault.FileLocalStore
import com.personal.passwordmanager.sync.GoogleAuth
import com.personal.passwordmanager.sync.SyncManager
import com.personal.passwordmanager.sync.SyncWorker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import java.io.File

/** Wires the pieces together. Everything the vault stores lives in app-private files. */
class AppContainer(app: Application) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val prefs = Prefs(app)
    val session = Session()
    private val dir = File(app.filesDir, "vault")
    val store = FileLocalStore(dir)
    val syncState = FileSyncStateStore(File(dir, "sync-state.json"))
    val auth = GoogleAuth(app)
    val biometric = BiometricUnlock(app, prefs)
    val sync = SyncManager(
        store = store, state = syncState, adapter = DriveAdapter(auth), session = session,
        prefs = prefs, scope = scope, onEnabledChanged = { SyncWorker.setEnabled(app, it) },
    )
    val pendingSave = PendingSave()
}

class PasswordManagerApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        if (container.prefs.syncEnabled) SyncWorker.setEnabled(this, true)
    }
}
