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
