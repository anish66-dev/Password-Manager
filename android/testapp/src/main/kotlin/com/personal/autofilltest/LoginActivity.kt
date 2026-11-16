package com.personal.autofilltest

import android.app.Activity
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/** A plain native login form. "Log in" finishes the screen, which triggers the save prompt. */
class LoginActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val user = EditText(this).apply {
            hint = "Username"
            setAutofillHints(View.AUTOFILL_HINT_USERNAME)
            inputType = InputType.TYPE_CLASS_TEXT
        }
        val pass = EditText(this).apply {
            hint = "Password"
            setAutofillHints(View.AUTOFILL_HINT_PASSWORD)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        val status = TextView(this)
        val button = Button(this).apply {
            text = "Log in"
            setOnClickListener {
                status.text = "Submitted ${user.text} / ${pass.text.length} chars"
                finish()
            }
        }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 96, 48, 48)
            addView(TextView(this@LoginActivity).apply { text = "Test app login" })
            addView(user)
            addView(pass)
            addView(button)
            addView(status)
        })
    }
}
