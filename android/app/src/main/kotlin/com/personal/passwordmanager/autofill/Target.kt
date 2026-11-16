package com.personal.passwordmanager.autofill

import com.personal.passwordmanager.core.matching.Matching
import com.personal.passwordmanager.core.vault.LoginEntry
import com.personal.passwordmanager.core.vault.SaveLogic

/** What a login form belongs to: a web page in a browser, or a native app. */
sealed interface Target {
    /** The URL stored when saving: an https origin, or "androidapp://<package>". */
    val url: String
    val display: String

    fun matches(entries: List<LoginEntry>, options: Matching.Options): List<LoginEntry>

    data class Web(val pageUrl: String, val domain: String) : Target {
        override val url get() = "https://" + pageUrl.substringAfter("://").substringBefore('/')
        override val display get() = domain
        override fun matches(entries: List<LoginEntry>, options: Matching.Options) =
            SaveLogic.matchesForPage(entries, pageUrl, options)
    }

    data class App(val packageName: String) : Target {
        override val url get() = SaveLogic.appUrl(packageName)
        override val display get() = packageName
        override fun matches(entries: List<LoginEntry>, options: Matching.Options) =
            SaveLogic.matchesForApp(entries, packageName)
    }

    companion object {
        /**
         * Web pages must be https (same registrable-domain rules as Chrome); anything the rules
         * reject, such as http pages, IP addresses and look-alikes, yields no target at all.
         */
        fun from(form: ParsedForm, options: Matching.Options): Target? {
            val pageUrl = form.pageUrl
            if (pageUrl != null) {
                val domain = Matching.pageSiteKey(pageUrl, options) ?: return null
                return Web(pageUrl, domain)
            }
            return form.packageName?.let { App(it) }
        }
    }
}
