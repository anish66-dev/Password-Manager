package com.personal.passwordmanager

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.personal.passwordmanager.core.crypto.KEY_BYTES
import com.personal.passwordmanager.core.crypto.VaultCrypto
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Biometric unlock. After a master-password unlock the user may enable it: an Android Keystore
 * AES key that requires strong biometric authentication for every use encrypts the VEK, and
 * only that encrypted blob is stored. If the key is invalidated (for example the enrolled
 * biometrics change), biometric unlock is switched off and the master password is used.
 */
class BiometricUnlock(private val context: Context, private val prefs: Prefs) {

    sealed interface Outcome {
        data class Success(val vek: ByteArray) : Outcome
        /** The key was invalidated (biometrics changed) or is gone: fall back to the password. */
        data object Invalidated : Outcome
        data object Cancelled : Outcome
        data class Failed(val message: String) : Outcome
    }

    fun isAvailable(): Boolean =
        BiometricManager.from(context).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
            BiometricManager.BIOMETRIC_SUCCESS

    fun isEnabled(): Boolean = prefs.biometricEnabled && prefs.biometricBlob != null && prefs.biometricIv != null

    private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun generateKey(): SecretKey {
        val builder = KeyGenParameterSpec.Builder(
            KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
        } else {
            @Suppress("DEPRECATION")
            builder.setUserAuthenticationValidityDurationSeconds(-1)
        }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            .apply { init(builder.build()) }.generateKey()
    }

    private fun key(): SecretKey? = keyStore().getKey(KEY_ALIAS, null) as? SecretKey

    fun disable() {
        runCatching { keyStore().deleteEntry(KEY_ALIAS) }
        prefs.biometricEnabled = false
        prefs.biometricBlob = null
        prefs.biometricIv = null
    }

    private fun prompt(
        activity: FragmentActivity,
        cipher: Cipher,
        title: String,
        negative: String,
        onResult: (Cipher?, Outcome?) -> Unit,
    ) {
        val executor = ContextCompat.getMainExecutor(activity)
        val bp = BiometricPrompt(activity, executor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                onResult(result.cryptoObject?.cipher, null)
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                val cancelled = errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                    errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                    errorCode == BiometricPrompt.ERROR_CANCELED
                onResult(null, if (cancelled) Outcome.Cancelled else Outcome.Failed(errString.toString()))
            }
        })
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setNegativeButtonText(negative)
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setConfirmationRequired(false)
            .build()
        bp.authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }

    /** Offer after a master-password unlock: encrypts the VEK under a new biometric-gated key. */
    fun enable(activity: FragmentActivity, vek: ByteArray, onDone: (Boolean, String?) -> Unit) {
        if (!isAvailable()) return onDone(false, "No strong biometrics are enrolled on this device.")
        val cipher = try {
            runCatching { keyStore().deleteEntry(KEY_ALIAS) }
            Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, generateKey()) }
        } catch (_: Exception) {
            return onDone(false, "Biometric unlock could not be set up.")
        }
        prompt(activity, cipher, "Enable biometric unlock", "Cancel") { result, outcome ->
            if (result == null) return@prompt onDone(false, (outcome as? Outcome.Failed)?.message)
            try {
                val blob = result.doFinal(vek)
                prefs.biometricBlob = VaultCrypto.toBase64(blob)
                prefs.biometricIv = VaultCrypto.toBase64(result.iv)
                prefs.biometricEnabled = true
                onDone(true, null)
            } catch (_: Exception) {
                disable()
                onDone(false, "Biometric unlock could not be set up.")
            }
        }
    }

    /** Authenticates with the biometric prompt and returns the VEK. */
    fun unlock(activity: FragmentActivity, title: String, onOutcome: (Outcome) -> Unit) {
        val blob = prefs.biometricBlob
        val iv = prefs.biometricIv
        if (!isEnabled() || blob == null || iv == null) return onOutcome(Outcome.Invalidated)
        val cipher = try {
            val secret = key() ?: run { disable(); return onOutcome(Outcome.Invalidated) }
            Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, secret, GCMParameterSpec(128, VaultCrypto.fromBase64(iv)))
            }
        } catch (_: KeyPermanentlyInvalidatedException) {
            disable()
            return onOutcome(Outcome.Invalidated)
        } catch (_: Exception) {
            disable()
            return onOutcome(Outcome.Invalidated)
        }
        prompt(activity, cipher, title, "Use master password") { result, outcome ->
            if (result == null) return@prompt onOutcome(outcome ?: Outcome.Cancelled)
            try {
                val vek = result.doFinal(VaultCrypto.fromBase64(blob))
                if (vek.size != KEY_BYTES) throw IllegalStateException()
                onOutcome(Outcome.Success(vek))
            } catch (_: Exception) {
                disable()
                onOutcome(Outcome.Invalidated)
            }
        }
    }

    private companion object {
        const val KEY_ALIAS = "vault_vek_biometric_key"
    }
}
