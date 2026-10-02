package com.mbox.staff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import kotlinx.coroutines.launch
import org.json.JSONObject

@Composable
fun MemberCardForm(m:AppModel,edit:MemberCardEditor,close:()->Unit,propose:(()->LiveCommand)->Unit){
 val action=edit.action;val row=edit.row;val scope=rememberCoroutineScope()
 var values by remember{mutableStateOf(mapOf("kind" to "interest","from" to java.time.LocalDate.now(java.time.ZoneId.of("Asia/Shanghai")).toString()+" 00:00","until" to java.time.LocalDate.now(java.time.ZoneId.of("Asia/Shanghai")).plusYears(1).toString()+" 00:00","artistName" to row?.textOrNull("artist_name").orEmpty(),"iconUrl" to row?.textOrNull("icon_url").orEmpty(),"serviceAccountId" to row?.textOrNull("service_account_id").orEmpty(),"wecomAccountId" to row?.textOrNull("wecom_account_id").orEmpty()))}
 var cooperation by remember{mutableStateOf(false)};var restore by remember{mutableStateOf(row?.optBoolean("auto_restore")?:false)}
 var config by remember{mutableStateOf<JSONObject?>(null)};var error by remember{mutableStateOf("")}
 fun v(key:String)=values[key].orEmpty()
 @Composable fun field(key:String,label:String,max:Int=300){CustodyField(label,v(key),max){values=values+(key to it)}}
 suspend fun readConfig(){try{config=m.readMemberCardExtra("/projects/${row!!.getString("id")}/config");error=""}catch(e:Exception){error=e.message?:"配置读取失败"}}
 LaunchedEffect(edit){if(action in setOf("social","menu"))readConfig()}
 Panel{
  Text(when(action){"create"->"新建卡项目";"social"->"加入门槛与卡片";"menu"->"专属菜单";"review"->if(edit.target=="approve")"审核通过" else "拒绝申请";"holding"->mapOf("suspend" to "暂停持卡","resume" to "恢复持卡","revoke" to "撤销持卡")[edit.target]!!;else->"项目状态：${cardStateNames[edit.target]}"},style=MaterialTheme.typography.titleLarge)
  if(error.isNotBlank())Text(error)
  when(action){
   "create"->{
    field("code","编号（大写字母、数字或下划线）",40);field("name","卡名称",60);field("terms","完整申请条款",6000)
    AssignmentChoice("卡类型",v("kind"),listOf("interest" to "兴趣卡","cobrand" to "联名卡")){values=values+("kind" to it)}
    field("from","开始时间 YYYY-MM-DD HH:mm",16);field("until","结束时间 YYYY-MM-DD HH:mm",16)
    if(v("kind")=="cobrand"){field("reference","合作确认依据",500);AssignmentChoice("合作确认",cooperation.toString(),listOf("false" to "尚未确认","true" to "已确认合作")){cooperation=it.toBoolean()};field("cooperationUntil","合作到期时间 YYYY-MM-DD HH:mm",16)}
    Text("保存后为草稿，需配置本店服务号与企业微信，由其他有发布权限的员工开放。")
   }
   "social"->{
    val accounts=config?.getJSONArray("accounts")?.objects().orEmpty()
    if(config==null)SecondaryAction(onClick={scope.launch{readConfig()}},enabled=!m.busy){Text("重读门槛配置")}
    AssignmentChoice("本店服务号",v("serviceAccountId"),accounts.filter{it.getString("kind")=="service_account"}.map{it.getString("id") to it.getString("name")+if(it.getBoolean("enabled"))"" else "（停用）"}){values=values+("serviceAccountId" to it)}
    AssignmentChoice("本店企业微信",v("wecomAccountId"),accounts.filter{it.getString("kind")=="wecom"}.map{it.getString("id") to it.getString("name")+if(it.getBoolean("enabled"))"" else "（停用）"}){values=values+("wecomAccountId" to it)}
    field("artistName","卡片艺人名称",100);field("iconUrl","站内图标路径（可留空）",500)
    AssignmentChoice("顾客重新满足门槛",restore.toString(),listOf("false" to "人工恢复卡","true" to "允许自动恢复")){restore=it.toBoolean()}
    Text("开放后不覆盖历史加入条款。员工不能替顾客完成关注、绑定或授权。")
   }
   "menu"->{MemberCardMenu(m,row!!,config,{scope.launch{readConfig()}},propose);return@Panel}
   else->{Text(row!!.optString("name",row.optString("project_name")));row.textOrNull("customer_reference")?.let{Text("客户 $it")};field("reason","实际处理原因",300);if(action=="holding"&&edit.target=="revoke")Text("撤销后不能恢复此卡。不会自动退钱或回退会员等级。")}
  }
  PrimaryAction(onClick={propose{
   val body=JSONObject();var summary=""
   when(action){
    "create"->{body.put("code",v("code").trim()).put("name",v("name").trim()).put("terms",v("terms").trim()).put("kind",v("kind")).put("availableFrom",performanceTime(v("from"))).put("availableUntil",performanceTime(v("until"))).put("cooperationConfirmed",cooperation&&v("kind")=="cobrand").put("cooperationReference",if(v("kind")=="cobrand")v("reference").trim() else JSONObject.NULL).put("cooperationValidUntil",if(v("kind")=="cobrand"&&v("cooperationUntil").isNotBlank())performanceTime(v("cooperationUntil")) else JSONObject.NULL);summary="保存卡项目草稿\n${v("name")} · ${v("code")}\n${v("from")} — ${v("until")}\n条款：${v("terms")}"}
    "social"->{val c=config?:error("请先读取原门槛配置");body.put("projectId",row!!.getString("id")).put("expectedUpdatedAt",c.getJSONObject("project").getString("updated_at")).put("serviceAccountId",v("serviceAccountId")).put("wecomAccountId",v("wecomAccountId")).put("artistName",v("artistName").trim()).put("iconUrl",v("iconUrl").trim().takeIf{it.isNotBlank()}?:JSONObject.NULL).put("autoRestore",restore);val accounts=c.getJSONArray("accounts").objects();val service=accounts.first{it.getString("id")==v("serviceAccountId")};val wecom=accounts.first{it.getString("id")==v("wecomAccountId")};summary="保存加入门槛\n${row.getString("name")}\n服务号 ${service.getString("name")}\n企业微信 ${wecom.getString("name")}\n艺人 ${v("artistName")}\n自动恢复 ${if(restore)"允许" else "关闭"}"}
    "state"->{body.put("projectId",row!!.getString("id")).put("expectedUpdatedAt",row.getString("updated_at")).put("state",edit.target).put("reason",v("reason").trim());summary="${cardStateNames[edit.target]}\n${row.getString("name")}\n原因：${v("reason")}"}
    "review"->{body.put("applicationId",row!!.getString("id")).put("decision",edit.target).put("reason",v("reason").trim());summary="${if(edit.target=="approve")"通过" else "拒绝"}申请\n${row.getString("project_name")}\n客户 ${row.getString("customer_reference")}\n原因：${v("reason")}"}
    "holding"->{body.put("cardId",row!!.getString("id")).put("expectedUpdatedAt",row.getString("updated_at")).put("action",edit.target).put("reason",v("reason").trim());summary="${mapOf("suspend" to "暂停","resume" to "恢复","revoke" to "撤销")[edit.target]}会员卡\n${row.getString("project_name")}\n客户 ${row.getString("customer_reference")}\n原因：${v("reason")}"}
   };memberCardCommand(m.identity!!,action,body,summary)
  }},enabled=m.canUseMemberCards&&(action!="social"||config!=null)){Text("核对后提交")}
  TextButton(onClick=close){Text("收起编辑")}
 }
}

