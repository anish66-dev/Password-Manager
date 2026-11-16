package com.personal.passwordmanager.core.vault

import com.personal.passwordmanager.core.model.RecordFile
import com.personal.passwordmanager.core.model.VaultHeader
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/** Storage for the header and the record files exactly as they exist in the cloud. */
interface LocalStore {
    fun getHeader(): VaultHeader?
    fun putHeader(header: VaultHeader)
    fun getRecord(recordId: String): RecordFile?
    fun putRecord(record: RecordFile)
    fun listRecords(): List<RecordFile>
}

class InMemoryLocalStore : LocalStore {
    @Volatile private var header: VaultHeader? = null
    private val records = ConcurrentHashMap<String, RecordFile>()

    override fun getHeader() = header
    override fun putHeader(header: VaultHeader) { this.header = header }
    override fun getRecord(recordId: String) = records[recordId]
    override fun putRecord(record: RecordFile) { records[record.recordId] = record }
    override fun listRecords(): List<RecordFile> = records.values.toList()
}

/** Writes through a temp file and an atomic rename, so a crash never leaves a half-written file. */
internal fun atomicWrite(target: File, text: String) {
    target.parentFile?.mkdirs()
    val tmp = File(target.parentFile, target.name + ".tmp")
    tmp.writeText(text, Charsets.UTF_8)
    if (!tmp.renameTo(target)) {
        // renameTo can fail to replace on some file systems; fall back to delete + rename.
        target.delete()
        if (!tmp.renameTo(target)) throw java.io.IOException("Could not write file.")
    }
}

/**
 * Ciphertext-only store in app-private storage: header.json and records/<id>.json, the same
 * JSON as the cloud. Never holds a key or plaintext.
 */
class FileLocalStore(private val dir: File) : LocalStore {
    private val headerFile get() = File(dir, "header.json")
    private val recordsDir get() = File(dir, "records")

    @Synchronized
    override fun getHeader(): VaultHeader? =
        headerFile.takeIf { it.isFile }?.let { VaultHeader.parse(it.readText(Charsets.UTF_8)) }

    @Synchronized
    override fun putHeader(header: VaultHeader) = atomicWrite(headerFile, header.toJson())

    @Synchronized
    override fun getRecord(recordId: String): RecordFile? {
        val file = File(recordsDir, "$recordId.json")
        return file.takeIf { it.isFile }?.let { RecordFile.parse(it.readText(Charsets.UTF_8)) }
    }

    @Synchronized
    override fun putRecord(record: RecordFile) {
        // The ID is validated as a UUID by isValid(), so it can never escape the directory.
        require(record.isValid()) { "Invalid record." }
        atomicWrite(File(recordsDir, "${record.recordId}.json"), record.toJson())
    }

    @Synchronized
    override fun listRecords(): List<RecordFile> =
        recordsDir.listFiles { f -> f.isFile && f.name.endsWith(".json") }
            ?.mapNotNull { RecordFile.parse(it.readText(Charsets.UTF_8)) }
            ?: emptyList()
}
