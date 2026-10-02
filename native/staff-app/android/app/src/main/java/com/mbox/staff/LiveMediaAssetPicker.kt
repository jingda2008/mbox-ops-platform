package com.mbox.staff
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import org.json.JSONObject
@Composable fun LiveMediaAssetPicker(m:AppModel,purpose:String,close:()->Unit,choose:(String)->Unit){
 val access=remember{m.priorityAccessKey};val version=remember{m.workspaceVersion};val scope=rememberCoroutineScope();val context=LocalContext.current;var rows by remember{mutableStateOf(emptyList<JSONObject>())};var next by remember{mutableStateOf("")};var loading by remember{mutableStateOf(false)};var error by remember{mutableStateOf("")}
 fun load(cursor:String){if(loading)return;scope.launch{loading=true;try{val r=m.queryMediaAssets(purpose,cursor);rows=if(cursor.isBlank())r.getJSONArray("data").objects() else rows+r.getJSONArray("data").objects();next=r.getJSONObject("meta").textOrNull("nextCursor")?:"";error=""}catch(e:Exception){error=e.message.orEmpty()}finally{loading=false}}}
 val picker=rememberLauncherForActivityResult(ActivityResultContracts.GetContent()){uri->if(uri!=null)scope.launch{loading=true;try{val bytes=withContext(Dispatchers.IO){context.contentResolver.openInputStream(uri)?.use{readMediaBytes(it)}?:error("无法读取图片")};require(bytes.size in 1..204800){"图片须不超过200KB，请先在相册裁剪或压缩后再选"};val bounds=BitmapFactory.Options().apply{inJustDecodeBounds=true};BitmapFactory.decodeByteArray(bytes,0,bytes.size,bounds);require(bounds.outWidth>0&&bounds.outHeight>0&&bounds.outWidth.toLong()*bounds.outHeight<=16000000){"图片尺寸无效或过大"};val mime=bounds.outMimeType;require(mime in setOf("image/jpeg","image/png","image/webp")){"请选择JPG、PNG或WebP图片"};val asset=m.uploadMediaAsset(purpose,bytes,mime);if(access==m.priorityAccessKey&&version==m.workspaceVersion)choose(asset.getString("publicUrl"))}catch(e:Exception){error=(e.message?:"上传结果待核对")+"；可刷新图片库核对，同一图片重传会复用已有记录"}finally{loading=false}}}
 LaunchedEffect(Unit){load("")};LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||version!=m.workspaceVersion)close()};if(access!=m.priorityAccessKey||version!=m.workspaceVersion)return
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
  item{Row{Text("门店图片库",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};Text("选择或上传图片后，回到内容表单核对并保存才生效。");Text(error,color=MaterialTheme.colorScheme.error);Row{TextButton(onClick={load("")},enabled=!loading){Text("刷新")};TextButton(onClick={picker.launch("image/*")},enabled=!loading&&!m.busy){Text("从手机上传")}}}
  for(asset in rows)item{Panel{MediaAssetThumbnail(m,asset.getString("publicId"));Text(asset.getString("originalFileName"));Text("${(asset.getInt("byteLength")+1023)/1024}KB · ${asset.getString("createdAt")}");PrimaryAction(onClick={choose(asset.getString("publicUrl"))},enabled=!loading){Text("选择此图片")}}}
  if(next.isNotBlank())item{TextButton(onClick={load(next)},enabled=!loading){Text("加载更多")}};if(rows.isEmpty()&&!loading)item{Text("还没有此用途的图片")}
 }}}
}
@Composable fun MediaAssetThumbnail(m:AppModel,id:String){var bitmap by remember(id,m.priorityAccessKey){mutableStateOf<android.graphics.Bitmap?>(null)};var failed by remember(id){mutableStateOf(false)};LaunchedEffect(id,m.priorityAccessKey){try{val bytes=m.queryMediaThumbnail(id);val bounds=BitmapFactory.Options().apply{inJustDecodeBounds=true};BitmapFactory.decodeByteArray(bytes,0,bytes.size,bounds);require(bounds.outWidth>0&&bounds.outHeight>0);val opts=BitmapFactory.Options().apply{inSampleSize=1;while(maxOf(bounds.outWidth,bounds.outHeight)/inSampleSize>800)inSampleSize*=2};bitmap=BitmapFactory.decodeByteArray(bytes,0,bytes.size,opts)}catch(_:Exception){failed=true}};bitmap?.let{Image(it.asImageBitmap(),contentDescription="门店图片预览",modifier=Modifier.fillMaxWidth().height(160.dp))}?:Text(if(failed)"预览暂不可用" else "正在读取预览")}

fun readMediaBytes(input:java.io.InputStream):ByteArray{val output=java.io.ByteArrayOutputStream();val buffer=ByteArray(8192);while(output.size()<204801){val count=input.read(buffer,0,minOf(buffer.size,204801-output.size()));if(count<0)break;if(count==0)continue;output.write(buffer,0,count)};return output.toByteArray()}
