package com.personal.passwordmanager.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.MotionEvent
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import com.personal.passwordmanager.BiometricUnlock
import com.personal.passwordmanager.PasswordManagerApp
import com.personal.passwordmanager.core.StorageException
import kotlinx.coroutines.launch

/**
 * The single UI activity. FLAG_SECURE keeps passwords out of screenshots, screen recording and
 * the recent-apps preview on every screen of the app.
 */
class MainActivity : FragmentActivity(), ActivityActions {
    private val vm: AppViewModel by viewModels()
    private val container get() = (application as PasswordManagerApp).container

    private val driveConsent = registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
        if (result.resultCode != RESULT_OK) {
            vm.drivePermissionFailed("Google Drive access was not granted.")
            return@registerForActivityResult
        }
        try {
            val authorization = container.auth.resultFromIntent(result.data)
            if (container.auth.accept(authorization)) vm.onDriveAuthorized()
            else vm.drivePermissionFailed("Google Drive access was not granted.")
        } catch (_: Exception) {
            vm.drivePermissionFailed("Google sign-in failed. Check the Google Cloud setup in the README.")
        }
    }

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* optional */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        setContent { PasswordManagerTheme { Root() } }
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    override fun onStart() {
        super.onStart()
        vm.onForeground()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        vm.onForeground()
    }

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        vm.touch()
        return super.dispatchTouchEvent(ev)
    }

    @Composable
    private fun Root() {
        val state by vm.state.collectAsStateWithLifecycle()
        val sync by vm.syncStatus.collectAsStateWithLifecycle()
        Surface(color = MaterialTheme.colorScheme.background) {
            when (state.screen) {
                Screen.LOADING -> Unit
                Screen.SETUP -> SetupScreen(state, vm, this)
                Screen.LOCKED -> LockedScreen(state, vm, this)
                Screen.VAULT -> VaultScreen(state, sync, vm, this)
            }
        }
    }

    // ----------------------------------------------------------------- ActivityActions

    override fun connectDrive() {
        lifecycleScope.launch {
            try {
                val result = container.auth.authorize()
                val pending = result.pendingIntent
                if (result.hasResolution() && pending != null) {
                    driveConsent.launch(IntentSenderRequest.Builder(pending.intentSender).build())
                } else if (container.auth.accept(result)) {
                    vm.onDriveAuthorized()
                } else {
                    vm.drivePermissionFailed("Google Drive access was not granted.")
                }
            } catch (e: StorageException) {
                vm.drivePermissionFailed(e.message ?: "Google sign-in failed.")
            }
        }
    }

    override fun biometricUnlock() {
        container.biometric.unlock(this, "Unlock vault") { outcome ->
            when (outcome) {
                is BiometricUnlock.Outcome.Success -> vm.unlockWithKey(outcome.vek)
                BiometricUnlock.Outcome.Invalidated ->
                    vm.biometricFallback("Biometrics changed. Unlock with your master password to set them up again.")
                BiometricUnlock.Outcome.Cancelled -> vm.biometricFallback(null)
                is BiometricUnlock.Outcome.Failed -> vm.biometricFallback(outcome.message)
            }
        }
    }

    override fun enableBiometric() {
        val key = vm.currentKeyForBiometric() ?: return
        container.biometric.enable(this, key) { ok, message ->
            key.fill(0)
            vm.biometricEnabled(ok, if (ok) "Biometric unlock enabled." else message)
        }
    }

    override fun openAutofillSettings() {
        try {
            startActivity(
                Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE).setData(android.net.Uri.parse("package:$packageName"))
            )
        } catch (_: Exception) {
            startActivity(Intent(Settings.ACTION_SETTINGS))
        }
    }
}

@Composable
fun PasswordManagerTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme(), content = content)
}
