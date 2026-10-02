package com.mbox.staff

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.*
import android.graphics.pdf.PdfDocument
import androidx.exifinterface.media.ExifInterface
import android.os.*
import android.print.*
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import org.json.JSONObject

@Composable
fun CustodyPhotoCapture(owner: String, enabled: Boolean, photo: String, change: (String)->Unit) {
    val context = LocalContext.current
    val currentOwner by rememberUpdatedState(owner)
    val currentChange by rememberUpdatedState(change)
    var pending by remember { mutableStateOf<File?>(null) }
    var pendingOwner by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val file = pending; pending = null
        try {
            if(ok && file != null && pendingOwner == currentOwner) currentChange(custodyPhotoBytes(file))
            else if(!ok) error = "未拍摄照片，可重新拍摄"
        } catch(e: Exception) { error = e.message ?: "照片读取失败，请重拍" }
        finally { file?.delete() }
    }
    fun capture() {
        try {
            val folder = File(context.cacheDir,"custody-capture").apply { mkdirs() }
            folder.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 86400000 }?.forEach { it.delete() }
            val file = File(folder,"${UUID.randomUUID()}.jpg"); pending = file; pendingOwner = currentOwner
            camera.launch(FileProvider.getUriForFile(context,context.packageName+".updates",file)); error = ""
        } catch(e: Exception) { pending?.delete(); pending = null; error = "相机无法打开，请检查相机权限及是否有相机应用" }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if(granted) capture() else error = "相机权限未开启。存酒需实物照片，请在系统设置允许相机后重试。" }
    DisposableEffect(Unit) { onDispose { pending?.delete() } }
    SecondaryAction(onClick = { if(ContextCompat.checkSelfPermission(context,Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) capture() else permission.launch(Manifest.permission.CAMERA) }, enabled = enabled) { Text(if(photo.isBlank()) "拍摄存酒实物" else "重新拍摄实物") }
    val bitmap = remember(photo) { runCatching { if(photo.isBlank()) null else Base64.decode(photo,Base64.DEFAULT).let { BitmapFactory.decodeByteArray(it,0,it.size) } }.getOrNull() }
    if(bitmap != null) Image(bitmap.asImageBitmap(),contentDescription = "本次存酒实物照片，提交前请核对",modifier = Modifier.fillMaxWidth().height(180.dp))
    DisposableEffect(bitmap) { onDispose { bitmap?.recycle() } }
    if(error.isNotBlank()) Text(error,color = MaterialTheme.colorScheme.error)
}
private fun custodyPhotoBytes(file: File): String {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }; BitmapFactory.decodeFile(file.path,bounds)
    require(bounds.outWidth >= 160 && bounds.outHeight >= 120) { "照片尺寸不足，请重新拍摄" }
    val options = BitmapFactory.Options().apply { inSampleSize = 1; while(kotlin.math.max(bounds.outWidth,bounds.outHeight) / inSampleSize > 1600) inSampleSize *= 2 }
    var bitmap = BitmapFactory.decodeFile(file.path,options) ?: error("照片无法解码")
    val orientation = ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION,ExifInterface.ORIENTATION_NORMAL)
    val matrix = Matrix().apply { when(orientation) { ExifInterface.ORIENTATION_ROTATE_90 -> postRotate(90f); ExifInterface.ORIENTATION_ROTATE_180 -> postRotate(180f); ExifInterface.ORIENTATION_ROTATE_270 -> postRotate(270f); ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> postScale(-1f,1f); ExifInterface.ORIENTATION_FLIP_VERTICAL -> postScale(1f,-1f); ExifInterface.ORIENTATION_TRANSPOSE -> { postRotate(90f); postScale(-1f,1f) }; ExifInterface.ORIENTATION_TRANSVERSE -> { postRotate(270f); postScale(-1f,1f) } } }
    if(!matrix.isIdentity) { val rotated = Bitmap.createBitmap(bitmap,0,0,bitmap.width,bitmap.height,matrix,true); if(rotated !== bitmap) bitmap.recycle(); bitmap = rotated }
    val out = ByteArrayOutputStream(); var quality = 85
    do { out.reset(); bitmap.compress(Bitmap.CompressFormat.JPEG,quality,out); quality -= 10 } while(out.size() > 1048576 && quality >= 45)
    bitmap.recycle()
    require(out.size() <= 1048576) { "照片超过1MB，请重新拍摄" }
    return Base64.encodeToString(out.toByteArray(),Base64.NO_WRAP)
}
fun printCustodyDocument(context: Context, snapshot: JSONObject) {
    val order = snapshot.getJSONObject("order"); val policy = snapshot.getJSONObject("policy")
    val lines = mutableListOf(policy.getString("printTitle"),order.getString("public_id"),"会员：${order.getString("member_no")}")
    val labels = linkedMapOf("category" to ("品类：" + order.getString("category_name")),"item" to ("酒名：" + order.getString("item_name")),"quantity" to ("原存：" + order.getString("original_quantity") + order.getString("unit")),"remaining" to ("剩余：" + order.getString("remaining_quantity") + order.getString("unit")),"expiry" to ("到期：" + historyExportTime(order.getString("expires_at"))),"location" to ("位置：" + order.optString("location")),"status" to ("状态：" + custodyStatuses[order.getString("status")]),"source" to ("原购凭证：" + (order.textOrNull("source_reference") ?: "未登记")))
    val fields = policy.getJSONArray("printFields"); for(i in 0 until fields.length()) labels[fields.getString(i)]?.let(lines::add)
    for(field in order.getJSONArray("extra_field_snapshot").objects()) lines.add(field.getString("label") + "：" + order.getJSONObject("extra_fields").optString(field.getString("key")))
    lines.add(policy.getString("printFooter")); lines.add("存酒登记不代表销售收款。")
    (context.getSystemService(Context.PRINT_SERVICE) as PrintManager).print("MBOX-${order.getString("public_id")}",object: PrintDocumentAdapter() {
        override fun onLayout(old: PrintAttributes?, new: PrintAttributes, cancellation: CancellationSignal, callback: LayoutResultCallback, extras: Bundle?) {
            if(cancellation.isCanceled) callback.onLayoutCancelled() else callback.onLayoutFinished(PrintDocumentInfo.Builder("MBOX-存酒凭证.pdf").setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT).build(),true)
        }
        override fun onWrite(pages: Array<out PageRange>, destination: ParcelFileDescriptor, cancellation: CancellationSignal, callback: WriteResultCallback) {
            val doc = PdfDocument()
            try {
                val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK; textSize = 13f }
                val wrapped = mutableListOf<String>()
                for(line in lines) { var rest = line; if(rest.isBlank()) wrapped.add(""); while(rest.isNotEmpty()) { val count = paint.breakText(rest,true,265f,null).coerceAtLeast(1); wrapped.add(rest.take(count)); rest = rest.drop(count) } }
                val groups = wrapped.chunked(36); val written = mutableListOf<PageRange>()
                for((index,group) in groups.withIndex()) {
                    if(cancellation.isCanceled) { callback.onWriteCancelled(); return }
                    if(pages.none { index in it.start..it.end }) continue
                    val page = doc.startPage(PdfDocument.PageInfo.Builder(300,800,index+1).create())
                    group.forEachIndexed { i,text -> page.canvas.drawText(text,16f,30f+i*20,paint) }; doc.finishPage(page); written.add(PageRange(index,index))
                }
                FileOutputStream(destination.fileDescriptor).use { doc.writeTo(it) }; callback.onWriteFinished(written.toTypedArray())
            } catch(e: Exception) { callback.onWriteFailed("存酒凭证打印失败，请检查打印服务") } finally { doc.close() }
        }
    },null)
}
