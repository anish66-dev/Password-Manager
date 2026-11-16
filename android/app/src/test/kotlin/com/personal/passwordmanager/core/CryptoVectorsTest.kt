package com.personal.passwordmanager.core

import com.personal.passwordmanager.core.crypto.KdfParams
import com.personal.passwordmanager.core.crypto.RecordMeta
import com.personal.passwordmanager.core.crypto.VaultCrypto
import com.personal.passwordmanager.core.model.LoginPayload
import com.personal.passwordmanager.core.model.RecordFile
import com.personal.passwordmanager.core.model.WrappedVek
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Known-answer tests from shared/test-vectors: the Kotlin crypto must match the TypeScript one. */
class CryptoVectorsTest {
    private fun b64(s: String) = VaultCrypto.fromBase64(s)

    @Test
    fun kdfVectors() {
        val f = Fixtures.load("kdf.json")
        val salt = b64(f.str("salt_b64"))
        for (case in f.arr("cases")) {
            val params = KdfParams(case.int("memory_kib"), case.int("iterations"), case.int("parallelism"))
            val master = VaultCrypto.deriveMasterKey(case.str("password"), salt, params)
            assertEquals(case.str("description"), case.str("master_key_b64"), VaultCrypto.toBase64(master))
            assertEquals(case.str("kek_b64"), VaultCrypto.toBase64(VaultCrypto.deriveKek(master)))
        }
    }

    @Test
    fun wrapVectors() {
        val f = Fixtures.load("wrap.json")
        val kek = b64(f.str("kek_b64"))
        val vek = b64(f.str("vek_b64"))
        val format = f.int("format_version")
        val wrapped = f.obj("wrapped_vek")
        val expected = WrappedVek(wrapped.str("nonce"), wrapped.str("ciphertext"))

        assertEquals(expected, VaultCrypto.wrapVekWithNonce(kek, vek, format, b64(expected.nonce)))
        assertArrayEquals(vek, VaultCrypto.unwrapVek(kek, expected, format))

        for (bad in f.arr("must_fail")) {
            val badWrapped = bad.obj("wrapped_vek").let { WrappedVek(it.str("nonce"), it.str("ciphertext")) }
            val badKek = bad.optStr("kek_b64")?.let { b64(it) } ?: kek
            try {
                VaultCrypto.unwrapVek(badKek, badWrapped, bad.int("format_version"))
                fail("must fail: ${bad.str("reason")}")
            } catch (e: VaultCryptoException) {
                assertEquals(CryptoErrorCode.AUTH_FAILED, e.code)
            }
        }
    }

    @Test
    fun recordVectors() {
        val f = Fixtures.load("record.json")
        val vek = b64(f.str("vek_b64"))
        val file = RecordFile.parse(f.obj("record_file").toString())
        assertNotNull(file)
        assertEquals(f.str("aad_utf8"), String(VaultCrypto.recordAad(file!!.recordId, file.schemaVersion, file.recordVersion)))

        val payload = VaultCrypto.decryptRecord(vek, file) as LoginPayload
        val expected = f.obj("payload")
        assertEquals(expected.str("url"), payload.url)
        assertEquals(expected.str("username"), payload.username)
        assertEquals(expected.str("password"), payload.password)
        assertEquals(expected.str("created_at"), payload.createdAt)
        assertEquals(expected.str("modified_at"), payload.modifiedAt)
        assertFalse(payload.deleted)

        // Encrypting the same payload with the same nonce reproduces the TypeScript ciphertext.
        val again = VaultCrypto.encryptRecordWithNonce(
            vek, RecordMeta(file.recordId, file.schemaVersion, file.recordVersion, file.updatedAt),
            payload, b64(file.nonce)
        )
        assertEquals(file.ciphertext, again.ciphertext)

        for (bad in f.arr("must_fail")) {
            val badFile = RecordFile.parse(bad.obj("record_file").toString())
            assertNotNull(bad.str("reason"), badFile)
            try {
                VaultCrypto.decryptRecord(vek, badFile!!)
                fail("must fail: ${bad.str("reason")}")
            } catch (e: VaultCryptoException) {
                assertEquals(bad.str("reason"), CryptoErrorCode.AUTH_FAILED, e.code)
            }
        }
    }

    @Test
    fun noncesAreUniqueAndErrorsHaveNoSecrets() {
        val vek = VaultCrypto.generateVek()
        val nonces = HashSet<String>()
        repeat(1000) {
            val file = VaultCrypto.encryptRecord(
                vek, RecordMeta("0f8fad5b-d9cb-469f-a165-70867728950e", 1, 1, "2026-01-01T00:00:00.000Z"),
                LoginPayload("https://a.example", "u", "super-secret-pw", "x", "x", false)
            )
            assertTrue(nonces.add(file.nonce))
        }
        try {
            VaultCrypto.decryptRecord(
                VaultCrypto.generateVek(),
                VaultCrypto.encryptRecord(
                    vek, RecordMeta("0f8fad5b-d9cb-469f-a165-70867728950e", 1, 1, "t"),
                    LoginPayload("https://a.example", "u", "super-secret-pw", "x", "x", false)
                )
            )
            fail()
        } catch (e: VaultCryptoException) {
            assertFalse(e.message!!.contains("super-secret-pw"))
        }
    }
}
