package com.mbox.staff
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

@Composable fun StaffToolMenu(actor:StaffIdentity?,open:(String)->Unit){
 val tools=staffTools(actor)
 var query by remember(actor?.employeeId){mutableStateOf("")}
 var group by remember(actor?.employeeId){mutableStateOf(tools.firstOrNull()?.group.orEmpty())}
 LaunchedEffect(tools){if(group.isNotBlank()&&tools.none{it.group==group})group=tools.firstOrNull()?.group.orEmpty()}
 if(tools.isEmpty()){Text("当前岗位暂无可用业务入口，请联系管理员核对权限。");return}
 OutlinedTextField(query,{query=it.take(80);group=""},label={Text("查找功能，如核销、盘点、打印")},singleLine=true,leadingIcon={Icon(Icons.Outlined.Search,null)},trailingIcon={if(query.isNotBlank())IconButton(onClick={query="";group=tools.first().group}){Icon(Icons.Outlined.Close,"清除功能搜索")}},modifier=Modifier.fillMaxWidth())
 Row(Modifier.horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(8.dp)){
  FilterChip(group.isBlank(),{group=""},label={Text("全部")})
  for(g in staffToolGroups.filter{g->tools.any{it.group==g}})FilterChip(group==g,{group=g;query=""},label={Text(g)})
 }
 val results=filterStaffTools(tools,query,group)
 if(results.isEmpty())Text("没有匹配的已授权功能。可修改搜索词或切换分类。")
 for(g in staffToolGroups){val entries=results.filter{it.group==g};if(entries.isNotEmpty()){
  Text("$g · ${entries.size}",fontWeight=FontWeight.SemiBold,modifier=Modifier.semantics{heading()})
  for(entry in entries){val icon=when(g){"桌边服务"->Icons.Outlined.RoomService;"会员服务"->Icons.Outlined.CardMembership;"库存与出品"->Icons.Outlined.Inventory2;"经营管理"->Icons.Outlined.Insights;else->Icons.Outlined.Settings}
   ElevatedCard(onClick={open(entry.id)},modifier=Modifier.fillMaxWidth(),colors=CardDefaults.elevatedCardColors(containerColor=MaterialTheme.colorScheme.surface),elevation=CardDefaults.elevatedCardElevation(defaultElevation=2.dp)){
    Row(Modifier.fillMaxWidth().heightIn(min=64.dp).padding(horizontal=14.dp,vertical=12.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)){
     Icon(icon,null,tint=Ink,modifier=Modifier.size(24.dp))
     Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(3.dp)){Text(entry.title,fontWeight=FontWeight.SemiBold);Text(entry.detail,style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)}
     Icon(Icons.Outlined.ChevronRight,null,tint=Gold)
    }
   }
  }
 }}
}
