package com.personal.passwordmanager.autofill

import android.text.InputType

/** What the autofill framework tells us about one view. Plain data, so it is easy to test. */
data class NodeInfo(
    val autofillHints: List<String> = emptyList(),
    val inputType: Int = 0,
    val htmlType: String? = null,
    val htmlName: String? = null,
    val htmlId: String? = null,
    val idEntry: String? = null,
    val hint: String? = null,
    /** True for editable text widgets or HTML text inputs. */
    val isTextInput: Boolean = true,
)

enum class FieldKind { PASSWORD, NEW_PASSWORD, USERNAME, OTHER }

/** Heuristics for login forms, similar in spirit to the Chrome content script's detection. */
object FieldClassifier {
    private val USER_WORDS = Regex("user|e-?mail|login|account|identifier", RegexOption.IGNORE_CASE)
    private val PASSWORD_WORDS = Regex("pass(word|wd|code)?|pwd", RegexOption.IGNORE_CASE)

    private fun passwordInputType(inputType: Int): Boolean {
        val cls = inputType and InputType.TYPE_MASK_CLASS
        val variation = inputType and InputType.TYPE_MASK_VARIATION
        return when (cls) {
            InputType.TYPE_CLASS_TEXT ->
                variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
                    variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD ||
                    variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
            InputType.TYPE_CLASS_NUMBER -> variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD
            else -> false
        }
    }

    fun classify(node: NodeInfo): FieldKind {
        if (!node.isTextInput) return FieldKind.OTHER
        val hints = node.autofillHints.map { it.lowercase() }
        if ("newpassword" in hints) return FieldKind.NEW_PASSWORD
        if ("password" in hints) return FieldKind.PASSWORD
        if (node.htmlType.equals("password", ignoreCase = true) || passwordInputType(node.inputType)) {
            val label = listOfNotNull(node.htmlName, node.htmlId, node.idEntry, node.hint).joinToString(" ")
            return if (Regex("new|confirm|repeat|retype", RegexOption.IGNORE_CASE).containsMatchIn(label) &&
                PASSWORD_WORDS.containsMatchIn(label)
            ) FieldKind.NEW_PASSWORD else FieldKind.PASSWORD
        }
        if (hints.any { it == "username" || it == "emailaddress" }) return FieldKind.USERNAME
        if (node.htmlType.equals("email", ignoreCase = true)) return FieldKind.USERNAME
        val variation = node.inputType and InputType.TYPE_MASK_VARIATION
        if ((node.inputType and InputType.TYPE_MASK_CLASS) == InputType.TYPE_CLASS_TEXT &&
            (variation == InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS ||
                variation == InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS)
        ) return FieldKind.USERNAME
        val label = listOfNotNull(node.htmlName, node.htmlId, node.idEntry, node.hint).joinToString(" ")
        if (label.isNotEmpty() && USER_WORDS.containsMatchIn(label) && !PASSWORD_WORDS.containsMatchIn(label)) {
            return FieldKind.USERNAME
        }
        return FieldKind.OTHER
    }
}
