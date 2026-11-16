package com.personal.passwordmanager.core.storage

import com.personal.passwordmanager.core.StorageErrorCode
import com.personal.passwordmanager.core.StorageException

/** A file in the cloud folder. */
data class RemoteFile(
    /** Provider file ID. Names are not unique in Drive, so IDs identify files. */
    val id: String,
    /** header.json or <record_id>.json */
    val name: String,
    /** Changes whenever the content changes (for example a checksum or modified time). */
    val revision: String,
)

/**
 * Everything sync needs from a storage provider. The cloud folder is flat and only ever receives
 * ciphertext, the vault header and random file names. No atomic compare-and-set is assumed.
 */
interface StorageAdapter {
    /** Lists every file in the folder, following pagination. May contain duplicate names. */
    suspend fun list(): List<RemoteFile>

    /** Returns the file's text content. */
    suspend fun download(id: String): String

    /** Creates a file, or replaces the content of [existingId] when given. */
    suspend fun upload(name: String, content: String, existingId: String? = null): RemoteFile

    suspend fun delete(id: String)
}

/**
 * In-memory fake of a cloud folder for tests. Like Drive, names are not unique: uploading
 * without an ID always creates a new file. Helpers let a test play a misbehaving provider.
 */
class FakeStorageAdapter : StorageAdapter {
    private class Stored(val id: String, var name: String, var content: String, var revision: String)

    private val files = LinkedHashMap<String, Stored>()
    private var nextId = 1
    private var nextRevision = 1
    private val failures = ArrayDeque<StorageErrorCode>()

    /** When true every call fails with a network error. */
    @Volatile var offline = false
    val uploads = mutableListOf<Pair<String, String>>()

    private fun guard() {
        if (offline) throw StorageException(StorageErrorCode.NETWORK)
        failures.removeFirstOrNull()?.let { throw StorageException(it) }
    }

    fun failNext(code: StorageErrorCode) { failures.addLast(code) }

    override suspend fun list(): List<RemoteFile> {
        guard()
        return files.values.map { RemoteFile(it.id, it.name, it.revision) }
    }

    override suspend fun download(id: String): String {
        guard()
        return (files[id] ?: throw StorageException(StorageErrorCode.NOT_FOUND)).content
    }

    override suspend fun upload(name: String, content: String, existingId: String?): RemoteFile {
        guard()
        uploads += name to content
        val file: Stored
        if (existingId != null) {
            file = files[existingId] ?: throw StorageException(StorageErrorCode.NOT_FOUND)
            file.content = content
            file.name = name
        } else {
            file = Stored("file-${nextId++}", name, content, "")
            files[file.id] = file
        }
        file.revision = "rev-${nextRevision++}"
        return RemoteFile(file.id, file.name, file.revision)
    }

    override suspend fun delete(id: String) {
        guard()
        files.remove(id) ?: throw StorageException(StorageErrorCode.NOT_FOUND)
    }

    // ----- Test helpers (play the cloud provider) -----

    private fun find(name: String) = files.values.filter { it.name == name }

    fun names(): List<String> = files.values.map { it.name }.sorted()

    fun dump(): String = files.values.joinToString("\n") { "${it.name}\n${it.content}" }

    fun tamper(name: String, change: (String) -> String) {
        val file = find(name).firstOrNull() ?: error("No file named $name")
        file.content = change(file.content)
        file.revision = "rev-${nextRevision++}"
    }

    fun snapshot(name: String): String = (find(name).firstOrNull() ?: error("No file named $name")).content

    fun restore(name: String, content: String) = tamper(name) { content }

    fun addDuplicate(name: String, content: String): RemoteFile {
        val file = Stored("file-${nextId++}", name, content, "rev-${nextRevision++}")
        files[file.id] = file
        return RemoteFile(file.id, name, file.revision)
    }

    fun remove(name: String) { find(name).forEach { files.remove(it.id) } }
}
