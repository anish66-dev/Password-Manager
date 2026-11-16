package com.personal.passwordmanager.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

const val FORMAT_VERSION = 1
const val SCHEMA_VERSION = 1

/** Shared JSON settings: unknown keys are ignored, nothing is pretty-printed. */
val VaultJson = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
    explicitNulls = true
}

private val UUID_RE = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
private val BASE64_RE = Regex("^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$")

fun isUuid(value: String): Boolean = UUID_RE.matches(value)

fun isBase64(value: String): Boolean = value.isNotEmpty() && BASE64_RE.matches(value)

@Serializable
data class WrappedVek(val nonce: String, val ciphertext: String)

/** header.json: not secret. Field names match the TypeScript side exactly. */
@Serializable
data class VaultHeader(
    @SerialName("format_version") val formatVersion: Int,
    @SerialName("header_version") val headerVersion: Int,
    val kdf: String,
    val salt: String,
    @SerialName("memory_kib") val memoryKib: Int,
    val iterations: Int,
    val parallelism: Int,
    @SerialName("wrapped_vek") val wrappedVek: WrappedVek,
) {
    fun isValid(): Boolean =
        formatVersion >= 1 && headerVersion >= 1 && kdf == "argon2id" && isBase64(salt) &&
            memoryKib >= 1 && iterations >= 1 && parallelism >= 1 &&
            isBase64(wrappedVek.nonce) && isBase64(wrappedVek.ciphertext)

    fun toJson(): String = VaultJson.encodeToString(serializer(), this)

    companion object {
        /** Parses and validates untrusted text. Null when it is not a valid header. */
        fun parse(text: String): VaultHeader? = try {
            VaultJson.decodeFromString(serializer(), text).takeIf { it.isValid() }
        } catch (_: Exception) {
            null
        }
    }
}

/** records/<record_id>.json: ciphertext only. */
@Serializable
data class RecordFile(
    @SerialName("record_id") val recordId: String,
    @SerialName("schema_version") val schemaVersion: Int,
    @SerialName("record_version") val recordVersion: Int,
    @SerialName("updated_at") val updatedAt: String,
    val nonce: String,
    val ciphertext: String,
) {
    fun isValid(): Boolean =
        isUuid(recordId) && schemaVersion >= 1 && recordVersion >= 1 &&
            isBase64(nonce) && isBase64(ciphertext)

    fun toJson(): String = VaultJson.encodeToString(serializer(), this)

    companion object {
        fun parse(text: String): RecordFile? = try {
            VaultJson.decodeFromString(serializer(), text).takeIf { it.isValid() }
        } catch (_: Exception) {
            null
        }
    }
}

/** The decrypted contents of a record. */
sealed interface RecordPayload {
    fun toJson(): String

    companion object {
        /** Strict parse of decrypted JSON. Null when the shape is wrong. */
        fun parse(text: String): RecordPayload? {
            val obj = try {
                VaultJson.parseToJsonElement(text) as? JsonObject
            } catch (_: Exception) {
                null
            } ?: return null

            fun str(key: String): String? =
                (obj[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

            return when (str("kind")) {
                "login" -> {
                    val deleted = (obj["deleted"] as? JsonPrimitive)
                        ?.takeIf { !it.isString }?.booleanOrNull
                    val conflictOf = str("conflict_of")
                    val conflictElement = obj["conflict_of"]
                    if (conflictElement != null && conflictElement !is JsonNull && conflictOf == null) {
                        return null
                    }
                    LoginPayload(
                        url = str("url") ?: return null,
                        username = str("username") ?: return null,
                        password = str("password") ?: return null,
                        createdAt = str("created_at") ?: return null,
                        modifiedAt = str("modified_at") ?: return null,
                        deleted = deleted ?: return null,
                        conflictOf = conflictOf,
                        appPackage = str("app_package"),
                    )
                }
                "never_save" -> {
                    val domains = obj["domains"] as? JsonArray ?: return null
                    val list = domains.map { e ->
                        (e as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
                    }
                    NeverSavePayload(list)
                }
                else -> null
            }
        }
    }
}

data class LoginPayload(
    val url: String,
    val username: String,
    val password: String,
    val createdAt: String,
    val modifiedAt: String,
    val deleted: Boolean,
    /** Set on a conflict copy: the record whose edit lost a sync conflict. */
    val conflictOf: String? = null,
    /**
     * Android only: package name of a native app this login is linked to. Optional; the Chrome
     * extension ignores unknown payload fields, so the format stays compatible.
     */
    val appPackage: String? = null,
) : RecordPayload {
    override fun toJson(): String = buildJsonObject {
        put("kind", "login")
        put("url", url)
        put("username", username)
        put("password", password)
        put("created_at", createdAt)
        put("modified_at", modifiedAt)
        put("deleted", deleted)
        if (conflictOf != null) put("conflict_of", conflictOf)
        if (appPackage != null) put("app_package", appPackage)
    }.toString()
}

data class NeverSavePayload(val domains: List<String>) : RecordPayload {
    override fun toJson(): String = buildJsonObject {
        put("kind", "never_save")
        put("domains", buildJsonArray { domains.forEach { add(JsonPrimitive(it)) } })
    }.toString()
}
