package com.personal.passwordmanager.core

import com.personal.passwordmanager.core.crypto.KdfParams
import com.personal.passwordmanager.core.storage.FakeStorageAdapter
import com.personal.passwordmanager.core.sync.InMemorySyncStateStore
import com.personal.passwordmanager.core.sync.SyncDeps
import com.personal.passwordmanager.core.sync.countPending
import com.personal.passwordmanager.core.sync.setupFromRemote
import com.personal.passwordmanager.core.sync.syncOnce
import com.personal.passwordmanager.core.vault.InMemoryLocalStore
import com.personal.passwordmanager.core.vault.LoginInput
import com.personal.passwordmanager.core.vault.Vault
import com.personal.passwordmanager.core.vault.createVault
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/**
 * Replays shared/test-vectors/sync-scenarios.json with the Kotlin engine. The TypeScript engine
 * replays the same file, so both implementations must agree on every step.
 */
class SyncScenariosTest {
    private class Device {
        val store = InMemoryLocalStore()
        val state = InMemorySyncStateStore()
        lateinit var vault: Vault
        lateinit var vek: ByteArray
    }

    @Test
    fun allScenarios() {
        val fixture = Fixtures.load("sync-scenarios.json")
        for (scenario in fixture.arr("scenarios")) {
            try {
                runScenario(fixture, scenario)
            } catch (e: Throwable) {
                throw AssertionError("Scenario '${scenario.str("name")}': ${e.message}", e)
            }
        }
    }

    private fun runScenario(fixture: JsonElement, scenario: JsonElement) = runBlocking {
        var t = Instant.parse(fixture.str("start_time")).toEpochMilli()
        val clock = { t }
        val kdfJson = fixture.obj("kdf")
        val kdf = KdfParams(kdfJson.int("memory_kib"), kdfJson.int("iterations"), kdfJson.int("parallelism"))
        val password = fixture.str("password")
        val cloud = FakeStorageAdapter()
        val devices = HashMap<String, Device>()
        val ids = HashMap<String, String>()
        val snapshots = HashMap<String, String>()

        fun dev(step: JsonElement) = devices.getValue(step.str("device"))
        fun idOf(step: JsonElement) = ids.getValue(step.str("ref"))
        fun deps(d: Device) = SyncDeps(d.store, d.state, cloud, d.vek, clock)

        for (step in scenario.arr("steps")) {
            when (val op = step.str("op")) {
                "create" -> {
                    val d = Device()
                    d.vault = createVault(password, d.store, kdf, clock)
                    d.vek = d.vault.exportSessionKey()
                    devices[step.str("device")] = d
                }
                "join" -> {
                    val d = Device()
                    d.vek = setupFromRemote(password, cloud, d.store, d.state)
                    d.vault = Vault(d.store, d.vek, kdf, clock)
                    devices[step.str("device")] = d
                }
                "join_fails" -> {
                    val d = Device()
                    try {
                        setupFromRemote(step.str("password"), cloud, d.store, d.state)
                        throw AssertionError("join should fail")
                    } catch (e: VaultException) {
                        assertEquals(step.str("code"), e.code.name)
                    }
                    assertNull(d.store.getHeader())
                }
                "add" -> {
                    val e = dev(step).vault.add(
                        LoginInput(step.str("url"), step.str("username"), step.str("password"))
                    )
                    ids[step.str("ref")] = e.id
                }
                "edit" -> {
                    val d = dev(step)
                    val current = d.vault.get(idOf(step))
                    d.vault.update(
                        current.id,
                        LoginInput(
                            step.optStr("url") ?: current.url,
                            step.optStr("username") ?: current.username,
                            step.optStr("password") ?: current.password,
                        )
                    )
                }
                "delete" -> dev(step).vault.delete(idOf(step))
                "never_save" -> dev(step).vault.addNeverSave(step.str("domain"))
                "tick" -> t += step.jsonObject["ms"]?.jsonPrimitive?.longOrNull ?: 1000L
                "offline" -> cloud.offline = step.jsonObject.getValue("value").jsonPrimitive.content == "true"
                "sync" -> {
                    val report = syncOnce(deps(dev(step)))
                    val expect = step.jsonObject["expect"]?.jsonObject ?: continue
                    for ((key, want) in expect) {
                        val got: Any = when (key) {
                            "uploaded" -> report.uploaded
                            "downloaded" -> report.downloaded
                            "conflicts" -> report.conflicts
                            "rejected" -> report.rejected.size
                            "stale" -> report.stale.size
                            "duplicatesRemoved" -> report.duplicatesRemoved
                            "headerStatus" -> report.headerStatus.wire
                            "pending" -> report.pending
                            else -> throw AssertionError("Unknown report field $key")
                        }
                        val wantValue: Any = want.jsonPrimitive.let { p ->
                            if (p.isString) p.content else p.content.toInt()
                        }
                        assertEquals("report.$key", wantValue, got)
                    }
                }
                "sync_fails" -> {
                    try {
                        syncOnce(deps(dev(step)))
                        throw AssertionError("sync should fail")
                    } catch (e: StorageException) {
                        assertEquals(step.str("code"), e.code.name)
                    }
                }
                "tamper_record" -> cloud.tamper("${idOf(step)}.json") { content ->
                    val marker = "\"ciphertext\":\""
                    val at = content.indexOf(marker) + marker.length
                    val flipped = if (content[at] == 'A') 'B' else 'A'
                    content.substring(0, at) + flipped + content.substring(at + 1)
                }
                "snapshot_record" -> snapshots[idOf(step)] = cloud.snapshot("${idOf(step)}.json")
                "restore_record" -> cloud.restore("${idOf(step)}.json", snapshots.getValue(idOf(step)))
                "expect_logins" -> {
                    val got = dev(step).vault.list()
                        .map { "${it.username}|${it.password}|${if (it.conflictOf != null) "conflict" else ""}" }
                        .sorted()
                    val want = step.arr("logins").map { it.jsonPrimitive.content }.sorted()
                    assertEquals("logins on ${step.str("device")}", want, got)
                }
                "expect_pending" -> {
                    val d = dev(step)
                    assertEquals(step.int("count"), countPending(d.store, d.state))
                }
                "expect_cloud_file_count" -> assertEquals(step.int("count"), cloud.names().size)
                else -> throw AssertionError("Unknown op $op")
            }
        }
        assertTrue(true)
    }

    @Test
    fun onlyCiphertextLeavesTheDevice() = runBlocking {
        val cloud = FakeStorageAdapter()
        val store = InMemoryLocalStore()
        val vault = createVault("first-master-password", store, KdfParams(64, 1, 1))
        vault.add(LoginInput("https://secret.example", "uniqueuser", "uniquepw"))
        vault.addNeverSave("never.example")
        syncOnce(SyncDeps(store, InMemorySyncStateStore(), cloud, vault.exportSessionKey()))
        val everything = cloud.dump() + cloud.uploads.joinToString("") { it.second }
        for (secret in listOf("secret.example", "uniqueuser", "uniquepw", "never.example", "first-master-password")) {
            assertTrue(secret, !everything.contains(secret))
        }
        assertTrue(cloud.names().size == 3)
    }
}
