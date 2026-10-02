package com.mbox.staff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.json.JSONArray
@Composable
fun PerformanceSongs(m:AppModel,performer:JSONObject,close:()->Unit,propose:(()->LiveCommand)->Unit){
 val scope=rememberCoroutineScope();var data by remember{mutableStateOf<JSONObject?>(null)};var query by remember{mutableStateOf("")};var loadedQuery by remember{mutableStateOf("")};var offset by remember{mutableIntStateOf(0)};var rows by remember{mutableStateOf("")};var mode by remember{mutableStateOf("upsert")};var notice by remember{mutableStateOf("")};var selected by remember{mutableStateOf<JSONObject?>(null)};var code by remember{mutableStateOf("")};var title by remember{mutableStateOf("")};var aliases by remember{mutableStateOf("")};var status by remember{mutableStateOf("active")}
 suspend fun load(next:Int=0,search:String=query){try{data=m.readPerformanceExtra("/performers/${performer.getString("id")}/songs?offset=$next&search=${LiveCommand.part(search)}");offset=next;loadedQuery=search;selected=null;notice="已读取曲库"}catch(e:Exception){data=null;notice=e.message?:"曲库读取失败"}}
 LaunchedEffect(Unit){load()}
 Panel {
  Text("${performer.getString("stageName")} · 曲库",style=MaterialTheme.typography.titleLarge);Text(notice);CustodyField("搜索歌名、编号或别名",query,120){query=it};SecondaryAction(onClick={scope.launch{load()}},enabled=!m.busy){Text("搜索完整曲库")}
  val catalog=data
  if(catalog!=null){Text("本次筛选 ${catalog.getInt("total")} 首，完整曲库 ${catalog.getInt("totalSongs")} 首")
   for(song in catalog.getJSONArray("songs").objects()){Text("${song.getString("title")} · ${song.textOrNull("code") ?: "无编号"} · ${if(song.getString("status")=="active")"启用" else "停用"}");Text("点歌 ${song.getInt("requestCount")} 次 · 演唱 ${song.getInt("performedCount")} 次");if(m.identity?.allows("song.manage")==true)TextButton(onClick={selected=song;code=song.textOrNull("code").orEmpty();title=song.getString("title");aliases=(0 until song.getJSONArray("aliases").length()).joinToString("，"){song.getJSONArray("aliases").getString(it)};status=song.getString("status")},enabled=!m.busy){Text("编辑 ${song.getString("title")}")}}
   if(offset>0)SecondaryAction(onClick={scope.launch{load((offset-100).coerceAtLeast(0),loadedQuery)}},enabled=!m.busy){Text("上一页曲目")};if(!catalog.isNull("nextOffset"))SecondaryAction(onClick={scope.launch{load(catalog.getInt("nextOffset"),loadedQuery)}},enabled=!m.busy){Text("下一页曲目")}
   if(m.identity?.allows("song.manage")==true){
    selected?.let{song->Foldout("编辑曲目资料"){CustodyField("编号（可留空）",code,64){code=it};CustodyField("歌名",title,240){title=it};CustodyField("别名，逗号分隔",aliases,1000){aliases=it};AssignmentChoice("状态",status,listOf("active" to "启用","inactive" to "停用")){status=it};PrimaryAction(onClick={propose{require(title.isNotBlank());performanceCommand(m.identity!!,"song-update",JSONObject().put("songId",song.getString("id")).put("expected",song.getString("configurationFingerprint")).put("changes",JSONObject().put("code",code.trim().takeIf{it.isNotBlank()} ?: JSONObject.NULL).put("title",title.trim()).put("aliases",JSONArray(aliases.split(',','，').map{it.trim()}.filter{it.isNotBlank()})).put("status",status)),"修改曲目\n${performer.getString("stageName")} · $title\n编号 $code · 别名 $aliases\n${if(status=="active")"启用" else "停用"}")}},enabled=m.canUsePerformances){Text("核对并保存曲目")}}}
    Foldout("批量维护曲库"){Text("每行：编号 | 歌名 | 别名1,别名2；也可每行只填歌名。每次最多5000首。")
     CustodyField("粘贴曲目清单",rows,500000){rows=it};AssignmentChoice("导入方式",mode,listOf("upsert" to "追加或更新","replace" to "替换全部可用曲库")){mode=it};if(mode=="replace")Text("未列出的歌曲会停用；空清单会停用全部曲目，历史点歌记录保留。")
     PrimaryAction(onClick={propose{val songs=parseNativeSongRows(rows);require(songs.length()>0||mode=="replace");performanceCommand(m.identity!!,"songs-import",JSONObject().put("performerId",performer.getString("id")).put("expected",catalog.getString("catalogFingerprint")).put("sourceName","Android员工曲库维护").put("mode",mode).put("songs",songs),"${if(mode=="replace")"替换全部曲库" else "追加更新曲库"}\n演员 ${performer.getString("stageName")}\n本次 ${songs.length()} 首，原曲库 ${catalog.getInt("totalSongs")} 首\n${if(mode=="replace")"未列出的歌曲将停用，请核对完整清单。" else "按编号或歌名匹配更新，保留其他歌曲。"}\n"+songs.objects().take(20).joinToString("\n"){it.getString("title")}+if(songs.length()>20)"\n其余请返回原清单核对" else "")}},enabled=m.canUsePerformances){Text("核对导入清单")}
    }
   }
  };TextButton(onClick=close){Text("关闭曲库")}
 }
}
