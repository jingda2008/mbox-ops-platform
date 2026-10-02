package com.mbox.staff
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.json.JSONArray
private val refundCouponActions=listOf("no_return" to "按原规则不返券","external_compensation" to "已完成线下补偿","replacement_coupon" to "关联已发出的补偿券")
@Composable fun LiveCouponRefundsView(m:AppModel,close:()->Unit){
 val access=remember{m.priorityAccessKey};val workspace=remember{m.workspaceVersion};var state by remember{mutableStateOf("refund-pending")};var selected by remember{mutableStateOf<JSONObject?>(null)};var proposed by remember{mutableStateOf<LiveCommand?>(null)};var error by remember{mutableStateOf("")}
 LaunchedEffect(Unit){m.loadMemberGifts(state)};LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||workspace!=m.workspaceVersion)close()};if(access!=m.priorityAccessKey||workspace!=m.workspaceVersion)return
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
 item{Row{Text("退款后的券权益复核",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};LivePendingView(m);Text(m.memberGiftsState);Text("退款不自动返券。此处登记已确认的处理结果；补发须先通过已审批的赠礼活动，再关联同一会员的新券。");if(error.isNotBlank())Text(error,color=MaterialTheme.colorScheme.error)}
 if(selected!=null)item{key(selected!!.getString("id")){CouponRefundEditor(m,selected!!,{selected=null}){body->try{val board=m.memberGiftsBoard?:error("请刷新待复核权益");proposed=memberGiftCommand(m.identity!!,MemberGiftsBoard(JSONObject(board.data.toString()).put("rows",JSONArray(m.memberGiftRows))),"refund",body,"订单 ${selected!!.getString("order_reference")}\n${refundCouponActions.toMap()[body.getString("action")]}\n凭证：${body.getString("evidenceReference")}\n只记录权益结论，不退款、不发券、不改库存。");error=""}catch(e:Exception){error=e.message?:"请核对输入"}}}}
 else{
 item{AssignmentChoice("查看",state,listOf("refund-pending" to "待复核","refund-resolved" to "已处理")){if(m.loadMemberGifts(it))state=it};TextButton(onClick={m.loadMemberGifts(state)},enabled=!m.busy){Text("刷新")}}
 items(m.memberGiftRows.filter{it.has("refund_id")},key={it.getString("id")}){row->Panel{CouponRefundSummary(row);if(row.textOrNull("action")!=null){Text("处理结果：${refundCouponActions.toMap()[row.getString("action")]?:"待核对"}");Text("原因：${row.getString("reason")}\n凭证：${row.getString("evidence_reference")}");row.textOrNull("replacement_quantity")?.let{Text("关联补偿券 $it 份")}}else if(m.identity?.allows("loyalty.policy.publish")==true)SecondaryAction(onClick={selected=row},enabled=m.canUseMemberGifts){Text("复核此权益")}}}
 if(m.memberGiftsBoard?.next!=null)item{SecondaryAction(onClick={m.loadMoreMemberGifts()},enabled=!m.busy){Text("加载后续权益")}};if(m.memberGiftsBoard!=null&&m.memberGiftRows.isEmpty())item{Text("当前范围没有记录")}
 }
 }}}
 proposed?.let{c->AlertDialog(onDismissRequest={proposed=null},title={Text("确认券权益处理")},text={Text(c.steps[0].memberGiftProof!!.getString("confirmation"))},confirmButton={TextButton(onClick={proposed=null;selected=null;m.executeLive(c)},enabled=m.canExecuteLive(c)){Text("确认登记")}},dismissButton={TextButton(onClick={proposed=null}){Text("返回核对")}})}
}
@Composable private fun CouponRefundSummary(row:JSONObject){Text("${row.getString("benefit_code")} · ${row.getInt("quantity")}份",style=MaterialTheme.typography.titleMedium);Text("订单 ${row.getString("order_reference")}\n退款单 ${row.getString("refund_reference")}");Text("本笔订单退款 ¥${java.math.BigDecimal(row.getString("refund_amount_minor")).movePointLeft(2)} ${row.getString("currency")}，不是每张券的补偿金额。");Text("券状态："+when(row.getString("status")){"reserved"->"订单占用中";"redeemed"->"已核销";else->"已释放或到期"})}
@Composable private fun CouponRefundEditor(m:AppModel,row:JSONObject,back:()->Unit,submit:(JSONObject)->Unit){
 var action by remember{mutableStateOf("")};var reason by remember{mutableStateOf("")};var evidence by remember{mutableStateOf("")};var replacement by remember{mutableStateOf("")};var rows by remember{mutableStateOf<List<JSONObject>>(emptyList())};var next by remember{mutableStateOf<String?>(null)};var loading by remember{mutableStateOf(false)};var loaded by remember{mutableStateOf(false)};var error by remember{mutableStateOf("")};val scope=rememberCoroutineScope()
 fun load(more:Boolean=false){if(loading)return;loading=true;scope.launch{try{val b=m.couponRefundOptions(row.getString("refund_id"),row.getString("reservation_id"),if(more)next else null);rows=(if(more)rows+b.rows else b.rows).distinctBy{it.getString("id")};if(!more)replacement="";next=b.next;loaded=true;error=""}catch(e:Exception){error=e.message?:"查询失败，不能判定没有补偿券"}finally{loading=false}}}
 Panel{TextButton(onClick=back){Text("返回列表")};CouponRefundSummary(row);AssignmentChoice("选择已确认的处理方式",action,listOf("" to "请选择")+refundCouponActions){action=it};if(action=="replacement_coupon"){Text("仅可关联退款申请之后，已发给同一会员、尚未使用且未用于其他复核的券；选择后仍会核对最新状态。");TextButton(onClick={load()},enabled=!loading&&!m.busy){Text(if(loading)"读取中"else "读取本人可关联的新券")};for(option in rows)Row{RadioButton(replacement==option.getString("id"),onClick={replacement=option.getString("id")});Column{Text("${option.getString("benefit_code")} · ${option.getInt("quantity_total")}份");Text("有效至 "+(option.textOrNull("valid_until")?.let(::calendarLocal)?:"长期"))}};if(next!=null)TextButton(onClick={load(true)},enabled=!loading&&!m.busy){Text("加载更多本人新券")};if(loaded&&rows.isEmpty())Text("未找到可关联的新券；如需补偿，先完成已审批活动的实际发放。")};CustodyField("权益处理原因",reason,500){reason=it};CustodyField("原规则或实际补偿凭证",evidence,200){evidence=it};if(error.isNotBlank())Text(error,color=MaterialTheme.colorScheme.error);PrimaryAction(onClick={val body=JSONObject().put("refundId",row.getString("refund_id")).put("reservationId",row.getString("reservation_id")).put("expectedVersion",row.getString("nativeVersion")).put("action",action).put("reason",reason.trim()).put("evidenceReference",evidence.trim());if(action=="replacement_coupon")body.put("replacementBenefitId",replacement);submit(body)},enabled=m.canUseMemberGifts&&!loading&&action.isNotBlank()&&reason.trim().length>=2&&evidence.trim().length>=2&&(action!="replacement_coupon"||replacement.isNotBlank())){Text("核对并登记结果")}}
}
