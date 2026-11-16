package com.personal.passwordmanager.core

import com.personal.passwordmanager.core.storage.DriveAdapter
import com.personal.passwordmanager.core.storage.TokenProvider
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class DriveAdapterTest {
    private lateinit var server: MockWebServer
    private val sleeps = mutableListOf<Long>()
    private var invalidated = mutableListOf<String>()
    private var tokenCounter = 0

    private val tokens = object : TokenProvider {
        override suspend fun getToken() = "token-${++tokenCounter}"
        override suspend fun invalidate(token: String) { invalidated += token }
    }

    @Before fun setUp() { server = MockWebServer().also { it.start() } }
    @After fun tearDown() { server.shutdown() }

    private fun adapter(maxAttempts: Int = 5): DriveAdapter {
        val base = server.url("/drive/v3").toString().trimEnd('/')
        val upload = server.url("/upload/drive/v3").toString().trimEnd('/')
        return DriveAdapter(tokens, api = base, uploadApi = upload, sleep = { sleeps += it }, random = { 0.0 }, maxAttempts = maxAttempts)
    }

    private fun json(body: String, code: Int = 200) =
        MockResponse().setResponseCode(code).setBody(body)

    @Test
    fun listFollowsPaginationAndUsesAppDataFolder() = runBlocking {
        server.enqueue(json("""{"files":[{"id":"1","name":"header.json","md5Checksum":"aa"}],"nextPageToken":"next"}"""))
        server.enqueue(json("""{"files":[{"id":"2","name":"x.json","modifiedTime":"t","version":"3"}]}"""))
        val files = adapter().list()
        assertEquals(listOf("1", "2"), files.map { it.id })
        assertEquals("aa", files[0].revision)
        assertEquals("t|3", files[1].revision)

        val first = server.takeRequest()
        assertTrue(first.path!!.contains("spaces=appDataFolder"))
        assertEquals("Bearer token-1", first.getHeader("Authorization"))
        assertTrue(server.takeRequest().path!!.contains("pageToken=next"))
    }

    @Test
    fun uploadCreatesInAppDataFolderAndPatchesExistingFiles() = runBlocking {
        server.enqueue(json("""{"id":"9","name":"a.json","md5Checksum":"m1"}"""))
        server.enqueue(json("""{"id":"9","name":"a.json","md5Checksum":"m2"}"""))
        val a = adapter()
        assertEquals("m1", a.upload("a.json", """{"x":1}""").revision)
        assertEquals("m2", a.upload("a.json", """{"x":2}""", "9").revision)

        val create = server.takeRequest()
        assertEquals("POST", create.method)
        val body = create.body.readUtf8()
        assertTrue(body.contains("\"parents\":[\"appDataFolder\"]"))
        assertTrue(body.contains("""{"x":1}"""))
        val patch = server.takeRequest()
        assertEquals("PATCH", patch.method)
        assertTrue(patch.path!!.contains("/files/9"))
        assertEquals("""{"x":2}""", patch.body.readUtf8())
    }

    @Test
    fun refreshesTheTokenOnceOn401ThenReportsAuth() = runBlocking {
        server.enqueue(json("{}", 401))
        server.enqueue(json("""{"files":[]}"""))
        assertTrue(adapter().list().isEmpty())
        assertEquals(listOf("token-1"), invalidated)

        server.enqueue(json("{}", 401))
        server.enqueue(json("{}", 401))
        try {
            adapter().list()
            fail()
        } catch (e: StorageException) {
            assertEquals(StorageErrorCode.AUTH, e.code)
        }
    }

    @Test
    fun backsOffOn429And5xxThenGivesUp() = runBlocking {
        server.enqueue(json("{}", 429).setHeader("Retry-After", "2"))
        server.enqueue(json("{}", 503))
        server.enqueue(json("""{"files":[]}"""))
        assertTrue(adapter().list().isEmpty())
        assertEquals(listOf(2000L, 500L), sleeps)

        repeat(3) { server.enqueue(json("{}", 500)) }
        try {
            adapter(maxAttempts = 3).list()
            fail()
        } catch (e: StorageException) {
            assertEquals(StorageErrorCode.SERVER, e.code)
        }
    }

    @Test
    fun mapsNotFoundAndPermissionErrors() = runBlocking {
        server.enqueue(json("{}", 404))
        try {
            adapter().download("gone")
            fail()
        } catch (e: StorageException) {
            assertEquals(StorageErrorCode.NOT_FOUND, e.code)
        }
        server.enqueue(json("""{"error":{"errors":[{"reason":"insufficientPermissions"}]}}""", 403))
        try {
            adapter().list()
            fail()
        } catch (e: StorageException) {
            assertEquals(StorageErrorCode.AUTH, e.code)
        }
        server.enqueue(json("""{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}""", 403))
        server.enqueue(json("""{"files":[]}"""))
        assertTrue(adapter().list().isEmpty())
        assertFalse(sleeps.isEmpty())
    }

    @Test
    fun errorsNeverContainTokensOrContent() = runBlocking {
        server.enqueue(json("secret-body", 400))
        try {
            adapter().download("x")
            fail()
        } catch (e: StorageException) {
            assertFalse(e.message!!.contains("token"))
            assertFalse(e.message!!.contains("secret-body"))
        }
    }
}
