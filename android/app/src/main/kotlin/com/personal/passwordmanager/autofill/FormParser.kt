package com.personal.passwordmanager.autofill

import android.app.assist.AssistStructure
import android.view.View
import android.view.autofill.AutofillId

/** A login form found in an AssistStructure. Never holds secrets unless parsed for saving. */
data class ParsedForm(
    val usernameId: AutofillId?,
    val passwordId: AutofillId?,
    val webDomain: String?,
    val webScheme: String?,
    val packageName: String?,
    /** Text currently in the fields (only read for the save flow). */
    val usernameValue: String? = null,
    val passwordValue: String? = null,
    /** The form's password field is a new/confirm password (registration or change). */
    val isNewPassword: Boolean = false,
) {
    /** https URL of the web page the browser reports, or null for a native app. */
    val pageUrl: String? get() = webDomain?.let { "${webScheme ?: "https"}://$it" }
}

/**
 * Finds the login fields in the structure the system sends to the autofill service. Hidden,
 * zero-size and non-editable views are ignored, like the Chrome content script does.
 */
object FormParser {
    private class Found(val kind: FieldKind, val node: AssistStructure.ViewNode)

    fun parse(structure: AssistStructure, readValues: Boolean): ParsedForm? {
        val found = mutableListOf<Found>()
        val editable = mutableListOf<AssistStructure.ViewNode>()
        var webDomain: String? = null
        var webScheme: String? = null
        val activityPackage = structure.activityComponent?.packageName

        fun visit(node: AssistStructure.ViewNode) {
            if (webDomain == null && !node.webDomain.isNullOrEmpty()) {
                webDomain = node.webDomain
                webScheme = node.webScheme
            }
            val visible = node.visibility == View.VISIBLE && node.width > 0 && node.height > 0
            if (visible && node.autofillId != null) {
                val info = infoOf(node)
                if (info.isTextInput) {
                    editable += node
                    val kind = FieldClassifier.classify(info)
                    if (kind != FieldKind.OTHER) found += Found(kind, node)
                }
            }
            for (i in 0 until node.childCount) visit(node.getChildAt(i))
        }
        for (i in 0 until structure.windowNodeCount) visit(structure.getWindowNodeAt(i).rootViewNode)

        val password = found.firstOrNull { it.kind == FieldKind.PASSWORD }
            ?: found.firstOrNull { it.kind == FieldKind.NEW_PASSWORD }
        val username = found.lastOrNull { it.kind == FieldKind.USERNAME && precedes(it.node, password?.node, editable) }
            ?: found.firstOrNull { it.kind == FieldKind.USERNAME }
            // Fall back to the editable field right before the password field.
            ?: password?.let { p ->
                val index = editable.indexOf(p.node)
                if (index > 0) Found(FieldKind.USERNAME, editable[index - 1]) else null
            }

        if (password == null && username == null) return null
        return ParsedForm(
            usernameId = username?.node?.autofillId,
            passwordId = password?.node?.autofillId,
            webDomain = webDomain,
            webScheme = webScheme,
            packageName = activityPackage,
            usernameValue = if (readValues) username?.node?.autofillValue?.takeIf { it.isText }?.textValue?.toString() else null,
            passwordValue = if (readValues) password?.node?.autofillValue?.takeIf { it.isText }?.textValue?.toString() else null,
            isNewPassword = password?.kind == FieldKind.NEW_PASSWORD,
        )
    }

    private fun precedes(a: AssistStructure.ViewNode, b: AssistStructure.ViewNode?, order: List<AssistStructure.ViewNode>): Boolean {
        if (b == null) return true
        val ia = order.indexOf(a)
        val ib = order.indexOf(b)
        return ia in 0 until ib
    }

    private fun infoOf(node: AssistStructure.ViewNode): NodeInfo {
        val html = node.htmlInfo
        val attrs = html?.attributes?.associate { it.first to it.second } ?: emptyMap()
        val isHtmlInput = html?.tag.equals("input", ignoreCase = true) || html?.tag.equals("textarea", ignoreCase = true)
        val className = node.className ?: ""
        val isEditText = className.contains("EditText") || className.contains("TextInput") || className.contains("AutoCompleteTextView")
        return NodeInfo(
            autofillHints = node.autofillHints?.toList() ?: emptyList(),
            inputType = node.inputType,
            htmlType = attrs["type"],
            htmlName = attrs["name"],
            htmlId = attrs["id"],
            idEntry = node.idEntry,
            hint = node.hint,
            isTextInput = isHtmlInput || isEditText || node.autofillType == View.AUTOFILL_TYPE_TEXT,
        )
    }
}
