package com.personal.passwordmanager.core.storage

import com.personal.passwordmanager.core.StorageErrorCode
import com.personal.passwordmanager.core.StorageException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.UUID
import kotlin.math.min
import kotlin.math.pow

/** Supplies OAuth access tokens. The token only grants access to ciphertext, never to keys. */
interface TokenProvider {
    /** Throws StorageException(AUTH) when no token can be had (for example not signed in). */
    suspend fun getToken(): String

    /** Forget a token that Drive rejected, so the next call fetches a fresh one. */
    suspend fun invalidate(token: String)
}

private const val FILE_FIELDS = "id,name,md5Checksum,modifiedTime,version"
private const val BASE_DELAY_MS = 500L
private const val MAX_DELAY_MS = 30_000L

/**
 * StorageAdapter over Google Drive REST v3, restricted to the hidden appDataFolder space
 * (drive.appdata scope): the app cannot see any other Drive file. Handles pagination, token
 * refresh on 401, and backoff on 429 and 5xx. Nothing but ciphertext and the vault header is
 * ever sent, and error messages never contain tokens or file contents.
 */
class DriveAdapter(
    private val tokens: TokenProvider,
    private val client: OkHttpClient = OkHttpClient(),
    private val api: String = "https://www.googleapis.com/drive/v3",
    private val uploadApi: String = "https://www.googleapis.com/upload/drive/v3",
    private val sleep: suspend (Long) -> Unit = { delay(it) },
    private val random: () -> Double = Math::random,
    private val maxAttempts: Int = 5,
) : StorageAdapter {

    override suspend fun list(): List<RemoteFile> {
        val files = mutableListOf<RemoteFile>()
        var pageToken: String? = null
        do {
            val url = "$api/files".toHttpUrl().newBuilder()
                .addQueryParameter("spaces", "appDataFolder")
                .addQueryParameter("pageSize", "1000")
                .addQueryParameter("fields", "nextPageToken,files($FILE_FIELDS)")
                .apply { if (pageToken != null) addQueryParameter("pageToken", pageToken) }
                .build()
            val body = parseJson(call { get(url) })
            for (f in (body["files"] as? JsonArray) ?: JsonArray(emptyList())) files += toRemoteFile(f.jsonObject)
            pageToken = (body["nextPageToken"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        } while (pageToken != null)
        return files
    }

    override suspend fun download(id: String): String {
        val url = "$api/files/${encode(id)}".toHttpUrl().newBuilder().addQueryParameter("alt", "media").build()
        return call { get(url) }
    }

    override suspend fun upload(name: String, content: String, existingId: String?): RemoteFile {
        if (existingId != null) {
            val url = "$uploadApi/files/${encode(existingId)}".toHttpUrl().newBuilder()
                .addQueryParameter("uploadType", "media")
                .addQueryParameter("fields", FILE_FIELDS)
                .build()
            val body = content.toRequestBody(JSON_TYPE)
            return toRemoteFile(parseJson(call { patch(url, body) }))
        }
        val boundary = "pm-${UUID.randomUUID()}"
        val metadata = buildJsonObject {
            put("name", name)
            put("parents", buildJsonArray { add(JsonPrimitive("appDataFolder")) })
            put("mimeType", "application/json")
        }
        val text = "--$boundary\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" +
            "$metadata\r\n" +
            "--$boundary\r\nContent-Type: application/json\r\n\r\n$content\r\n" +
            "--$boundary--"
        val url = "$uploadApi/files".toHttpUrl().newBuilder()
            .addQueryParameter("uploadType", "multipart")
            .addQueryParameter("fields", FILE_FIELDS)
            .build()
        val body = text.toRequestBody("multipart/related; boundary=$boundary".toMediaType())
        return toRemoteFile(parseJson(call { post(url, body) }))
    }

    override suspend fun delete(id: String) {
        val url = "$api/files/${encode(id)}".toHttpUrl()
        call { delete(url) }
    }

    // ----------------------------------------------------------------- internals

    private fun encode(id: String) = java.net.URLEncoder.encode(id, "UTF-8").replace("+", "%20")

    private fun Request.Builder.get(url: HttpUrl) { url(url).get() }
    private fun Request.Builder.patch(url: HttpUrl, body: RequestBody) { url(url).patch(body) }
    private fun Request.Builder.post(url: HttpUrl, body: RequestBody) { url(url).post(body) }
    private fun Request.Builder.delete(url: HttpUrl) { url(url).delete() }

    private fun parseJson(text: String): JsonObject = try {
        Json.parseToJsonElement(text).jsonObject
    } catch (_: Exception) {
        throw StorageException(StorageErrorCode.SERVER)
    }

    private fun toRemoteFile(file: JsonObject): RemoteFile {
        fun s(key: String) = (file[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val id = s("id")
        val name = s("name")
        if (id == null || name == null) throw StorageException(StorageErrorCode.SERVER)
        // A checksum changes exactly when the content does. Fall back to time + version.
        val revision = s("md5Checksum") ?: "${s("modifiedTime") ?: ""}|${s("version") ?: ""}"
        return RemoteFile(id, name, revision)
    }

    private fun backoff(attempt: Int, retryAfter: String?): Long {
        val seconds = retryAfter?.toDoubleOrNull()
        if (seconds != null && seconds >= 0) return min((seconds * 1000).toLong(), MAX_DELAY_MS)
        val exp = min(MAX_DELAY_MS.toDouble(), BASE_DELAY_MS * 2.0.pow(attempt))
        return Math.round(exp * (0.5 + random() / 2))
    }

    private fun isRateLimit(body: String): Boolean = try {
        val errors = Json.parseToJsonElement(body).jsonObject["error"]?.jsonObject?.get("errors")?.jsonArray
        errors?.any { e ->
            (e.jsonObject["reason"] as? JsonPrimitive)?.content?.contains(Regex("ratelimit|quota", RegexOption.IGNORE_CASE)) == true
        } == true
    } catch (_: Exception) {
        false
    }

    /** One logical request: token, retry on 401 once, back off on 429 and 5xx, map errors. */
    private suspend fun call(build: Request.Builder.() -> Unit): String {
        var attempt = 0
        var refreshedAuth = false
        while (true) {
            val token = tokens.getToken()
            val outcome: Triple<Int, String, String?> = try {
                withContext(Dispatchers.IO) { execute(build, token) }
            } catch (_: IOException) {
                if (++attempt >= maxAttempts) throw StorageException(StorageErrorCode.NETWORK)
                sleep(backoff(attempt - 1, null))
                continue
            }
            val (status, body, retryAfter) = outcome

            if (status in 200..299) return body

            if (status == 401) {
                tokens.invalidate(token) // The cached token is bad: drop it and retry once.
                if (refreshedAuth) throw StorageException(StorageErrorCode.AUTH)
                refreshedAuth = true
                continue
            }
            if (status == 404) throw StorageException(StorageErrorCode.NOT_FOUND)

            var retryable = status == 429 || status >= 500
            if (status == 403) {
                // Drive reports quota and rate limits as 403. Anything else is a permission problem.
                if (!isRateLimit(body)) throw StorageException(StorageErrorCode.AUTH)
                retryable = true
            }
            if (!retryable) throw StorageException(StorageErrorCode.SERVER)

            if (++attempt >= maxAttempts) {
                throw StorageException(if (status >= 500) StorageErrorCode.SERVER else StorageErrorCode.RATE_LIMITED)
            }
            sleep(backoff(attempt - 1, retryAfter))
        }
    }

    private fun execute(build: Request.Builder.() -> Unit, token: String): Triple<Int, String, String?> {
        val request = Request.Builder().apply(build).header("Authorization", "Bearer $token").build()
        client.newCall(request).execute().use { res: Response ->
            return Triple(res.code, res.body?.string() ?: "", res.header("Retry-After"))
        }
    }

    private companion object {
        val JSON_TYPE = "application/json".toMediaType()
    }
}
