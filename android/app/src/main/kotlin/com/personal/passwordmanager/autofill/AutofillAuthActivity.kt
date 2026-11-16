package com.personal.passwordmanager.autofill

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.service.autofill.Dataset
import android.service.autofill.FillResponse
import android.service.autofill.SaveInfo
import android.view.WindowManager
import android.view.autofill.AutofillId
import android.view.autofill.AutofillManager
import android.view.autofill.AutofillValue
import android.widget.RemoteViews
import android.widget.Toast
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import com.personal.passwordmanager.BiometricUnlock
import com.personal.passwordmanager.BuildConfig
import com.personal.passwordmanager.PasswordManagerApp
import com.personal.passwordmanager.R
import com.personal.passwordmanager.core.VaultException
import com.personal.passwordmanager.core.matching.Matching
import com.personal.passwordmanager.core.vault.LoginEntry
import com.personal.passwordmanager.core.vault.unlockVek
import com.personal.passwordmanager.ui.PasswordField
import com.personal.passwordmanager.ui.PasswordManagerTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The authentication step of the autofill flow. The system launches it through an IntentSender
 * from the autofill dropdown. If the vault is locked the user unlocks it here (biometrics or
 * master password); only then is the list of matching logins returned to the system, and
 * nothing is filled until the user picks one from that list.
 */
class AutofillAuthActivity : FragmentActivity() {
    private val container get() = (application as PasswordManagerApp).container
    private lateinit var target: Target
    private var usernameId: AutofillId? = null
    private var passwordId: AutofillId? = null

    @Suppress("DEPRECATION")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)

        usernameId = intent.getParcelableExtra(EXTRA_USERNAME_ID)
        passwordId = intent.getParcelableExtra(EXTRA_PASSWORD_ID)
        val pageUrl = intent.getStringExtra(EXTRA_PAGE_URL)
        val domain = intent.getStringExtra(EXTRA_DOMAIN)
        val pkg = intent.getStringExtra(EXTRA_PACKAGE)
        target = when {
            pageUrl != null && domain != null -> Target.Web(pageUrl, domain)
            pkg != null -> Target.App(pkg)
            else -> return cancel()
        }

        if (container.session.isUnlocked) return deliver()

        setContent {
            PasswordManagerTheme {
                Surface(color = MaterialTheme.colorScheme.background) { UnlockContent() }
            }
        }
    }

    @Composable
    private fun UnlockContent() {
        var password by remember { mutableStateOf("") }
        var busy by remember { mutableStateOf(false) }
        var error by remember { mutableStateOf<String?>(null) }
        val biometric = container.biometric

        fun tryBiometric() {
            biometric.unlock(this, "Unlock to fill ${target.display}") { outcome ->
                when (outcome) {
                    is BiometricUnlock.Outcome.Success -> {
                        container.session.unlock(outcome.vek)
                        deliver()
                    }
                    BiometricUnlock.Outcome.Invalidated -> error = "Biometrics changed. Use your master password."
                    BiometricUnlock.Outcome.Cancelled -> Unit
                    is BiometricUnlock.Outcome.Failed -> error = outcome.message
                }
            }
        }
        LaunchedEffect(Unit) { if (biometric.isEnabled()) tryBiometric() }

        Column(
            modifier = Modifier.padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        ) {
            Text("Unlock to fill ${target.display}", style = MaterialTheme.typography.titleLarge)
            PasswordField("Master password", password, { password = it })
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(
                onClick = {
                    busy = true
                    error = null
                    val typed = password
                    password = ""
                    lifecycleScope.launch {
                        try {
                            val header = container.store.getHeader()
                            val vek = withContext(Dispatchers.Default) { unlockVek(typed, requireNotNull(header)) }
                            container.session.unlock(vek)
                            deliver()
                        } catch (e: VaultException) {
                            error = "Incorrect master password."
                            busy = false
                        } catch (_: Exception) {
                            error = "Could not unlock."
                            busy = false
                        }
                    }
                },
                enabled = !busy && password.isNotEmpty(),
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Unlock") }
            if (biometric.isEnabled()) {
                OutlinedButton(onClick = { tryBiometric() }, modifier = Modifier.fillMaxWidth()) { Text("Use biometrics") }
            }
            OutlinedButton(onClick = { cancel() }, modifier = Modifier.fillMaxWidth()) { Text("Cancel") }
            if (busy) CircularProgressIndicator()
        }
    }

    private fun cancel() {
        setResult(RESULT_CANCELED)
        finish()
    }

    /** Builds the dataset list for this form and hands it back to the system. */
    private fun deliver() {
        lifecycleScope.launch {
            val response = withContext(Dispatchers.Default) { buildResponse() }
            if (response == null) {
                Toast.makeText(this@AutofillAuthActivity, "No saved logins for ${target.display}", Toast.LENGTH_SHORT).show()
                return@launch cancel()
            }
            setResult(RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, response))
            finish()
        }
    }

    private fun buildResponse(): FillResponse? {
        val vault = container.session.vault(container.store) ?: return null
        val options = Matching.Options(allowLocalhost = BuildConfig.ALLOW_LOCALHOST_MATCH)
        val matches = target.matches(vault.list(), options).take(MAX_DATASETS)
        if (matches.isEmpty()) return null

        val builder = FillResponse.Builder()
        var added = 0
        for (entry in matches) {
            val dataset = datasetFor(entry) ?: continue
            builder.addDataset(dataset)
            added++
        }
        if (added == 0) return null
        passwordId?.let { password ->
            val save = SaveInfo.Builder(SaveInfo.SAVE_DATA_TYPE_PASSWORD, arrayOf(password))
            usernameId?.let { save.setOptionalIds(arrayOf(it)) }
            save.setFlags(SaveInfo.FLAG_SAVE_ON_ALL_VIEWS_INVISIBLE)
            builder.setSaveInfo(save.build())
        }
        return builder.build()
    }

    @Suppress("DEPRECATION")
    private fun datasetFor(entry: LoginEntry): Dataset? {
        val label = entry.username.ifEmpty { target.display }
        val presentation = RemoteViews(packageName, R.layout.autofill_item).apply {
            setTextViewText(R.id.label, label)
        }
        val builder = Dataset.Builder(presentation)
        var any = false
        usernameId?.let { builder.setValue(it, AutofillValue.forText(entry.username)); any = true }
        passwordId?.let { builder.setValue(it, AutofillValue.forText(entry.password)); any = true }
        return if (any) builder.build() else null
    }

    companion object {
        private const val EXTRA_USERNAME_ID = "usernameId"
        private const val EXTRA_PASSWORD_ID = "passwordId"
        private const val EXTRA_PAGE_URL = "pageUrl"
        private const val EXTRA_DOMAIN = "domain"
        private const val EXTRA_PACKAGE = "package"
        private const val MAX_DATASETS = 10

        fun intent(context: Context, form: ParsedForm, target: Target): Intent =
            Intent(context, AutofillAuthActivity::class.java).apply {
                putExtra(EXTRA_USERNAME_ID, form.usernameId)
                putExtra(EXTRA_PASSWORD_ID, form.passwordId)
                when (target) {
                    is Target.Web -> {
                        putExtra(EXTRA_PAGE_URL, target.pageUrl)
                        putExtra(EXTRA_DOMAIN, target.domain)
                    }
                    is Target.App -> putExtra(EXTRA_PACKAGE, target.packageName)
                }
            }
    }
}
