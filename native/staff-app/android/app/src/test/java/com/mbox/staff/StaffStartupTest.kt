package com.mbox.staff

import android.app.Application
import java.io.File
import java.io.ObjectOutputStream
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class StaffStartupTest {
    private lateinit var app: Application

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
        app.filesDir.listFiles()?.forEach { it.deleteRecursively() }
    }

    @Test fun freshInstallRequiresRealLoginWithoutSampleBusinessData() {
        val model = AppModel(app)
        assertTrue(model.live)
        assertNull(model.identity)
        assertFalse(model.deviceReady)
        assertTrue(model.world.tables.isEmpty())
        assertTrue(model.world.orders.isEmpty())
        assertEquals("未登录", model.staffName)
        assertNull(model.pending)
    }

    @Test fun upgradeIgnoresOldDemoStateWithoutDeletingItOrBlockingLogin() {
        val file = File(app.filesDir, "training-v1.bin")
        ObjectOutputStream(file.outputStream()).use { it.writeObject(Saved(World.training(), Command("cash", "training-table", "training-session", given = 100))) }
        val previous = file.readBytes()
        val model = AppModel(app)
        assertTrue(model.live)
        assertTrue(model.world.tables.isEmpty())
        assertTrue(model.world.orders.isEmpty())
        assertNull(model.pending)
        assertArrayEquals(previous, file.readBytes())
    }

    @Test fun employeePackageCannotFallBackToDemo() {
        val model = AppModel(app)
        model.train()
        assertTrue(model.live)
        assertTrue(model.world.tables.isEmpty())
        assertNull(model.identity)
        assertFalse(BuildConfig.ALLOW_LOCAL_DEMO)
    }
}
