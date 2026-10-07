package com.mbox.staff
import android.content.Context
/** No SDK bytecode or provider components are packaged by the default build. */
object GetuiSdk {
    fun start(c: Context, owner: NativePushOwner, token: (String) -> Unit, notification: (String, Boolean) -> Unit): Boolean = false
    fun stop(c: Context) {}
}
