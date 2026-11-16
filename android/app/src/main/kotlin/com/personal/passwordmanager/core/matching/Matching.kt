package com.personal.passwordmanager.core.matching

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Domain matching by registrable domain (Public Suffix List, private suffixes such as github.io
 * included) with the same rules as shared/src/matching: the page must be https, userinfo URLs,
 * IP addresses, unknown suffixes and look-alike (punycode) domains never match, and a saved
 * login's own scheme is ignored. shared/test-vectors/matching.json must pass here.
 */
object Matching {
    private val LOCAL_HOSTNAMES = setOf("localhost", "127.0.0.1", "[::1]", "::1")
    private val SCHEME_RE = Regex("^[a-z][a-z0-9+.-]*://", RegexOption.IGNORE_CASE)

    /** Development only: treat localhost and loopback addresses as matchable, over http too. */
    data class Options(val allowLocalhost: Boolean = false)

    private fun hostOf(url: HttpUrl) = url.host.removeSuffix(".")

    private fun siteKey(url: HttpUrl, options: Options): String? {
        if (url.username.isNotEmpty() || url.password.isNotEmpty()) return null
        val host = hostOf(url)
        if (host in LOCAL_HOSTNAMES) return if (options.allowLocalhost) host else null
        if (host.isEmpty()) return null
        // topPrivateDomain() is the registrable domain (eTLD+1); null for IPs and bare suffixes.
        return try {
            url.newBuilder().host(host).build().topPrivateDomain()
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    /**
     * The registrable domain of a page that may receive suggestions, or null when the page is
     * not eligible. Pages must use https (http only for localhost in dev mode).
     */
    fun pageSiteKey(pageUrl: String, options: Options = Options()): String? {
        val url = pageUrl.toHttpUrlOrNull() ?: return null
        val key = siteKey(url, options) ?: return null
        if (url.isHttps) return key
        return if (hostOf(url) in LOCAL_HOSTNAMES && options.allowLocalhost) key else null
    }

    /** The registrable domain a saved login belongs to. A missing scheme means https. */
    fun recordSiteKey(recordUrl: String, options: Options = Options()): String? {
        val trimmed = recordUrl.trim()
        if (trimmed.isEmpty()) return null
        val url = (if (SCHEME_RE.containsMatchIn(trimmed)) trimmed else "https://$trimmed")
            .toHttpUrlOrNull() ?: return null
        return siteKey(url, options)
    }

    /** True when a saved login may be offered on, and filled into, the given page. */
    fun matchesPage(recordUrl: String, pageUrl: String, options: Options = Options()): Boolean {
        val page = pageSiteKey(pageUrl, options) ?: return false
        return page == recordSiteKey(recordUrl, options)
    }
}
