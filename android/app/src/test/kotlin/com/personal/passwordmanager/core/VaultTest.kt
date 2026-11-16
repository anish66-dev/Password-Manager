package com.personal.passwordmanager.core

import com.personal.passwordmanager.core.crypto.KdfParams
import com.personal.passwordmanager.core.sync.conflictRecordId
import com.personal.passwordmanager.core.vault.FileLocalStore
import com.personal.passwordmanager.core.vault.InMemoryLocalStore
import com.personal.passwordmanager.core.vault.LoginInput
import com.personal.passwordmanager.core.vault.createVault
import com.personal.passwordmanager.core.vault.unlockVault
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class VaultTest {
    private val kdf = KdfParams(64, 1, 1)

    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun addEditDeleteSearch() {
        val vault = createVault("pw-one", InMemoryLocalStore(), kdf)
        val e = vault.add(LoginInput("https://a.example", "alice", "p1"))
        vault.add(LoginInput("https://b.example", "bob", "p2"))
        assertEquals(2, vault.list().size)
        assertEquals(listOf("alice"), vault.search("a.exam").entries.map { it.username })

        val updated = vault.update(e.id, LoginInput("https://a.example", "alice", "p9"))
        assertEquals(2, updated.recordVersion)
        assertEquals("p9", vault.get(e.id).password)

        vault.delete(e.id)
        assertEquals(1, vault.list().size)
        try {
            vault.get(e.id)
            fail()
        } catch (ex: VaultException) {
            assertEquals(VaultErrorCode.NOT_FOUND, ex.code)
        }
    }

    @Test
    fun wrongPasswordFailsAndChangingPasswordKeepsRecords() {
        val store = InMemoryLocalStore()
        val vault = createVault("pw-one", store, kdf)
        vault.add(LoginInput("https://a.example", "alice", "p1"))

        try {
            unlockVault("wrong", store)
            fail()
        } catch (ex: VaultException) {
            assertEquals(VaultErrorCode.BAD_PASSWORD, ex.code)
        }

        vault.changeMasterPassword("pw-one", "pw-two")
        assertEquals(2, store.getHeader()!!.headerVersion)
        assertEquals(1, unlockVault("pw-two", store).list().size)
        try {
            unlockVault("pw-one", store)
            fail()
        } catch (ex: VaultException) {
            assertEquals(VaultErrorCode.BAD_PASSWORD, ex.code)
        }
    }

    @Test
    fun neverSaveIsStoredEncrypted() {
        val store = InMemoryLocalStore()
        val vault = createVault("pw-one", store, kdf)
        vault.addNeverSave("Never.Example")
        vault.addNeverSave("never.example")
        assertEquals(setOf("never.example"), vault.readNeverSave())
        assertEquals(1, store.listRecords().size)
        assertFalse(store.listRecords().first().toJson().contains("never.example"))
    }

    @Test
    fun fileStoreRoundTripsAndHoldsNoPlaintext() {
        val dir = tmp.newFolder("vault")
        val vault = createVault("pw-one", FileLocalStore(dir), kdf)
        vault.add(LoginInput("https://secret.example", "uniqueuser", "uniquepw"))

        val everything = dir.walkTopDown().filter { it.isFile }.joinToString("\n") { it.readText() }
        for (secret in listOf("secret.example", "uniqueuser", "uniquepw", "pw-one")) {
            assertFalse(secret, everything.contains(secret))
        }
        // A new store instance (as after an app restart) sees the same vault.
        assertEquals(1, unlockVault("pw-one", FileLocalStore(dir)).list().size)
    }

    @Test
    fun appPackageLinkSurvivesEdits() {
        val vault = createVault("pw-one", InMemoryLocalStore(), kdf)
        val e = vault.add(LoginInput("https://a.example", "alice", "p1"), appPackage = "com.example.app")
        val updated = vault.update(e.id, LoginInput("https://a.example", "alice", "p2"))
        assertEquals("com.example.app", updated.appPackage)
    }

    @Test
    fun conflictIdMatchesTypeScript() {
        // Value computed with the TypeScript implementation (shared/src/sync/engine.ts).
        assertEquals(
            "a1b42fb9-f846-4f11-adb2-25aaa3bd0023",
            conflictRecordId("0f8fad5b-d9cb-469f-a165-70867728950e", "2026-01-01T00:00:01.000Z", 3)
        )
        assertTrue(true)
    }
}
