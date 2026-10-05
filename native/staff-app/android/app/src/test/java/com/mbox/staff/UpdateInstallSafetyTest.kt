package com.mbox.staff

import android.app.Application
import java.io.File
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class UpdateInstallSafetyTest {
    private lateinit var app: Application

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
        app.filesDir.listFiles()?.forEach { it.deleteRecursively() }
    }

    private fun blocked(
        busy: Boolean = false,
        training: Boolean = false,
        operation: Boolean = false,
        order: Boolean = false,
        damagedOperation: Boolean = false,
        damagedDraft: Boolean = false,
    ) = updateInstallBlocked(busy, training, operation, order, damagedOperation, damagedDraft)

    @Test fun aDamagedDraftAloneBlocksUpgradeEvenBeforeLogin() {
        assertFalse(AppModel(app).updateInstallBlocked())
        val draft = File(app.filesDir, "live-drafts-v1.json")
        draft.writeText("interrupted draft write")
        val model = AppModel(app)
        assertNull(model.identity)
        assertTrue(model.draftStorageDamaged)
        assertFalse(model.liveStorageDamaged)
        assertTrue(model.updateInstallBlocked())
        assertEquals("interrupted draft write", draft.readText())
    }

    @Test fun everyUnsettledBusinessStateBlocksInstaller() {
        assertTrue(blocked(busy = true))
        assertTrue(blocked(training = true))
        assertTrue(blocked(operation = true))
        assertTrue(blocked(order = true))
    }

    @Test fun corruptOperationRecordsRemainBlockedAndAreNeverDeletedByUpdateGuard() {
        val operation = File(app.filesDir, "live-pending-v1.json")
        operation.writeText("interrupted operation write")
        val model = AppModel(app)
        assertTrue(model.liveStorageDamaged)
        assertTrue(model.updateInstallBlocked())
        assertEquals("interrupted operation write", operation.readText())
    }
}
