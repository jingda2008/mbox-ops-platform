plugins { id("com.android.application"); id("org.jetbrains.kotlin.android"); id("org.jetbrains.kotlin.plugin.compose") }
// SDK payload is opt-in at build time; absent configuration produces no provider runtime.
val getuiSdk = providers.gradleProperty("getuiSdk").orElse("false").get().toBooleanStrict()
val getuiAppId = providers.environmentVariable("MBOX_GETUI_APP_ID").orElse("").get()
require(getuiAppId.isEmpty() || Regex("[A-Za-z0-9_-]{8,128}").matches(getuiAppId)) { "个推 App ID 格式无效" }
require(getuiSdk || getuiAppId.isEmpty()) { "配置 App ID 时须明确启用 getuiSdk" }
val getuiConfigured = getuiSdk && getuiAppId.isNotEmpty()
android {
 namespace = "com.mbox.staff"
 compileSdk = 36
 defaultConfig { applicationId = "com.mbox.staff.nativeapp"; minSdk = 26; targetSdk = 36; versionCode = providers.gradleProperty("nativeVersionCode").orElse("12").get().toInt(); versionName = providers.gradleProperty("nativeVersionName").orElse("0.4.0-rc.7").get() }
 sourceSets.getByName("main").java.srcDir(if (getuiSdk) "src/getui/java" else "src/noGetui/java")
 if (getuiSdk) listOf("debug", "release").forEach { sourceSets.getByName(it).manifest.srcFile("src/getui/AndroidManifest.xml") }
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
 defaultConfig {
  buildConfigField("boolean", "GETUI_CONFIGURED", getuiConfigured.toString())
  buildConfigField("boolean", "GETUI_SDK_INCLUDED", getuiSdk.toString())
  manifestPlaceholders["GETUI_APPID"] = getuiAppId
  buildConfigField("boolean", "ALLOW_LOCAL_DEMO", "false")
  manifestPlaceholders["allowLocalDemo"] = "false"
 }
 buildTypes.getByName("debug").manifestPlaceholders["updateChannel"] = "preview"
 buildTypes.getByName("release").manifestPlaceholders["updateChannel"] = "stable"
 testOptions { unitTests.isIncludeAndroidResources = true }
 buildFeatures { compose = true; buildConfig = true }
 compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }

}
val verifyStaffReleaseSigning = tasks.register("verifyStaffReleaseSigning") {
 doLast {
  check(!getuiSdk || getuiConfigured) { "包含实时通知 SDK 的正式安装包必须配置有效 App ID；空配置仅用于编译验证" }
  val required = listOf("MBOX_ANDROID_KEYSTORE", "MBOX_ANDROID_KEYSTORE_PASSWORD", "MBOX_ANDROID_KEY_ALIAS", "MBOX_ANDROID_KEY_PASSWORD")
  check(required.all { !providers.environmentVariable(it).orNull.isNullOrBlank() }) {
   "正式打包需要完整的长期签名配置；不会生成可误发的未签名安装包。"
  }
  check(file(providers.environmentVariable("MBOX_ANDROID_KEYSTORE").get()).isFile) { "正式签名文件不存在" }
 }
}
tasks.matching { it.name in setOf("validateSigningRelease", "packageRelease", "packageReleaseBundle") }.configureEach {
 dependsOn(verifyStaffReleaseSigning)
}
dependencies {
 if (getuiSdk) {
  implementation("com.getui:gtsdk:3.3.16.0")
  implementation("com.getui:gtc:3.3.3.0")
 }
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
 testImplementation("androidx.compose.ui:ui-test-junit4")
 debugImplementation("androidx.compose.ui:ui-tooling")
 debugImplementation("androidx.compose.ui:ui-test-manifest")
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
