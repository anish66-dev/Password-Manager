package com.personal.passwordmanager.core.vault

import com.personal.passwordmanager.core.matching.Matching

/** A credential seen by the autofill save flow. Held in memory only, never written to storage. */
data class CapturedCredential(
    /** https URL of the page, or "androidapp://<package>" for a native app. */
    val url: String,
    val username: String,
    val password: String,
    /** Set for native apps. */
    val appPackage: String? = null,
) {
    override fun toString() = "CapturedCredential(url=$url)"
}

enum class SaveOutcome { ADDED, UPDATED, UNCHANGED }

object SaveLogic {
    fun appUrl(packageName: String) = "androidapp://$packageName"

    /** True when the registrable domain was marked "never save" (for example from Chrome). */
    fun isNeverSave(vault: Vault, credential: CapturedCredential): Boolean {
        if (credential.appPackage != null) return false
        val site = Matching.recordSiteKey(credential.url) ?: return false
        return site in vault.readNeverSave()
    }

    /**
     * Same registrable domain (or same app) and the same username, ignoring case, is an update,
     * never a duplicate. An unchanged password asks and stores nothing.
     */
    fun save(vault: Vault, credential: CapturedCredential): SaveOutcome {
        val existing = vault.list().firstOrNull { entry ->
            entry.conflictOf == null &&
                entry.username.equals(credential.username, ignoreCase = true) &&
                sameTarget(entry, credential)
        }
        if (existing == null) {
            vault.add(LoginInput(credential.url, credential.username, credential.password), credential.appPackage)
            return SaveOutcome.ADDED
        }
        if (existing.password == credential.password) return SaveOutcome.UNCHANGED
        vault.update(existing.id, LoginInput(existing.url, existing.username, credential.password))
        return SaveOutcome.UPDATED
    }

    private fun sameTarget(entry: LoginEntry, credential: CapturedCredential): Boolean {
        if (credential.appPackage != null) return entry.appPackage == credential.appPackage
        val site = Matching.recordSiteKey(credential.url) ?: return false
        return Matching.recordSiteKey(entry.url) == site
    }

    /** Logins to offer for a web page (registrable-domain rules, https only). */
    fun matchesForPage(entries: List<LoginEntry>, pageUrl: String, options: Matching.Options = Matching.Options()) =
        entries.filter { Matching.matchesPage(it.url, pageUrl, options) }

    /** Logins linked to a native app by its package name. */
    fun matchesForApp(entries: List<LoginEntry>, packageName: String) =
        entries.filter { it.appPackage == packageName }
}
