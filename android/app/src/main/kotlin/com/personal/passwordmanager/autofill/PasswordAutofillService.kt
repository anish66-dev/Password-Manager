package com.personal.passwordmanager.autofill

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.CancellationSignal
import android.service.autofill.AutofillService
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.FillResponse
import android.service.autofill.SaveCallback
import android.service.autofill.SaveInfo
import android.service.autofill.SaveRequest
import android.view.autofill.AutofillId
import android.widget.RemoteViews
import androidx.core.app.NotificationCompat
import com.personal.passwordmanager.BuildConfig
import com.personal.passwordmanager.PasswordManagerApp
import com.personal.passwordmanager.R
import com.personal.passwordmanager.core.matching.Matching
import com.personal.passwordmanager.core.vault.CapturedCredential
import com.personal.passwordmanager.core.vault.SaveLogic
import com.personal.passwordmanager.ui.MainActivity

/**
 * Android Autofill Framework integration. Safety rules (same spirit as the Chrome extension):
 *  - The page must be https (the browser reports the scheme); look-alike domains never match.
 *  - No credential leaves this app until the user authenticates through [AutofillAuthActivity]
 *    (biometrics or master password), and fill happens only after the user picks a dataset.
 *  - Native apps only get logins the user linked to that exact package name.
 */
class PasswordAutofillService : AutofillService() {
    private val container get() = (application as PasswordManagerApp).container
    private val matchOptions get() = Matching.Options(allowLocalhost = BuildConfig.ALLOW_LOCALHOST_MATCH)

    override fun onFillRequest(request: FillRequest, cancellationSignal: CancellationSignal, callback: FillCallback) {
        val structure = request.fillContexts.lastOrNull()?.structure
        val form = structure?.let { FormParser.parse(it, readValues = false) }
        if (form == null || form.packageName == packageName || form.isNewPassword && form.usernameId == null) {
            return callback.onSuccess(null)
        }
        val target = Target.from(form, matchOptions) ?: return callback.onSuccess(null)

        val ids = listOfNotNull(form.usernameId, form.passwordId).toTypedArray()
        val builder = FillResponse.Builder()

        val session = container.session
        val matches = if (session.isUnlocked) {
            session.vault(container.store)?.let { target.matches(it.list(), matchOptions) }
        } else null
        val offerFill = !form.isNewPassword && (matches == null || matches.isNotEmpty())
        saveInfo(form)?.let { builder.setSaveInfo(it) }
        if (!offerFill) {
            // Nothing to fill (unlocked with no match, or a registration form): only offer to save.
            return if (form.passwordId != null) callback.onSuccess(builder.build()) else callback.onSuccess(null)
        }

        val auth = AutofillAuthActivity.intent(this, form, target)
        val sender = PendingIntent.getActivity(
            this, nextRequestCode(), auth, PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_MUTABLE
        ).intentSender
        val label = if (session.isUnlocked) "Fill from Password Manager" else "Unlock Password Manager"
        val presentation = RemoteViews(packageName, R.layout.autofill_item).apply {
            setTextViewText(R.id.label, label)
        }
        builder.setAuthentication(ids, sender, presentation)
        callback.onSuccess(builder.build())
    }

    private fun saveInfo(form: ParsedForm): SaveInfo? {
        val password = form.passwordId ?: return null
        val builder = SaveInfo.Builder(SaveInfo.SAVE_DATA_TYPE_PASSWORD, arrayOf<AutofillId>(password))
        form.usernameId?.let { builder.setOptionalIds(arrayOf(it)) }
        builder.setFlags(SaveInfo.FLAG_SAVE_ON_ALL_VIEWS_INVISIBLE)
        return builder.build()
    }

    override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
        val structure = request.fillContexts.lastOrNull()?.structure
        val form = structure?.let { FormParser.parse(it, readValues = true) }
        val password = form?.passwordValue
        if (form == null || form.packageName == packageName || password.isNullOrEmpty()) {
            return callback.onSuccess()
        }
        val target = Target.from(form, matchOptions) ?: return callback.onSuccess()
        val credential = CapturedCredential(
            url = target.url, username = form.usernameValue.orEmpty(), password = password,
            appPackage = (target as? Target.App)?.packageName,
        )

        val vault = container.session.vault(container.store)
        if (vault == null) {
            // Locked: keep it in memory for 60 seconds and ask the user to unlock and confirm.
            container.pendingSave.hold(credential)
            notifyUnlockToSave(credential)
        } else if (!SaveLogic.isNeverSave(vault, credential)) {
            SaveLogic.save(vault, credential)
            container.sync.scheduleSync()
        }
        callback.onSuccess()
    }

    private fun notifyUnlockToSave(credential: CapturedCredential) {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Save prompts", NotificationManager.IMPORTANCE_DEFAULT)
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val site = credential.url.removePrefix("androidapp://").removePrefix("https://").substringBefore('/')
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentTitle("Unlock to save this login")
            .setContentText(site)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setTimeoutAfter(60_000)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .build()
        runCatching { manager.notify(NOTIFICATION_ID, notification) } // Permission may be denied.
    }

    private companion object {
        const val CHANNEL = "save_prompts"
        const val NOTIFICATION_ID = 41
        private var counter = 0
        fun nextRequestCode(): Int = ++counter
    }
}
