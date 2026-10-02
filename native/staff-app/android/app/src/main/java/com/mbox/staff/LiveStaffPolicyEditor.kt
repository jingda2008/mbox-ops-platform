package com.mbox.staff
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import org.json.JSONObject
import org.json.JSONArray

@Composable fun StaffPolicyEditor(m:AppModel,b:StaffAdministrationBoard,row:JSONObject,employee:Boolean,propose:(()->LiveCommand)->Unit){
 var kind by remember{mutableStateOf(if(employee)"employee_override" else "role_permission")};var code by remember{mutableStateOf("")};var search by remember{mutableStateOf("")};var reason by remember{mutableStateOf("")};var changes by remember{mutableStateOf(listOf<Pair<JSONObject,String>>())};var notice by remember{mutableStateOf("")}
 Panel{Text("配置 ${row.getString(if(employee)"displayName" else "name")}",style=MaterialTheme.typography.titleMedium)
  if(!employee)AssignmentChoice("配置类型",kind,listOf("role_permission" to "操作权限","role_approval_limit" to "审批额度","role_data_scope" to "数据范围","role_navigation" to "工作入口")){kind=it;code=""}
  CustodyField("搜索配置名称",search,100){search=it}
  val definitions=if(kind in setOf("role_permission","employee_override"))b.overview.getJSONArray("permissions").objects() else b.overview.getJSONArray("configurationDefinitions").objects().filter{it.getString("kind")==kind.removePrefix("role_")}
  val options=definitions.filter{search.isBlank()||it.getString(if(it.has("label"))"label" else "name").contains(search,true)||it.getString("code").contains(search,true)}
  AssignmentChoice("选择配置项",code,listOf("" to "请选择")+options.map{it.getString("code") to it.getString(if(it.has("label"))"label" else "name")}){code=it}
  definitions.find{it.getString("code")==code}?.let{definition->key(kind,code){StaffPolicyFields(b,row,kind,definition){body,label->val id=body.optString("permissionCode",body.optString("approvalCode",body.optString("scopeKey",body.optString("navigationCode"))));changes=changes.filterNot{it.first.getString("kind")==kind&&it.first.optString("permissionCode",it.first.optString("approvalCode",it.first.optString("scopeKey",it.first.optString("navigationCode"))))==id}+(body to label);notice="已加入待发布修改：$id"}}}
  if(notice.isNotBlank())Text(notice)
  if(changes.isNotEmpty()){Text("待发布 ${changes.size}项",style=MaterialTheme.typography.titleMedium);for((index,entry) in changes.withIndex())Row{Text(entry.second,androidx.compose.ui.Modifier.weight(1f));TextButton(onClick={changes=changes.filterIndexed{i,_->i!=index}}){Text("移除")}}}
  CustodyField("发布原因",reason,200){reason=it};Text("权限与入口分别控制；隐藏入口不会撤销权限。发布使用当前原版本，管理员并发修改时须重新读取。")
  PrimaryAction(onClick={propose{val body=JSONObject().put("reason",reason.trim()).put("changes",JSONArray(changes.map{it.first}));staffAdministrationCommand(m.identity!!,b,"deploy",body,"修改 ${row.getString(if(employee)"displayName" else "name")}\n"+changes.joinToString("\n"){it.second}+"\n原因：$reason")}},enabled=m.canUseStaffAdministration&&changes.isNotEmpty()){Text("核对并发布全部修改")}
 }
}
@Composable private fun StaffPolicyFields(b:StaffAdministrationBoard,row:JSONObject,kind:String,d:JSONObject,add:(JSONObject,String)->Unit){
 val code=d.getString("code");val label=d.getString(if(d.has("label"))"label" else "name");val config=d.optJSONObject("config")?:JSONObject()
 val current=when(kind){"employee_override"->row.getJSONArray("overrides").objects().find{it.getString("permissionCode")==code};"role_approval_limit"->row.getJSONArray("approvalLimits").objects().find{it.getString("code")==code&&it.getString("currency")==config.optString("currency","CNY")};"role_data_scope"->row.getJSONArray("dataScopes").objects().find{it.getString("key")==code&&it.getString("effect")==config.optString("effect","include")};"role_navigation"->row.getJSONArray("navigation").objects().find{it.getString("code")==code};else->null}
 var enabled by remember{mutableStateOf(if(kind=="role_permission")row.getJSONArray("permissionCodes").strings().contains(code) else current?.optBoolean("enabled")?:false)};var effect by remember{mutableStateOf(current?.textOrNull("effect")?:"default")};var amount by remember{mutableStateOf(current?.let{ownerAmount(it,"amountMinor")}?:"0")};var discount by remember{mutableStateOf((current?.optJSONObject("rules")?.optInt("discountBasisPoints")?:0).toString())};var name by remember{mutableStateOf(current?.optString("label")?:label)};var sort by remember{mutableStateOf((current?.optInt("sortOrder")?:d.optInt("sortOrder")).toString())};var frequent by remember{mutableStateOf(current?.optJSONObject("displayConfig")?.optBoolean("highFrequency")?:false)};var values by remember{mutableStateOf(current?.optJSONArray("value")?.strings()?:emptyList())};var error by remember{mutableStateOf("")}
 Text(d.optString("description"));if(kind=="employee_override")AssignmentChoice("个人授权",effect,listOf("default" to "遵循岗位","grant" to "额外允许","deny" to "明确禁止")){effect=it}
 else Row{Switch(checked=enabled,onCheckedChange={enabled=it});Text(if(enabled)"启用" else "停用")}
 val controls=config.optJSONArray("controls")?.strings()?:emptyList();val editor=config.optString("editor")
 if(kind=="role_approval_limit"){CustodyField("单次上限（元；空白表示不设金额上限）",amount,16){amount=it};if("discount_percent" in controls)CustodyField("最高折扣基点（100基点=1%，0至10000）",discount,5){discount=it};if("second_actor" in controls)Text("强制不同员工复核，不能关闭")}
 if(kind=="role_data_scope"&&editor!="boolean"){
  val options=when(editor){"area_multi"->b.overview.getJSONArray("areas").objects().map{it.getString("id") to it.getString("name")};"employee_multi"->b.employees.filter{it.getString("status")=="active"}.map{it.getString("id") to it.getString("displayName")};"multi_choice"->(config.optJSONArray("options")?.strings()?:emptyList()).map{it to it};else->emptyList()}
  for((value,text) in options)Row{Checkbox(checked=value in values,onCheckedChange={checked->values=if(checked)(values+value).distinct() else values-value});Text(text)}
  if(editor !in setOf("area_multi","employee_multi","multi_choice"))Text("后台定义的该数据类型暂不支持编辑，原值保留")
 }
 if(kind=="role_navigation"){CustodyField("入口名称",name,30){name=it};CustodyField("排序（0至999）",sort,3){sort=it};Row{Checkbox(checked=frequent,onCheckedChange={frequent=it});Text("手机高频入口（最多4个）")}}
 if(error.isNotBlank())Text(error,color=MaterialTheme.colorScheme.error)
 SecondaryAction(onClick={try{
  val body=JSONObject().put("kind",kind).put(if(kind=="employee_override")"employeeId" else "roleId",row.getString("id"));var detail=if(enabled)"启用" else "停用"
  when(kind){
   "role_permission"->body.put("permissionCode",code).put("enabled",enabled)
   "employee_override"->{body.put("permissionCode",code).put("effect",if(effect=="default")JSONObject.NULL else effect);detail=when(effect){"grant"->"额外允许";"deny"->"明确禁止";else->"遵循岗位"}}
   "role_approval_limit"->{val rules=JSONObject((current?.optJSONObject("rules")?:config.optJSONObject("defaultRules")?:JSONObject()).toString()).put("requiresReason",true);if("second_actor" in controls)rules.put("requiresSecondActor",true);if("discount_percent" in controls){val value=discount.toIntOrNull()?:error("折扣基点须为整数");require(value in 0..10000);rules.put("discountBasisPoints",value)};body.put("approvalCode",code).put("amountMinor",if(amount.isBlank())JSONObject.NULL else ownerMoney(amount)).put("currency",config.optString("currency","CNY")).put("rules",rules).put("enabled",enabled);detail+="，上限${if(amount.isBlank())"不设金额上限" else amount+"元"}${if("discount_percent" in controls)"，折扣${discount}基点" else ""}${if("second_actor" in controls)"，独立复核" else ""}"}
   "role_data_scope"->{require(editor in setOf("boolean","area_multi","employee_multi","multi_choice")){"此类型暂不支持编辑"};body.put("scopeKey",code).put("effect",config.optString("effect","include")).put("scopeValue",if(editor=="boolean")config.opt("enabledValue")?:true else JSONArray(values)).put("enabled",enabled);detail+="，${if(editor=="boolean")d.optString("description") else values.joinToString{v->b.employees.find{it.getString("id")==v}?.getString("displayName")?:b.overview.getJSONArray("areas").objects().find{it.getString("id")==v}?.getString("name")?:v}}"}
   "role_navigation"->{require(name.trim().isNotBlank());val order=sort.toIntOrNull()?:error("排序须为整数");require(order in 0..999);body.put("navigationCode",code).put("label",name.trim()).put("route",config.getString("route")).put("icon",config.opt("icon")?:JSONObject.NULL).put("sortOrder",order).put("enabled",enabled).put("displayConfig",JSONObject((current?.optJSONObject("displayConfig")?:JSONObject()).toString()).put("highFrequency",frequent));detail+="，$name，排序$sort，${if(frequent)"高频" else "普通"}"}
  };add(body,"$label：$detail");error=""
 }catch(e:Exception){error=e.message?:"请检查输入"}}){Text("加入待发布清单")}
}
