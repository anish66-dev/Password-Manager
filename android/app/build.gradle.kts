import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Google OAuth settings live in android/local.properties (gitignored), never in git. The
// Android OAuth client is matched by package name + signing SHA-1, so no client ID string is
// needed in the app; this flag only controls the in-app "set up Google" hint.
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.personal.passwordmanager"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.personal.passwordmanager"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField(
            "boolean", "ALLOW_LOCALHOST_MATCH",
            (localProps.getProperty("allowLocalhost") ?: "false")
        )
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.all {
            // Shared fixtures live in ../shared/test-vectors (used by the TypeScript tests too).
            it.systemProperty(
                "testVectorsDir",
                rootProject.projectDir.parentFile.resolve("shared/test-vectors").absolutePath
            )
            it.maxHeapSize = "1g"
        }
    }

    packaging {
        resources.excludes += setOf(
            "META-INF/versions/9/OSGI-INF/MANIFEST.MF",
            "META-INF/{AL2.0,LGPL2.1}"
        )
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.fragment)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.biometric)
    implementation(libs.androidx.work.runtime)
    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.coroutines.play)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.bouncycastle)
    implementation(libs.play.services.auth)

    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
}
