package com.personal.passwordmanager.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File

/** Loads the JSON fixtures in shared/test-vectors, which the TypeScript tests also use. */
object Fixtures {
    private val dir = File(requireNotNull(System.getProperty("testVectorsDir")) { "testVectorsDir not set" })

    fun load(name: String): JsonObject =
        Json.parseToJsonElement(File(dir, name).readText(Charsets.UTF_8)).jsonObject
}

fun JsonElement.str(key: String): String = jsonObject.getValue(key).jsonPrimitive.content
fun JsonElement.int(key: String): Int = jsonObject.getValue(key).jsonPrimitive.int
fun JsonElement.obj(key: String): JsonObject = jsonObject.getValue(key).jsonObject
fun JsonElement.arr(key: String): JsonArray = jsonObject.getValue(key).jsonArray
fun JsonElement.optStr(key: String): String? = (jsonObject[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
