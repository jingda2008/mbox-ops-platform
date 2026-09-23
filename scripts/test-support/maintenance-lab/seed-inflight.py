import pathlib,subprocess,json,uuid,os
P=pathlib.Path;root=P('/opt/mbox');state=json.loads((root/'lab-state.json').read_text());tenant=state['scope']['tenantId'];store=state['scope']['storeId'];ids={k:str(uuid.uuid4()) for k in ('session','order','item','payment')}
os.environ.update({'PGSERVICEFILE':'/opt/mbox/secrets/pg_service.conf','PGPASSFILE':'/opt/mbox/secrets/pgpass'})
q="""BEGIN;
SELECT set_config('mbox.tenant_id','%s',true),set_config('mbox.store_id','%s',true);
INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status)
SELECT '%s','%s','%s',id,'lab-original-session',CURRENT_DATE,2,'open' FROM mbox.tables WHERE tenant_id='%s' AND store_id='%s' LIMIT 1;
INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,subtotal_amount_minor,discount_amount_minor,total_amount_minor,currency)
VALUES('%s','%s','%s','%s','lab-original-order','staff_assisted','submitted',100,0,100,'CNY');
INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,discount_amount_minor,total_amount_minor,currency,fulfillment_station,product_snapshot,status)
SELECT '%s','%s','%s','%s',id,1,100,0,100,'CNY','bar','{"name":"Synthetic lab item","inventoryTrackingEnabled":false}','delivered' FROM mbox.products WHERE tenant_id='%s' AND store_id='%s' LIMIT 1;
INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,currency,status)
VALUES('%s','%s','%s','%s','lab-original-payment','postar','jsapi',100,'CNY','pending');
INSERT INTO mbox.payment_reconciliation_states(payment_id,tenant_id,store_id,phase,automatic_query_stopped_at,stop_reason,next_query_at,lease_until)
VALUES('%s','%s','%s','stopped',clock_timestamp(),'finance_review_required',NULL,NULL);
COMMIT;
"""%(tenant,store,ids['session'],tenant,store,tenant,store,ids['order'],tenant,store,ids['session'],ids['item'],tenant,store,ids['order'],tenant,store,ids['payment'],tenant,store,ids['order'],ids['payment'],tenant,store)
r=subprocess.run(['psql','-XAt','--dbname=service=migration','-v','ON_ERROR_STOP=1'],input=q,text=True,capture_output=True)
if r.returncode:raise RuntimeError(r.stderr)
(root/'lab-inflight-identities.json').write_text(json.dumps(ids));print(json.dumps({'localOnly':True,'originalIds':ids,'paymentPublicId':'lab-original-payment','state':'pending with exact stopped finance_review_required; no provider submission authorized'}))

# Extra original facts for the forward-recovery scenario only: a settled order
# with two synthetic system attempts, one with an unknown provider action.
import sys
if len(sys.argv)>1 and sys.argv[1]=='forward':
 h={k:str(uuid.uuid4()) for k in ('table','session','order','receipt','attempt1','attempt2')}
 q="""BEGIN;
 SELECT set_config('app.tenant_id','{t}',true),set_config('app.store_id','{s}',true);
 INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
 SELECT '{table}','{t}','{s}',area_id,'LAB-HIST','Historical fixture',4 FROM mbox.tables WHERE tenant_id='{t}' AND store_id='{s}' LIMIT 1;
 INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status)
 VALUES('{session}','{t}','{s}','{table}','lab-settled-session',CURRENT_DATE,2,'open');
 INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,subtotal_amount_minor,total_amount_minor,currency)
 VALUES('{order}','{t}','{s}','{session}','lab-settled-order','staff_assisted','submitted','paid',100,100,'CNY');
 INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,method,amount_minor,currency,status,succeeded_at)
 VALUES('{receipt}','{t}','{s}','{order}','lab-correct-receipt','cash','lab-correct-cash','cash',100,'CNY','succeeded',clock_timestamp());
 INSERT INTO mbox.reconciliation_entries(tenant_id,store_id,payment_id,entry_type,provider,provider_reference,amount_minor,currency,business_date,occurred_at)
 VALUES('{t}','{s}','{receipt}','payment','cash','lab-correct-cash',100,'CNY',CURRENT_DATE,clock_timestamp());
 INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,currency,status)
 VALUES('{attempt1}','{t}','{s}','{order}','lab-duplicate-attempt-one','postar','native_qr',100,'CNY','pending'),
 ('{attempt2}','{t}','{s}','{order}','lab-duplicate-attempt-two','postar','native_qr',100,'CNY','pending');
 INSERT INTO mbox.payment_reconciliation_states(payment_id,tenant_id,store_id,phase,automatic_query_stopped_at,stop_reason)
 VALUES('{attempt1}','{t}','{s}','stopped',clock_timestamp(),'finance_review_required'),('{attempt2}','{t}','{s}','stopped',clock_timestamp(),'finance_review_required');
 INSERT INTO mbox.payment_provider_actions(payment_id,tenant_id,store_id,presentation,initiated_by_type,initiated_by_ref,state,expires_at)
 SELECT '{attempt1}','{t}','{s}','qr','employee',id,'unknown',clock_timestamp()-interval '1 day' FROM mbox.employees WHERE tenant_id='{t}' AND store_id='{s}' LIMIT 1;
 UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp() WHERE id='{session}';
 COMMIT;""".format(t=tenant,s=store,**h)
 r=subprocess.run(['psql','-XqAt','--dbname=service=migration','-v','ON_ERROR_STOP=1'],input=q,text=True,capture_output=True)
 if r.returncode:raise RuntimeError(r.stderr)
 h.update(tenant_id=tenant,store_id=store)
 (root/'lab-historical-attempts.json').write_text(json.dumps(h))
