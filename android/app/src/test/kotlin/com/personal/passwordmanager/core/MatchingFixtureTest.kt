package com.personal.passwordmanager.core

import com.personal.passwordmanager.core.matching.Matching
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MatchingFixtureTest {
    @Test
    fun sharedRows() {
        val rows = Fixtures.load("matching.json").arr("rows")
        assertTrue(rows.size > 30)
        val failures = rows.mapNotNull { row ->
            val expected = row.jsonObject.getValue("expected").jsonPrimitive.boolean
            val actual = Matching.matchesPage(row.str("record"), row.str("page"))
            if (actual != expected) "${row.str("description")}: expected $expected" else null
        }
        assertEquals(emptyList<String>(), failures)
    }

    @Test
    fun localhostOnlyWithTheFlag() {
        assertFalse(Matching.matchesPage("http://localhost:3000", "http://localhost:3000/login"))
        val dev = Matching.Options(allowLocalhost = true)
        assertTrue(Matching.matchesPage("http://localhost:3000", "http://localhost:5173/login", dev))
        assertFalse(Matching.matchesPage("https://example.com", "http://localhost/", dev))
        assertFalse(Matching.matchesPage("http://localhost", "http://localhost.evil.com/", dev))
    }
}
