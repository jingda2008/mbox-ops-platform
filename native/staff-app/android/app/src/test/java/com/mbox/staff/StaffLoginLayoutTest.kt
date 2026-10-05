package com.mbox.staff

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** Offline real Compose layout: no employee credentials or production requests. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26, 35], qualifiers = "w320dp-h568dp-mdpi")
class StaffLoginLayoutTest {
    @get:Rule val compose = createComposeRule()
    private lateinit var model: AppModel

    @Before fun prepare() {
        val app = RuntimeEnvironment.getApplication()
        app.filesDir.listFiles()?.forEach { it.deleteRecursively() }
        model = AppModel(app)
    }

    private fun checkLogin(fontScale: Float, height: Int) {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(1f, fontScale)) {
                MaterialTheme {
                    Box(Modifier.requiredSize(320.dp, height.dp)) { StaffLoginScreen(model) }
                }
            }
        }
        compose.onNodeWithText("门店口令").performScrollTo().assertIsDisplayed()
        compose.onNode(hasClickAction() and hasText("验证门店设备"))
            .performScrollTo().assertIsDisplayed().assertIsNotEnabled()
        compose.onNode(hasSetTextAction() and hasText("员工账号"))
            .performScrollTo().performTextInput("staff-layout-check")
        compose.onNode(hasSetTextAction() and hasText("4位数字 PIN"))
            .performScrollTo().performTextInput("1234")
        // Typing credentials must not unlock business before device verification.
        compose.onNode(hasClickAction() and hasText("登录门店"))
            .performScrollTo().assertIsDisplayed().assertIsNotEnabled()
            .assertHeightIsAtLeast(48.dp)
        compose.onNodeWithText("检查应用更新").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("返回本机演练").assertDoesNotExist()
    }

    @Test fun smallPhoneCanReachAllLoginControls() = checkLogin(1f, 568)
    @Test fun largeTextAndReducedKeyboardSpaceKeepLoginAndUpdatesReachable() = checkLogin(2f, 320)
}
