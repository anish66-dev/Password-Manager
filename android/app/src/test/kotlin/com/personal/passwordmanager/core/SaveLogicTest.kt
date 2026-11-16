package com.personal.passwordmanager.core

import com.personal.passwordmanager.core.crypto.KdfParams
import com.personal.passwordmanager.core.vault.CapturedCredential
import com.personal.passwordmanager.core.vault.InMemoryLocalStore
import com.personal.passwordmanager.core.vault.SaveLogic
import com.personal.passwordmanager.core.vault.SaveOutcome
import com.personal.passwordmanager.core.vault.createVault
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SaveLogicTest {
    private fun vault() = createVault("pw", InMemoryLocalStore(), KdfParams(64, 1, 1))

    @Test
    fun sameDomainAndUsernameIsAnUpdateNeverADuplicate() {
        val v = vault()
        val first = CapturedCredential("https://accounts.example.com", "Alice", "p1")
        assertEquals(SaveOutcome.ADDED, SaveLogic.save(v, first))
        assertEquals(SaveOutcome.UNCHANGED, SaveLogic.save(v, first))
        assertEquals(
            SaveOutcome.UPDATED,
            SaveLogic.save(v, CapturedCredential("https://www.example.com/login", "alice", "p2"))
        )
        assertEquals(1, v.list().size)
        assertEquals("p2", v.list().first().password)
        assertEquals(
            SaveOutcome.ADDED,
            SaveLogic.save(v, CapturedCredential("https://example.com", "bob", "p3"))
        )
        assertEquals(2, v.list().size)
    }

    @Test
    fun nativeAppsMatchByPackageOnly() {
        val v = vault()
        val app = CapturedCredential(SaveLogic.appUrl("com.bank.app"), "carol", "p1", "com.bank.app")
        assertEquals(SaveOutcome.ADDED, SaveLogic.save(v, app))
        assertEquals(SaveOutcome.UPDATED, SaveLogic.save(v, app.copy(password = "p2")))
        assertEquals(1, v.list().size)
        val entries = v.list()
        assertEquals(1, SaveLogic.matchesForApp(entries, "com.bank.app").size)
        assertTrue(SaveLogic.matchesForApp(entries, "com.evil.app").isEmpty())
        // An app login never matches a web page.
        assertTrue(SaveLogic.matchesForPage(entries, "https://bank.com/").isEmpty())
    }

    @Test
    fun webMatchesRespectLookalikes() {
        val v = vault()
        SaveLogic.save(v, CapturedCredential("https://example.com", "alice", "p1"))
        val entries = v.list()
        assertEquals(1, SaveLogic.matchesForPage(entries, "https://login.example.com/").size)
        assertTrue(SaveLogic.matchesForPage(entries, "https://example.com.evil.com/").isEmpty())
        assertTrue(SaveLogic.matchesForPage(entries, "http://example.com/").isEmpty())
    }

    @Test
    fun neverSaveFromAnotherDeviceIsHonoured() {
        val v = vault()
        v.addNeverSave("example.com")
        assertTrue(SaveLogic.isNeverSave(v, CapturedCredential("https://www.example.com", "a", "b")))
        assertFalse(SaveLogic.isNeverSave(v, CapturedCredential("https://other.com", "a", "b")))
    }
}
