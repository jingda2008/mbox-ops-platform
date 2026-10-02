package com.mbox.staff
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.json.JSONArray

@Composable fun LiveBenefitWalletView(m:AppModel,close:()->Unit){
 val access=remember{m.priorityAccessKey};val version=remember{m.workspaceVersion};var code by remember{mutableStateOf("")};var notice by remember{mutableStateOf("")};var proposed by remember{mutableStateOf<LiveCommand?>(null)};var verified by remember{mutableStateOf(false)};var issuing by remember{mutableStateOf(false)}
 LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||version!=m.workspaceVersion){proposed=null;close()}}
 if(access!=m.priorityAccessKey||version!=m.workspaceVersion)return
 fun propose(work:()->LiveCommand){try{proposed=work();verified=false;notice=""}catch(e:Exception){notice=e.message?:"请核对权益和原桌次"}}
 val scan=rememberLauncherForActivityResult(ScanContract()){result->result.contents?.let{if(access==m.priorityAccessKey&&version==m.workspaceVersion)try{require(it.startsWith("MBOX_MEMBER_V1:",true)){"请扫描会员码"};code=MemberCommands.code(it)}catch(e:Exception){notice=e.message.orEmpty()}}}
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
  item{Row{Text("会员权益钱包",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};LivePendingView(m);Text(m.benefitWalletState);if(notice.isNotBlank())Text(notice,color=MaterialTheme.colorScheme.error)
   CustodyField("会员号或会员码",code,150){code=it};SecondaryAction(onClick={scan.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("扫描顾客会员码").setBeepEnabled(false))},enabled=!m.busy){Text("扫描会员码")}
   PrimaryAction(onClick={try{val read=MemberCommands.code(code);issuing=false;m.loadBenefitWallet(read,"")}catch(e:Exception){notice=e.message.orEmpty()}},enabled=!m.busy&&code.isNotBlank()){Text("查询会员权益")}
  }
  m.benefitWalletBoard?.let{board->
   item{Text("${board.data.getString("memberNo")} · ${board.data.textOrNull("displayName")?:"会员"}",style=MaterialTheme.typography.titleMedium);Text("以下为已查询会员的真实权益。金额/折扣权益核销只登记权益使用，不会自动减免订单或退款；固定低价券需按原订单报价办理。")
    if(m.identity?.allows("benefit.issue")==true)SecondaryAction(onClick={issuing=!issuing},enabled=m.canUseBenefitWallet){Text(if(issuing)"收起发放表单" else "按岗位额度发放权益")}
   }
   if(issuing)item{key(board.customer){WalletIssueForm(m,board,::propose)}}
   for(row in board.rows)item{key(row.getString("id"),row.getInt("version")){WalletBenefitCard(m,board,row,::propose)}}
   if(board.rows.isEmpty())item{Text("当前页没有权益记录")}
   item{Row{TextButton(onClick={m.loadBenefitWallet(board.data.getString("memberNo"),"")},enabled=!m.busy){Text("回到最新")};board.data.textOrNull("nextCursor")?.let{cursor->TextButton(onClick={m.loadBenefitWallet(board.data.getString("memberNo"),cursor)},enabled=!m.busy){Text("下一页历史")}}}}
  }
 }}}
 proposed?.let{command->AlertDialog(onDismissRequest={proposed=null},title={Text(command.title)},text={Column{Text(command.steps[0].benefitWalletProof!!.getString("confirmation"));Row{Checkbox(verified,{verified=it});Text("已当面核对会员、权益及本次办理内容")}}},confirmButton={TextButton(onClick={proposed=null;issuing=false;m.executeLive(command)},enabled=verified&&m.canExecuteLive(command)){Text("确认办理")}},dismissButton={TextButton(onClick={proposed=null}){Text("返回核对")}})}
}
@Composable private fun WalletBenefitCard(m:AppModel,board:BenefitWalletBoard,row:JSONObject,propose:(()->LiveCommand)->Unit){
 var table by remember{mutableStateOf("")};var quantity by remember{mutableStateOf("1")};val actor=m.identity?:return
 fun base()=JSONObject().put("customerId",board.customer).put("benefitId",row.getString("id"))
 Panel{Text(row.getString("title"),style=MaterialTheme.typography.titleMedium);Text("${walletTypeNames[row.getString("type")]} · ${walletStateNames[row.getString("state")]}");Text("可用 ${row.getInt("quantityAvailable")} · 暂留 ${row.getInt("quantityReserved")} · 已用 ${row.getInt("quantityRedeemed")} / 共 ${row.getInt("quantityTotal")}")
  Text("生效 ${assignmentTime(row.getString("validFrom"))} · ${row.textOrNull("validUntil")?.let{"到期 "+assignmentTime(it)}?:"未设置结束日期"}");row.optJSONObject("calendar")?.let{c->c.textOrNull("nextAvailableAt")?.let{Text("下次可用 ${assignmentTime(it)}")}}
  val lowPrice=row.optJSONObject("pricePromise")!=null||row.optBoolean("snackClaim")
  if(lowPrice)Text(if(row.optBoolean("snackClaim"))"每日点心请在专用核销码入口办理。" else "此券绑定原固定价报价，不能直接按赠品核销。")
  if(!lowPrice&&row.getString("state")=="available"&&actor.allows("loyalty.redemption.fulfill")){
   if(board.tables.isEmpty())Text("会员尚未关联可操作的在用桌次；请先在桌边完成本人入座。") else{
    AssignmentChoice("会员当前所在桌",table,listOf("" to "请选择实际桌号")+board.tables.map{it.getString("id") to it.getString("code")}){table=it};CustodyField("本次暂留份数",quantity,3){quantity=it}
    SecondaryAction(onClick={propose{val q=quantity.toIntOrNull()?:error("请填写整数份数");val body=base().put("tableSessionId",table).put("quantity",q).put("expectedVersion",row.getInt("version"));benefitWalletCommand(actor,board,"reserve",body,"暂留会员权益\n${board.data.getString("memberNo")} · ${row.getString("title")}\n桌号 ${board.tables.find{it.getString("id")==table}?.getString("code")} · $q 份\n暂留10分钟，之后仍须核销；暂留不代表已交付。")}},enabled=m.canUseBenefitWallet){Text("核对并暂留")}
   }
  }
  for(hold in row.getJSONArray("reservations").objects())key(hold.getString("id")){
   var product by remember{mutableStateOf("")};var reason by remember{mutableStateOf("")}
   Text("原暂留 · ${hold.getString("tableCode")} / ${hold.getInt("quantity")}份 · 至${assignmentTime(hold.getString("expiresAt"))}")
   if(row.getString("type")=="gift_product")AssignmentChoice("实际兑付商品",product,listOf("" to "请选择商品")+row.getJSONArray("products").objects().filter{it.getString("status")=="active"}.map{it.getString("id") to it.getString("name")}){product=it}
   CustodyField("核销说明 / 替换或取消原因",reason,256){reason=it}
   fun body()=base().put("reservationId",hold.getString("id")).put("tableSessionId",hold.getString("tableSessionId")).put("quantity",hold.getInt("quantity"))
   if(actor.allows("loyalty.redemption.fulfill")&&!lowPrice)PrimaryAction(onClick={propose{val input=body();if(product.isNotBlank())input.put("selectedProductId",product);if(reason.isNotBlank())input.put("substitutionReason",reason.trim());benefitWalletCommand(actor,board,"redeem",input,"核销原暂留\n${board.data.getString("memberNo")} · ${row.getString("title")}\n${hold.getString("tableCode")} · ${hold.getInt("quantity")}份\n${row.getJSONArray("products").objects().find{it.getString("id")==product}?.getString("name")?:"按原权益登记"}\n赠品核销后继续完成出品、送达；本次不执行退款或订单减款。")}},enabled=m.canUseBenefitWallet&&hold.getBoolean("canRedeem")){Text(if(hold.getBoolean("canRedeem"))"核对并核销" else "暂留已过期，请取消释放")}
   if(actor.allows("benefit.cancel"))SecondaryAction(onClick={propose{benefitWalletCommand(actor,board,"cancel",body().put("reason",reason.trim()),"取消原暂留\n${row.getString("title")} · ${hold.getString("tableCode")} / ${hold.getInt("quantity")}份\n${reason.trim()}\n只释放未核销暂留，不撤回已送达商品。")}},enabled=m.canUseBenefitWallet){Text("取消原暂留")}
  }
 }
}
@Composable private fun WalletIssueForm(m:AppModel,board:BenefitWalletBoard,propose:(()->LiveCommand)->Unit){
 var title by remember{mutableStateOf("")};var code by remember{mutableStateOf("")};var type by remember{mutableStateOf("gift_product")};var amount by remember{mutableStateOf("")};var count by remember{mutableStateOf("1")};var limit by remember{mutableStateOf("")};var from by remember{mutableStateOf("")};var until by remember{mutableStateOf("")};var reason by remember{mutableStateOf("")};var search by remember{mutableStateOf("")};var applied by remember{mutableStateOf("")};var products by remember{mutableStateOf<List<JSONObject>>(emptyList())};var selected by remember{mutableStateOf<Map<String,String>>(emptyMap())};var next by remember{mutableStateOf<Int?>(null)};var error by remember{mutableStateOf("")};val scope=rememberCoroutineScope()
 fun load(offset:Int){scope.launch{try{val query=if(offset==0)search else applied;val data=m.walletProducts(query,offset);if(offset==0)applied=query;products=data.getJSONArray("items").objects();next=if(data.isNull("nextOffset"))null else data.getInt("nextOffset");error=""}catch(e:Exception){error=e.message.orEmpty()}}}
 Panel{Text("授权发放权益",style=MaterialTheme.typography.titleMedium);CustodyField("权益名称",title,100){title=it};CustodyField("权益编码",code,64){code=it};AssignmentChoice("权益类型",type,walletTypeNames.toList()){type=it};CustodyField("每份授权价值（元）",amount,12){amount=it};CustodyField("发放份数",count,5){count=it}
  Text("填写实际授权价值用于额度校验，不是收款金额。折扣与金额权益仍须按原订单政策使用。")
  AssignmentChoice("当前岗位额度",limit,listOf("" to "请选择额度")+board.limits.map{it.getString("id") to (it.getString("name")+" · "+(it.textOrNull("amountMinor")?.toLong()?.let(::loyaltyRefundMoney)?:"未设金额上限"))}){limit=it}
  CustodyField("生效时间（北京时间 YYYY-MM-DD HH:mm）",from,19){from=it};CustodyField("结束时间（可留空，北京时间）",until,19){until=it};CustodyField("实际发放原因",reason,256){reason=it}
  if(type=="gift_product"){
   Text("允许兑付的实际商品：${selected.values.joinToString("、").ifBlank{"未选择"}}");CustodyField("搜索可用商品",search,100){search=it};SecondaryAction(onClick={load(0)},enabled=!m.busy){Text("读取商品")}
   for(p in products)Row{Checkbox(selected.containsKey(p.getString("id")),{checked->selected=if(checked)selected+(p.getString("id") to p.getString("name")) else selected-p.getString("id")});Text(p.getString("name"))};next?.let{TextButton(onClick={load(it)},enabled=!m.busy){Text("更多商品")}}
  }
  if(error.isNotBlank())Text(error,color=MaterialTheme.colorScheme.error)
  PrimaryAction(onClick={propose{val money=ownerMoney(amount);val body=JSONObject().put("customerId",board.customer).put("title",title.trim()).put("benefitCode",code.trim()).put("benefitType",type).put("valueAmountMinor",money).put("quantity",count.toIntOrNull()?:error("请填写整数份数")).put("authorizationLimitId",limit).put("allowedProductIds",JSONArray(if(type=="gift_product")selected.keys.toList() else emptyList<String>())).put("validFrom",membershipDate(from)).put("validUntil",if(until.isBlank())JSONObject.NULL else membershipDate(until)).put("reason",reason.trim());benefitWalletCommand(m.identity!!,board,"issue",body,"发放会员权益\n${board.data.getString("memberNo")} · ${title.trim()}\n${walletTypeNames[type]} / $count 份 / 每份${loyaltyRefundMoney(money)}\n商品：${if(type=="gift_product")selected.values.joinToString("、") else "按原权益使用规则"}\n${reason.trim()}\n确认后发放，不代表已核销或交付。")}},enabled=m.canUseBenefitWallet){Text("核对额度后发放")}
 }
}
