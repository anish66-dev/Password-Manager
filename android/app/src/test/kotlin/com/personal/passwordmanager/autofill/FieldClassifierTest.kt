package com.personal.passwordmanager.autofill

import android.text.InputType
import org.junit.Assert.assertEquals
import org.junit.Test

class FieldClassifierTest {
    private fun kind(n: NodeInfo) = FieldClassifier.classify(n)

    @Test
    fun passwordFields() {
        assertEquals(FieldKind.PASSWORD, kind(NodeInfo(autofillHints = listOf("password"))))
        assertEquals(FieldKind.PASSWORD, kind(NodeInfo(htmlType = "password", htmlName = "pw")))
        assertEquals(
            FieldKind.PASSWORD,
            kind(NodeInfo(inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD))
        )
        assertEquals(
            FieldKind.PASSWORD,
            kind(NodeInfo(inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD))
        )
    }

    @Test
    fun newAndConfirmPasswordsAreNotFilled() {
        assertEquals(FieldKind.NEW_PASSWORD, kind(NodeInfo(autofillHints = listOf("newPassword"))))
        assertEquals(FieldKind.NEW_PASSWORD, kind(NodeInfo(htmlType = "password", htmlName = "confirm_password")))
    }

    @Test
    fun usernameFields() {
        assertEquals(FieldKind.USERNAME, kind(NodeInfo(autofillHints = listOf("username"))))
        assertEquals(FieldKind.USERNAME, kind(NodeInfo(autofillHints = listOf("emailAddress"))))
        assertEquals(FieldKind.USERNAME, kind(NodeInfo(htmlType = "email")))
        assertEquals(
            FieldKind.USERNAME,
            kind(NodeInfo(inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS))
        )
        assertEquals(FieldKind.USERNAME, kind(NodeInfo(htmlName = "user_login")))
    }

    @Test
    fun otherFieldsAndNonInputsAreIgnored() {
        assertEquals(FieldKind.OTHER, kind(NodeInfo(htmlName = "search")))
        assertEquals(FieldKind.OTHER, kind(NodeInfo(autofillHints = listOf("password"), isTextInput = false)))
        // A field whose name mentions both is a password, not a username.
        assertEquals(FieldKind.OTHER, kind(NodeInfo(htmlName = "user_password")))
    }
}
