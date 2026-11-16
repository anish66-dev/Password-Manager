package com.personal.passwordmanager.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.personal.passwordmanager.core.vault.LoginEntry
import com.personal.passwordmanager.sync.SyncPhase
import com.personal.passwordmanager.sync.SyncStatus

/** Callbacks into the Activity for things that need one (consent screens, biometrics). */
interface ActivityActions {
    fun connectDrive()
    fun biometricUnlock()
    fun enableBiometric()
    fun openAutofillSettings()
}

@Composable
fun PasswordField(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    startVisible: Boolean = false,
    allowToggle: Boolean = true,
) {
    var visible by rememberSaveable { mutableStateOf(startVisible) }
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        singleLine = true,
        visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        trailingIcon = {
            if (allowToggle) TextButton(onClick = { visible = !visible }) { Text(if (visible) "Hide" else "Show") }
        },
        modifier = modifier.fillMaxWidth(),
    )
}

@Composable
private fun Banner(error: String?, message: String?) {
    if (error != null) Text(error, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(vertical = 8.dp))
    if (message != null) Text(message, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(vertical = 8.dp))
}

@Composable
fun CenteredColumn(content: @Composable () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) { content() }
}

// ----------------------------------------------------------------------- setup

@Composable
fun SetupScreen(state: UiState, vm: AppViewModel, actions: ActivityActions) {
    var password by rememberSaveable { mutableStateOf("") }
    var confirm by rememberSaveable { mutableStateOf("") }
    var restorePassword by rememberSaveable { mutableStateOf("") }

    CenteredColumn {
        Text("Personal Password Manager", style = MaterialTheme.typography.headlineSmall)
        if (state.restoreAvailable) {
            Text("A vault was found in your Google Drive. Enter its master password to restore it on this phone.")
            PasswordField("Master password", restorePassword, { restorePassword = it })
            Banner(state.error, state.message)
            Button(onClick = { vm.restoreFromCloud(restorePassword) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
                Text("Restore from Google Drive")
            }
            TextButton(onClick = { vm.cancelRestore() }) { Text("Cancel") }
        } else {
            Text("Create a vault on this phone. Choose a long passphrase: if you forget it, nothing can recover your vault.")
            PasswordField("Master password", password, { password = it })
            PasswordField("Confirm master password", confirm, { confirm = it })
            Banner(state.error, state.message)
            Button(onClick = { vm.createNewVault(password, confirm) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
                Text("Create vault")
            }
            HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
            Text("Already have a vault on another device?")
            OutlinedButton(onClick = { actions.connectDrive() }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
                Text("Restore from Google Drive")
            }
        }
        if (state.busy) CircularProgressIndicator()
    }
}

// ----------------------------------------------------------------------- locked

@Composable
fun LockedScreen(state: UiState, vm: AppViewModel, actions: ActivityActions) {
    var password by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(state.biometricEnabled) {
        if (state.biometricEnabled) actions.biometricUnlock()
    }
    CenteredColumn {
        Text("Vault locked", style = MaterialTheme.typography.headlineSmall)
        PasswordField("Master password", password, { password = it })
        Banner(state.error, state.message)
        Button(onClick = { vm.unlock(password); password = "" }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
            Text("Unlock")
        }
        if (state.biometricEnabled) {
            OutlinedButton(onClick = { actions.biometricUnlock() }, modifier = Modifier.fillMaxWidth()) {
                Text("Use biometrics")
            }
        }
        if (state.busy) CircularProgressIndicator()
    }
}

// ----------------------------------------------------------------------- vault

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VaultScreen(state: UiState, sync: SyncStatus, vm: AppViewModel, actions: ActivityActions) {
    when (val route = state.route) {
        Route.List -> ListScreen(state, sync, vm)
        is Route.Edit -> EditScreen(state, route.id?.let { vm.entry(it) }, vm)
        Route.Settings -> SettingsScreen(state, sync, vm, actions)
    }
    val pending = state.pendingSave
    if (pending != null) {
        AlertDialog(
            onDismissRequest = { vm.dismissPendingSave() },
            title = { Text("Save this login?") },
            text = { Text("${pending.username} on ${pending.url.removePrefix("androidapp://")}") },
            confirmButton = { TextButton(onClick = { vm.confirmPendingSave() }) { Text("Save") } },
            dismissButton = { TextButton(onClick = { vm.dismissPendingSave() }) { Text("Not now") } },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ListScreen(state: UiState, sync: SyncStatus, vm: AppViewModel) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Logins") },
                actions = {
                    TextButton(onClick = { vm.navigate(Route.Settings) }) { Text("Settings") }
                    TextButton(onClick = { vm.lock() }) { Text("Lock") }
                },
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { vm.navigate(Route.Edit(null)) }) { Text("+") }
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).padding(horizontal = 16.dp)) {
            SyncBar(sync, vm)
            if (sync.needsNewPassword) NewPasswordPrompt(state, vm)
            OutlinedTextField(
                value = state.query, onValueChange = vm::setQuery, label = { Text("Search") },
                singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            Banner(state.error, state.message)
            if (state.rejectedCount > 0 || sync.rejected > 0) {
                Text(
                    "Some files failed verification and were not used.",
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            if (state.entries.isEmpty()) {
                Text(
                    if (state.query.isEmpty()) "No logins yet. Tap + to add one." else "No matches.",
                    modifier = Modifier.padding(top = 24.dp),
                )
            }
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                items(state.entries, key = { it.id }) { entry -> EntryRow(entry) { vm.navigate(Route.Edit(entry.id)) } }
            }
        }
    }
}

@Composable
private fun EntryRow(entry: LoginEntry, onClick: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Column(modifier = Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(entry.url.removePrefix("androidapp://").removePrefix("https://"), style = MaterialTheme.typography.titleMedium)
                if (entry.conflictOf != null) {
                    Spacer(Modifier.padding(horizontal = 4.dp))
                    Text("conflict copy", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall)
                }
            }
            Text(entry.username, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun SyncBar(sync: SyncStatus, vm: AppViewModel) {
    if (!sync.enabled) return
    val text = when (sync.phase) {
        SyncPhase.SYNCING -> "Syncing…"
        SyncPhase.ERROR -> sync.error ?: "Sync error"
        SyncPhase.PENDING -> "${sync.pendingChanges} change(s) waiting to sync"
        else -> "Synced" + (sync.lastSyncAt?.let { " · $it" } ?: "")
    }
    Surface(
        tonalElevation = 2.dp,
        color = if (sync.phase == SyncPhase.ERROR) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
    ) {
        Row(modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(text, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
            TextButton(onClick = { vm.syncNow() }, enabled = sync.phase != SyncPhase.SYNCING) { Text("Sync now") }
        }
    }
}

@Composable
private fun NewPasswordPrompt(state: UiState, vm: AppViewModel) {
    var password by rememberSaveable { mutableStateOf("") }
    Card(modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("The master password was changed on another device. Enter the new one to keep syncing.")
            PasswordField("New master password", password, { password = it })
            Button(onClick = { vm.applyNewPassword(password); password = "" }, enabled = !state.busy) { Text("Apply") }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EditScreen(state: UiState, entry: LoginEntry?, vm: AppViewModel) {
    var url by rememberSaveable(entry?.id) { mutableStateOf(entry?.url?.takeUnless { it.startsWith("androidapp://") } ?: "") }
    var username by rememberSaveable(entry?.id) { mutableStateOf(entry?.username ?: "") }
    var password by rememberSaveable(entry?.id) { mutableStateOf(entry?.password ?: "") }
    var appPackage by rememberSaveable(entry?.id) { mutableStateOf(entry?.appPackage ?: "") }
    var confirmDelete by remember { mutableStateOf(false) }

    Scaffold(topBar = {
        TopAppBar(
            title = { Text(if (entry == null) "Add login" else "Edit login") },
            navigationIcon = { TextButton(onClick = { vm.navigate(Route.List) }) { Text("Back") } },
        )
    }) { padding ->
        Column(
            modifier = Modifier.padding(padding).padding(16.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedTextField(url, { url = it }, label = { Text("Website (https://…)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(username, { username = it }, label = { Text("Username or email") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            PasswordField("Password", password, { password = it })
            OutlinedTextField(
                appPackage, { appPackage = it }, label = { Text("Linked app package (optional)") },
                supportingText = { Text("For native apps, for example com.example.bank. Fill only offers this login to that exact app.") },
                singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            Banner(state.error, null)
            Button(onClick = { vm.save(entry?.id, url, username, password, appPackage) }, modifier = Modifier.fillMaxWidth()) { Text("Save") }
            if (entry != null) {
                OutlinedButton(onClick = { confirmDelete = true }, modifier = Modifier.fillMaxWidth()) { Text("Delete") }
            }
        }
    }
    if (confirmDelete && entry != null) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete this login?") },
            text = { Text("It is removed on all your devices after sync.") },
            confirmButton = { TextButton(onClick = { confirmDelete = false; vm.delete(entry.id) }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
        )
    }
}

// ----------------------------------------------------------------------- settings

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsScreen(state: UiState, sync: SyncStatus, vm: AppViewModel, actions: ActivityActions) {
    var current by rememberSaveable { mutableStateOf("") }
    var next by rememberSaveable { mutableStateOf("") }
    var confirm by rememberSaveable { mutableStateOf("") }

    Scaffold(topBar = {
        TopAppBar(
            title = { Text("Settings") },
            navigationIcon = { TextButton(onClick = { vm.navigate(Route.List) }) { Text("Back") } },
        )
    }) { padding ->
        Column(
            modifier = Modifier.padding(padding).padding(16.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Banner(state.error, state.message)

            Text("Autofill", style = MaterialTheme.typography.titleMedium)
            Text("Choose this app as your autofill service so it can fill logins in browsers and apps.")
            FilledTonalButton(onClick = { actions.openAutofillSettings() }) { Text("Open autofill settings") }

            HorizontalDivider()
            Text("Google Drive sync", style = MaterialTheme.typography.titleMedium)
            if (sync.enabled) {
                Text("Connected. Only encrypted files are stored, in this app's hidden Drive folder.")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { vm.syncNow() }, enabled = sync.phase != SyncPhase.SYNCING) { Text("Sync now") }
                    OutlinedButton(onClick = { vm.disconnectDrive() }) { Text("Disconnect") }
                }
            } else {
                Text("Not connected.")
                Button(onClick = { actions.connectDrive() }, enabled = !state.busy) { Text("Connect Google Drive") }
            }

            HorizontalDivider()
            Text("Unlock", style = MaterialTheme.typography.titleMedium)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("Biometric unlock")
                    if (!state.biometricAvailable) Text("Needs an enrolled fingerprint or face.", style = MaterialTheme.typography.bodySmall)
                }
                Switch(
                    checked = state.biometricEnabled,
                    enabled = state.biometricAvailable,
                    onCheckedChange = { if (it) actions.enableBiometric() else vm.disableBiometric() },
                )
            }
            OutlinedButton(onClick = { vm.benchmarkKdf() }, enabled = !state.busy) { Text("Measure unlock speed") }
            Text("Auto-lock after ${state.autoLockMinutes} min of inactivity")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(1, 5, 10, 30).forEach { m ->
                    FilledTonalButton(onClick = { vm.setAutoLockMinutes(m) }) { Text("$m") }
                }
            }

            HorizontalDivider()
            Text("Change master password", style = MaterialTheme.typography.titleMedium)
            PasswordField("Current password", current, { current = it })
            PasswordField("New password", next, { next = it })
            PasswordField("Confirm new password", confirm, { confirm = it })
            Button(
                onClick = { vm.changeMasterPassword(current, next, confirm); current = ""; next = ""; confirm = "" },
                enabled = !state.busy,
            ) { Text("Change password") }
            if (state.busy) CircularProgressIndicator()
            Spacer(Modifier.height(24.dp))
        }
    }
}
