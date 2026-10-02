package com.mbox.staff
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import org.json.JSONObject
import org.json.JSONArray

@Composable
fun MembershipFields(content:JSONObject,references:List<JSONObject>,enabled:Boolean,onChange:(JSONObject)->Unit){
 val domain=content.optString("domain","")
 fun change(key:String,value:Any){onChange(JSONObject(content.toString()).put(key,value))}
 for(key in content.keys().asSequence().toList()){
  if(key in setOf("domain","publicId","currency"))continue
  val value=content.get(key);val label=membershipFieldLabels[key]?:key;val raw=if(value==JSONObject.NULL)"" else value.toString()
  when{
   key=="eligibleMemberLevels"->{Text(label);for((id,name) in membershipFieldChoices.getValue("eligibleTier")){val arr=value as JSONArray;val chosen=(0 until arr.length()).map{arr.getString(it)};Row{Checkbox(checked=id in chosen,onCheckedChange={change(key,JSONArray(if(it)chosen+id else chosen-id))},enabled=enabled);Text(name)}}}
   value is JSONArray->{
    Text("$label · ${value.length()}项")
    for(i in 0 until value.length())key("$key-$i"){
     var expanded by remember{mutableStateOf(false)};val row=value.getJSONObject(i)
     TextButton(onClick={expanded=!expanded}){Text("${i+1}. ${row.optString("name",row.optString("ruleCode","")).ifBlank{"待填写"}} · ${if(expanded)"收起" else "展开"}")}
     if(expanded){MembershipFields(row,references,enabled){replacement->val rows=JSONArray(value.toString());rows.put(i,replacement);change(key,rows)};TextButton(onClick={change(key,JSONArray((0 until value.length()).filter{it!=i}.map{value.get(it)}))},enabled=enabled){Text("移除第${i+1}项草稿")}}
    }
    if(domain in setOf("tier_benefits","promotion_points","redemption_catalog"))SecondaryAction(onClick={val rows=JSONArray(value.toString());rows.put(membershipEditingContent(newMembershipItem(domain)));change(key,rows)},enabled=enabled&&value.length()<200){Text("添加${if(key=="items")"兑换项" else "规则"}")}
   }
   value is Boolean->{Row{Checkbox(checked=value,onCheckedChange={change(key,it)},enabled=enabled);Text(label)}}
   key in membershipReferenceFields->{
    val refs=references.filter{it.getString("kind")==key};val choices=refs.map{it.getString("id") to "${it.getString("name")}（${it.getString("status")}）"}.toMutableList()
    if(key!="tierPolicyVersionId")choices.add(0,"" to "未关联")
    if(raw.isNotBlank()&&refs.none{it.getString("id")==raw}){choices.add(raw to "原关联已不可选，请核对");Text("$label：原关联当前不可用")}
    if(enabled)AssignmentChoice(label,raw,choices){change(key,it)}else Text("$label：${choices.firstOrNull{it.first==raw}?.second?:"未关联"}")
   }
   membershipFieldChoices.containsKey(key)->{val choices=membershipFieldChoices.getValue(key);if(enabled)AssignmentChoice(label,raw,choices){change(key,it)}else Text("$label：${choices.firstOrNull{it.first==raw}?.second?:"状态待核对"}")}
   else->{val suffix=when{key in setOf("availableFrom","availableUntil")->"（北京时间 YYYY-MM-DD HH:mm:ss）";key in setOf("totalInventory","dailyInventory","memberLifetimeLimit")->"（留空不限，0表示零库存）";key in membershipNullableText||key=="expiryLeadDays"->"（可留空）";else->""};OutlinedTextField(value=raw,onValueChange={if(it.length<=if(key=="content")50000 else if(key=="summary")2000 else 500)change(key,it)},label={Text(label+suffix)},enabled=enabled,modifier=androidx.compose.ui.Modifier.fillMaxWidth(),minLines=if(key in setOf("content","summary"))3 else 1)}
  }
 }
}
