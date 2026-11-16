package com.personal.passwordmanager.sync

import android.content.Context
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.Scope
import com.personal.passwordmanager.core.StorageErrorCode
import com.personal.passwordmanager.core.StorageException
import com.personal.passwordmanager.core.storage.TokenProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.tasks.await

private const val DRIVE_APPDATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata"
private const val TOKEN_TTL_MS = 45L * 60 * 1000 // Google access tokens last about an hour.

/**
 * Storage sign-in through Google's Authorization API for the drive.appdata scope only. The
 * access token only grants access to the app's own folder of ciphertext, never to vault keys,
 * and is kept in memory only. The first consent needs an Activity (see [authorize]); after it,
 * silent refreshes work in the background.
 */
class GoogleAuth(private val context: Context) : TokenProvider {
    private var cached: String? = null
    private var cachedAt = 0L

    private val request: AuthorizationRequest = AuthorizationRequest.builder()
        .setRequestedScopes(listOf(Scope(DRIVE_APPDATA_SCOPE)))
        .build()

    /** Requests authorization. The result may carry a PendingIntent the UI must launch for consent. */
    suspend fun authorize(): AuthorizationResult = try {
        Identity.getAuthorizationClient(context).authorize(request).await()
    } catch (e: CancellationException) {
        throw e
    } catch (e: ApiException) {
        throw StorageException(StorageErrorCode.AUTH)
    } catch (_: Exception) {
        throw StorageException(StorageErrorCode.NETWORK)
    }

    /** Remembers the token from a completed (possibly interactive) authorization. */
    fun accept(result: AuthorizationResult): Boolean {
        val token = result.accessToken ?: return false
        cached = token
        cachedAt = System.currentTimeMillis()
        return true
    }

    fun resultFromIntent(data: android.content.Intent?): AuthorizationResult =
        Identity.getAuthorizationClient(context).getAuthorizationResultFromIntent(data)

    override suspend fun getToken(): String {
        val token = cached
        if (token != null && System.currentTimeMillis() - cachedAt < TOKEN_TTL_MS) return token
        val result = authorize()
        // A silent call that still needs consent means the user is not signed in (anymore).
        if (result.hasResolution() || !accept(result)) throw StorageException(StorageErrorCode.AUTH)
        return cached ?: throw StorageException(StorageErrorCode.AUTH)
    }

    override suspend fun invalidate(token: String) {
        if (cached == token) cached = null
    }

    fun signOutLocal() {
        cached = null
    }
}