@Composable
fun MemberCardMenu(m:AppModel,project:JSONObject,config:JSONObject?,refresh:()->Unit,propose:(()->LiveCommand)->Unit){
 val scope=rememberCoroutineScope();var query by remember{mutableStateOf("")};var applied by remember{mutableStateOf("")};var products by remember{mutableStateOf<JSONObject?>(null)};var chosen by remember{mutableStateOf<JSONObject?>(null)}
 var exclusive by remember{mutableStateOf(false)};var active by remember{mutableStateOf(true)};var price by remember{mutableStateOf("")};var sort by remember{mutableStateOf("0")};var notice by remember{mutableStateOf("")}
 fun search(offset:Int,fresh:Boolean=false){scope.launch{try{val q=if(fresh)query else applied;products=m.readMemberCardExtra("/products"+custodyQuery(mapOf("search" to q,"offset" to offset.toString())));applied=q}catch(e:Exception){notice=e.message?:"商品查询失败"}}}
 Text(project.getString("name"));Text("专属价留空沿用商品价格。专属增量商品不能是公共商品；移除卡菜单不删除商品。")
 SecondaryAction(onClick=refresh,enabled=!m.busy){Text("刷新专属菜单")};if(notice.isNotBlank())Text(notice)
 if(config==null){Text("请先读取专属菜单");return}
 for(item in config.getJSONArray("menu").objects()){
  Text("${item.getString("name")} · ${if(item.getBoolean("active"))"展示" else "隐藏"} · ${if(item.getBoolean("exclusive"))"专属增量" else "关联商品"} · ${item.textOrNull("exclusive_price_minor")?.let{money(it.toInt())}?:"标准价"}")
  TextButton(onClick={chosen=JSONObject().put("id",item.getString("product_id")).put("name",item.getString("name"));exclusive=item.getBoolean("exclusive");active=item.getBoolean("active");sort=item.getInt("sort_order").toString();price=item.textOrNull("exclusive_price_minor")?.let{java.math.BigDecimal(it).movePointLeft(2).toPlainString()}.orEmpty()}){Text("编辑此商品")}
  TextButton(onClick={propose{memberCardCommand(m.identity!!,"menu-remove",JSONObject().put("projectId",project.getString("id")).put("expectedMenu",config.getString("expectedMenu")).put("productId",item.getString("product_id")),"移除卡专属菜单项\n${project.getString("name")} · ${item.getString("name")}\n不会删除商品或改变已下订单。")}},enabled=m.canUseMemberCards){Text("移出菜单")}
 }
 CustodyField("搜索可选商品",query,120){query=it};SecondaryAction(onClick={search(0,true)},enabled=!m.busy){Text("查询商品")}
 for(product in products?.getJSONArray("items")?.objects().orEmpty())TextButton(onClick={chosen=product;exclusive=false;active=true;price="";sort="0"}){Text(product.getString("name"))}
 products?.takeUnless{it.isNull("nextOffset")}?.let{TextButton(onClick={search(it.getInt("nextOffset"))},enabled=!m.busy){Text("下一页商品")}}
 chosen?.let{product->
  Text("已选择 ${product.getString("name")}")
  AssignmentChoice("菜单用途",exclusive.toString(),listOf("false" to "关联商品","true" to "专属增量")){exclusive=it.toBoolean()};AssignmentChoice("展示",active.toString(),listOf("true" to "显示","false" to "隐藏")){active=it.toBoolean()}
  CustodyField("专属价（元，可留空）",price,12){price=it};CustodyField("排序 0—10000",sort,5){sort=it}
  PrimaryAction(onClick={propose{val order=sort.toInt();require(order in 0..10000);val minor=if(price.isBlank())null else ownerMoney(price);require(minor==null||minor in 0..100000000);require(!exclusive||!product.optBoolean("guest_visible")){"公共商品不能改为专属增量"};memberCardCommand(m.identity!!,"menu",JSONObject().put("projectId",project.getString("id")).put("expectedMenu",config.getString("expectedMenu")).put("productId",product.getString("id")).put("exclusive",exclusive).put("active",active).put("sortOrder",order).put("exclusivePriceMinor",minor?:JSONObject.NULL),"保存卡专属菜单\n${project.getString("name")} · ${product.getString("name")}\n${if(exclusive)"专属增量" else "关联商品"} · ${if(active)"显示" else "隐藏"}\n价格 ${minor?.let{money(it.toInt())}?:"标准价"} · 排序 $order")}},enabled=m.canUseMemberCards){Text("核对菜单变更")}
 }
}
