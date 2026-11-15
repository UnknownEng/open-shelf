plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.openshelf.library"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.openshelf.library"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
        val libraryUrl = providers.gradleProperty("openshelfUrl").orElse("http://10.0.2.2:3000").get()
        buildConfigField("String", "LIBRARY_URL", "\"$libraryUrl\"")
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildTypes {
        debug { manifestPlaceholders["allowCleartext"] = "true" }
        release { manifestPlaceholders["allowCleartext"] = "false" }
    }
}
