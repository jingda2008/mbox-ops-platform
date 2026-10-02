plugins { id("com.android.application"); id("org.jetbrains.kotlin.android"); id("org.jetbrains.kotlin.plugin.compose") }
android {
 namespace = "com.mbox.staff"
 compileSdk = 36
 defaultConfig { applicationId = "com.mbox.staff.nativeapp"; minSdk = 26; targetSdk = 36; versionCode = providers.gradleProperty("nativeVersionCode").orElse("6").get().toInt(); versionName = providers.gradleProperty("nativeVersionName").orElse("0.4.0-rc.1").get() }
 sourceSets.getByName("test").resources.srcDir("../../shared/fixtures")
 val releaseCredentials = listOf("MBOX_ANDROID_KEYSTORE", "MBOX_ANDROID_KEYSTORE_PASSWORD", "MBOX_ANDROID_KEY_ALIAS", "MBOX_ANDROID_KEY_PASSWORD").map { providers.environmentVariable(it).orNull }
 if (releaseCredentials.any { it != null }) {
  require(releaseCredentials.all { !it.isNullOrBlank() }) { "正式签名环境变量不完整" }
  signingConfigs.create("staffRelease") {
   storeFile = file(releaseCredentials[0]!!)
   storePassword = releaseCredentials[1]
   keyAlias = releaseCredentials[2]
   keyPassword = releaseCredentials[3]
  }
  buildTypes.getByName("release").signingConfig = signingConfigs.getByName("staffRelease")
 }
 buildTypes.getByName("debug").buildConfigField("String", "UPDATE_CHANNEL", "\"preview\"")
 buildTypes.getByName("release").buildConfigField("String", "UPDATE_CHANNEL", "\"stable\"")
 defaultConfig { buildConfigField("boolean", "ALLOW_LOCAL_DEMO", "false") }
 testOptions { unitTests.isIncludeAndroidResources = true }
 buildFeatures { compose = true; buildConfig = true }
 compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }

}
dependencies {
 implementation("androidx.exifinterface:exifinterface:1.4.2")
 implementation("androidx.work:work-runtime:2.11.2")
 implementation("com.journeyapps:zxing-android-embedded:4.3.0")
 implementation("com.google.zxing:core:3.5.4")
 implementation("androidx.core:core-ktx:1.16.0")
 implementation(platform("androidx.compose:compose-bom:2025.12.01"))
 implementation("androidx.activity:activity-compose:1.12.1")
 implementation("androidx.compose.material3:material3")
 implementation("androidx.compose.material:material-icons-extended")
 implementation("androidx.compose.ui:ui-tooling-preview")
 testImplementation("junit:junit:4.13.2")
 testImplementation("org.robolectric:robolectric:4.14.1")
 testImplementation("org.json:json:20260814")
 debugImplementation("androidx.compose.ui:ui-tooling")
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
