package com.mbox.staff

import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class WorkspacePollingTest {
    private val first = WorkspaceReadIdentity("employee-a", "session-a", "prepare", 1)

    @Test
    fun firstVisibleReadIsImmediateAndHiddenWorkspaceStopsPolling() = runBlocking {
        var visible = true
        var reads = 0
        var waits = 0
        pollVisibleWorkspace({ visible }, { true }, { reads++ }) {
            waits++
            assertEquals(waits, reads)
            if (waits == 3) visible = false
        }
        assertEquals(3, reads)
        pollVisibleWorkspace({ false }, { true }, { fail("不能在后台读取") }) {
            fail("隐藏工作台不应保持轮询")
        }
    }

    @Test
    fun writesAreNotInterruptedAndReadResumesAtNextOpportunity() = runBlocking {
        var visible = true
        var busy = true
        var rounds = 0
        var reads = 0
        pollVisibleWorkspace({ visible }, { !busy }, { reads++ }) {
            rounds++
            if (rounds == 1) {
                assertEquals(0, reads)
                busy = false
            } else visible = false
        }
        assertEquals(1, reads)
    }

    @Test
    fun sameEmployeeResponseIsAcceptedWithoutReplacingUnrelatedUiState() = runBlocking {
        val snapshot = Any()
        assertSame(snapshot, readCurrentWorkspace(first, { first }) { snapshot })
    }

    @Test
    fun changedEmployeeSessionPermissionOrWorkspaceRejectsLateResponse() = runBlocking {
        for (replacement in listOf(
            first.copy(employee = "employee-b"),
            first.copy(session = "session-b"),
            first.copy(access = "read-only"),
            first.copy(workspace = 2),
        )) {
            var current = first
            var displayed = "previous queue"
            try {
                displayed = readCurrentWorkspace(first, { current }) {
                    current = replacement
                    "old employee late response"
                }
                fail("旧身份回调必须丢弃")
            } catch (_: CancellationException) {
                assertEquals("previous queue", displayed)
            }
        }
    }

    @Test
    fun networkFailureKeepsLastReadableQueueForExplicitStaleDisplay() = runBlocking {
        var displayed = "previous queue"
        try {
            displayed = readCurrentWorkspace(first, { first }) { throw IOException("offline") }
            fail("读取失败不能当作空队列")
        } catch (_: IOException) {
            assertEquals("previous queue", displayed)
        }
    }

    @Test
    fun oldWorkspaceDoesNotEvenStartANewRequest() = runBlocking {
        try {
            readCurrentWorkspace(first, { first.copy(employee = null) }) {
                fail("已登出不能发出旧员工请求")
            }
            fail("读取应已取消")
        } catch (_: CancellationException) { }
    }
}
