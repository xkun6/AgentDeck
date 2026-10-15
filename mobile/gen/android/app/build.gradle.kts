import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// release 签名配置在仓库外（密码不入库）：优先读环境变量 AGENTDECK_ANDROID_KEYSTORE_PROPERTIES 指定的文件，
// 否则读 ~/.agentdeck/android/keystore.properties。需要 storeFile / storePassword / keyAlias / keyPassword 四项。
// 文件不存在时 debug 构建不受影响，只有 release 的 assemble / bundle / package 任务会报错。
val keystorePropertiesFile = File(
    System.getenv("AGENTDECK_ANDROID_KEYSTORE_PROPERTIES")
        ?: (System.getProperty("user.home") + "/.agentdeck/android/keystore.properties")
)
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        keystorePropertiesFile.inputStream().use { load(it) }
    }
}

gradle.taskGraph.whenReady {
    val buildsRelease = allTasks.any { it.name.matches(Regex("(assemble|bundle|package).*Release")) }
    if (buildsRelease && !keystorePropertiesFile.exists()) {
        throw GradleException(
            "找不到 release 签名配置：${keystorePropertiesFile.absolutePath}。" +
                "请把 keystore.properties（storeFile / storePassword / keyAlias / keyPassword）放到 " +
                "~/.agentdeck/android/，或用环境变量 AGENTDECK_ANDROID_KEYSTORE_PROPERTIES 指定路径。"
        )
    }
}

android {
    compileSdk = 36
    namespace = "local.agentdeck.mobile"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "local.agentdeck.mobile"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (keystorePropertiesFile.exists()) {
            create("release") {
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            // 手机经局域网 / Tailscale 以 ws://<电脑IP> 直连电脑网关（内容已 E2EE），release 也必须放行明文；
            // 实际放行由 AndroidManifest 的 networkSecurityConfig（res/xml/network_security_config.xml）决定。
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            signingConfigs.findByName("release")?.let { signingConfig = it }
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")