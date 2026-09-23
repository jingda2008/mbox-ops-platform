#!/usr/bin/env python3
"""Planned, fail-closed maintenance transition. Invoked only by activate-release.
Credentials remain in protected files. This program never starts sourceLive,
never restores a database, and never clears an epoch or an unfinished journal.
"""
import argparse, configparser, fcntl, hashlib, hmac, json, os, re, secrets, shutil, signal, stat, subprocess, sys, time, urllib.request, urllib.error
from pathlib import Path

class Blocked(RuntimeError): pass

def require(value, message):
    if not value: raise Blocked(message)

def canonical(value): return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def systemd_inventory_sha256(output):
    # systemd 219 includes PAM login scopes in list-unit-files. Each new SSH
    # connection gets another numeric session id; these cannot restart a writer.
    # Keep every other row byte-exact, including persistent units and states.
    rows=[row for row in output.splitlines() if not re.fullmatch(r'session-[0-9]+\.scope\s+static\s*',row)]
    return hashlib.sha256('\n'.join(rows).encode()).hexdigest()

def atomic(path, value):
    path=Path(path); path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    temporary=path.with_name(path.name+'.next-'+secrets.token_hex(6))
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try: os.write(fd,canonical(value)+b'\n'); os.fsync(fd)
    finally: os.close(fd)
    os.replace(temporary,path)
    fd=os.open(path.parent,os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)

def protected(path):
    path=Path(path); s=path.lstat()
    require(stat.S_ISREG(s.st_mode) and not path.is_symlink() and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o600, 'protected root:0600 file required: '+str(path))
    return path

def env_file(path):
    values={}
    for line in Path(path).read_text().splitlines():
        if not line.strip() or line.startswith('#'): continue
        key, sep, value=line.partition('=')
        require(sep and re.fullmatch('[A-Z][A-Z0-9_]*',key) and key not in values, 'invalid environment file')
        values[key]=value
    return values

def read_verified_journal(path):
    records=[json.loads(line) for line in protected(path).read_text().splitlines()]
    require(records,'empty maintenance journal')
    previous='0'*64
    for index,row in enumerate(records):
        body={key:value for key,value in row.items() if key!='hash'}
        require(row.get('sequence')==index and row.get('previous')==previous and isinstance(row.get('event'),str) and hashlib.sha256(canonical(body)).hexdigest()==row.get('hash'),'maintenance journal corruption')
        previous=row['hash']
    return records

def verified_migration_files(manifest):
    migration=manifest.get('migration',{}); files=migration.get('files')
    require(isinstance(files,list) and files and type(migration.get('count')) is int and migration['count']==len(files),'invalid migration manifest count')
    digest=hashlib.sha256()
    for index,row in enumerate(files,1):
        require(isinstance(row,dict) and set(row)=={'filename','sha256'},'invalid migration manifest entry')
        require(isinstance(row['filename'],str) and re.fullmatch(r'%03d_[a-z0-9_]+\.sql'%index,row['filename']) and isinstance(row['sha256'],str) and re.fullmatch('[0-9a-f]{64}',row['sha256']),'invalid migration manifest sequence')
        digest.update((row['filename']+'\0'+row['sha256']+'\n').encode())
    require(migration.get('digest')=='sha256:'+digest.hexdigest(),'migration manifest digest mismatch')
    return files

def verify_ordinary_migration_ancestry(baseline,current,candidate,snapshot):
    # Exact immutable ancestry, not schema >= baseline. This also admits a
    # compatible app rollback after a transactional ordinary migration: every
    # applied file still has to belong to the verified incoming artifact.
    base=verified_migration_files(baseline); live=verified_migration_files(current); target=verified_migration_files(candidate)
    require(len(base)<=len(live)<=len(target) and base==live[:len(base)] and live==target[:len(live)],'ordinary release changed historical migrations')
    applied=snapshot.get('applied'); version=snapshot.get('schemaVersion')
    require(snapshot.get('schemaFlavor')=='normalized-core-v1' and isinstance(applied,list) and isinstance(version,str) and re.fullmatch('[0-9]+',version),'invalid live migration metadata')
    require(len(live)<=len(applied)<=len(target) and int(version)==len(applied),'ordinary live schema has no exact artifact ancestry')
    for index,row in enumerate(applied):
        require(row=={'version':'%03d'%(index+1),'filename':target[index]['filename'],'checksum':target[index]['sha256']},'ordinary applied migration checksum mismatch')
    return int(version)

class Journal:
    def __init__(self, directory, binding, recovery_from=None):
        self.directory=Path(directory); self.directory.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.path=self.directory/'journal.jsonl'; self.binding=binding
        self.records=[]; previous='0'*64
        if self.path.exists():
            for line in self.path.read_bytes().splitlines():
                row=json.loads(line); digest=row.pop('hash')
                require(row['previous']==previous and hashlib.sha256(canonical(row)).hexdigest()==digest, 'journal corruption; preserve maintenance')
                row['hash']=digest; self.records.append(row); previous=digest
            latest=next(x['data'] for x in reversed(self.records) if x['event'] in ('bound','forward-target'))
            if latest != binding:
                require(self.records[-1]['event']!='completed','completed transition cannot be rebound')
                require(recovery_from==previous and latest['sourceLive']==binding['sourceLive'] and int(binding['forwardRecoveryTarget']['schema'])>=int(latest['forwardRecoveryTarget']['schema']), 'journal binding mismatch; exact forward recovery hash required')
                self.append('forward-target',binding)
        else: self.append('bound',binding)
    def append(self,event,data=None):
        lock=os.open(self.directory/'journal.lock',os.O_CREAT|os.O_RDWR,0o600)
        fcntl.flock(lock,fcntl.LOCK_EX)
        try: self._append(event,data)
        finally: os.close(lock)
    def _append(self,event,data=None):
        row={'sequence':len(self.records),'at':time.time(),'event':event,'data':data or {},'previous':self.records[-1]['hash'] if self.records else '0'*64}
        row['hash']=hashlib.sha256(canonical(row)).hexdigest()
        fd=os.open(self.path,os.O_WRONLY|os.O_APPEND|os.O_CREAT,0o600)
        try: os.write(fd,canonical(row)+b'\n'); os.fsync(fd)
        finally: os.close(fd)
        fd=os.open(self.directory,os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)
        self.records.append(row)
    def has(self,event): return any(x['event']==event for x in self.records)
    def epoch(self,reason):
        path=self.directory/'business-write-epoch.json'
        if path.exists(): return
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        try: os.write(fd,canonical({'reason':reason,'at':time.time(),'binding':self.binding})+b'\n'); os.fsync(fd)
        finally: os.close(fd)
        fd=os.open(self.directory,os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)

# Historical holds are operator-reviewed associations, never terminal payment
# results. The original pre-drain baseline stays immutable. This separate proof
# is scope/ID/fingerprint-bound and is invalidated by any changed financial fact.
HISTORICAL_ATTEMPT_EVIDENCE_SQL = r'''
WITH links AS (
 SELECT f.id payment_id,f.tenant_id,f.store_id,f.order_id,f.amount_minor
 FROM mbox.order_payment_facts f WHERE f.status IN ('created','pending') AND f.provider IN ('postar','wechat')
), order_facts AS (
 SELECT o.id,o.tenant_id,o.store_id,
   jsonb_build_object('order',jsonb_build_object('id',o.id,'publicId',o.public_id,'status',o.status,
     'paymentStatus',o.payment_status,'totalMinor',o.total_amount_minor,'currency',o.currency),
     'session',jsonb_build_object('id',v.id,'status',v.status),
     'dueMinor',mbox.order_collection_due_amount(o.tenant_id,o.store_id,o.id),
     'receipts',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'publicId',p.public_id,
       'amountMinor',f.amount_minor,'totalReceiptMinor',p.amount_minor,'currency',p.currency,
       'provider',p.provider,'reference',p.provider_transaction_id,'status',p.status,
       'ledger',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'entryType',e.entry_type,'amountMinor',e.amount_minor,'currency',e.currency,'reference',e.provider_reference,'factsSha256',encode(sha256(convert_to(to_jsonb(e)::text,'UTF8')),'hex')) ORDER BY e.id) FROM mbox.reconciliation_entries e
          WHERE (e.tenant_id,e.store_id,e.payment_id)=(p.tenant_id,p.store_id,p.id)),'[]'::jsonb)) ORDER BY p.id)
       FROM mbox.order_payment_facts f JOIN mbox.payments p ON (p.tenant_id,p.store_id,p.id)=(f.tenant_id,f.store_id,f.id)
       WHERE (f.tenant_id,f.store_id,f.order_id)=(o.tenant_id,o.store_id,o.id)
         AND f.status IN ('succeeded','partially_refunded','refunded')),'[]'::jsonb),
     'refunds',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'paymentId',r.payment_id,
       'amountMinor',r.amount_minor,'currency',r.currency,'status',r.status) ORDER BY r.id)
       FROM mbox.order_refund_facts r WHERE (r.tenant_id,r.store_id,r.order_id)=(o.tenant_id,o.store_id,o.id)),'[]'::jsonb)) AS facts,
   v.status='closed' AND o.status<>'draft' AND (o.status='cancelled' OR o.payment_status IN ('paid','partially_refunded','refunded'))
     AND mbox.order_collection_due_amount(o.tenant_id,o.store_id,o.id)=0
     AND NOT EXISTS (SELECT 1 FROM mbox.order_payment_facts f JOIN mbox.payments p
       ON (p.tenant_id,p.store_id,p.id)=(f.tenant_id,f.store_id,f.id)
       WHERE (f.tenant_id,f.store_id,f.order_id)=(o.tenant_id,o.store_id,o.id)
         AND f.status IN ('succeeded','partially_refunded','refunded') AND NOT EXISTS (
           SELECT 1 FROM mbox.reconciliation_entries e WHERE (e.tenant_id,e.store_id,e.payment_id)=(p.tenant_id,p.store_id,p.id)
             AND e.entry_type='payment' AND e.amount_minor=p.amount_minor AND e.currency=p.currency
             AND e.provider=p.provider AND e.provider_reference IS NOT DISTINCT FROM p.provider_transaction_id
             AND (SELECT count(*) FROM mbox.reconciliation_entries exact WHERE (exact.tenant_id,exact.store_id,exact.payment_id)=(p.tenant_id,p.store_id,p.id) AND exact.entry_type='payment')=1))
     AND NOT EXISTS (SELECT 1 FROM mbox.order_refund_facts r
       WHERE (r.tenant_id,r.store_id,r.order_id)=(o.tenant_id,o.store_id,o.id) AND r.status='succeeded'
         AND NOT EXISTS (SELECT 1 FROM mbox.reconciliation_entries e
           WHERE (e.tenant_id,e.store_id,e.refund_id)=(r.tenant_id,r.store_id,r.id)
             AND e.entry_type='refund' AND e.payment_id=r.payment_id AND e.amount_minor=-r.amount_minor
             AND e.currency=r.currency AND e.provider_reference=(SELECT original.provider_refund_id FROM mbox.refunds original
               WHERE (original.tenant_id,original.store_id,original.id)=(r.tenant_id,r.store_id,r.id))))
     AND NOT EXISTS (SELECT 1 FROM mbox.payment_financial_monitoring_signals f
       WHERE (f.tenant_id,f.store_id,f.subject_id)=(o.tenant_id,o.store_id,o.id)
         AND f.signal IN ('order_overcollected','cancelled_order_captured')) AS eligible
 FROM mbox.orders o JOIN mbox.table_sessions v ON (v.tenant_id,v.store_id,v.id)=(o.tenant_id,o.store_id,o.table_session_id)
 WHERE EXISTS (SELECT 1 FROM links l WHERE (l.tenant_id,l.store_id,l.order_id)=(o.tenant_id,o.store_id,o.id))
), evidence AS (
 SELECT p.id,p.tenant_id,p.store_id,
   jsonb_build_object('payment',jsonb_build_object('id',p.id,'publicId',p.public_id,'status',p.status,
     'provider',p.provider,'amountMinor',p.amount_minor,'currency',p.currency,
     'factsSha256',encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),
     'allocations',jsonb_agg(jsonb_build_object('orderId',l.order_id,'amountMinor',l.amount_minor) ORDER BY l.order_id),
     'orders',jsonb_agg(o.facts ORDER BY l.order_id)) AS facts,
   bool_and(o.eligible AND o.facts->'order'->>'currency'=p.currency AND l.amount_minor>0) AND sum(l.amount_minor)=p.amount_minor
     AND NOT EXISTS (SELECT 1 FROM mbox.payment_provider_actions a
       WHERE (a.tenant_id,a.store_id,a.payment_id)=(p.tenant_id,p.store_id,p.id) AND a.state='creating')
     AND NOT EXISTS (SELECT 1 FROM mbox.reconciliation_entries e
       WHERE (e.tenant_id,e.store_id,e.payment_id)=(p.tenant_id,p.store_id,p.id))
     AND NOT EXISTS (SELECT 1 FROM mbox.verified_provider_observations v
       WHERE (v.tenant_id,v.store_id,v.payment_id)=(p.tenant_id,p.store_id,p.id)
         AND v.observed_status IN ('payment_succeeded','payment_failed','payment_closed') AND v.consumed_at IS NULL) AS eligible
 FROM mbox.payments p JOIN links l ON (l.tenant_id,l.store_id,l.payment_id)=(p.tenant_id,p.store_id,p.id)
 JOIN order_facts o ON (o.tenant_id,o.store_id,o.id)=(l.tenant_id,l.store_id,l.order_id)
 GROUP BY p.id
)
SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'tenant_id',tenant_id,'store_id',store_id,
  'eligible',eligible,'fingerprint',encode(sha256(convert_to(facts::text,'UTF8')),'hex'),'facts',facts) ORDER BY tenant_id,store_id,id),'[]'::jsonb)
FROM evidence;
'''

def historical_review_sql(approved):
    require(isinstance(approved,list) and 0<len(approved)<=1000,'historical review requires explicit attempt identities')
    identities=[]
    for row in approved:
        require(all(isinstance(row.get(k),str) and re.fullmatch('[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',row[k]) for k in ('tenant_id','store_id','id')),'invalid historical review scope')
        identities.append("("+",".join("'"+row[k]+"'::uuid" for k in ('tenant_id','store_id','id'))+")")
    return HISTORICAL_ATTEMPT_EVIDENCE_SQL.replace("WHERE f.status IN", "WHERE (f.tenant_id,f.store_id,f.id) IN ("+",".join(identities)+") AND f.status IN",1)

def historical_review_matches(rows, evidence, approved):
    require(isinstance(approved,list) and 0<len(approved)<=1000,'historical review requires 1-1000 explicit attempts')
    expected={('payment',r['tenant_id'],r['store_id'],r['id']):r for r in approved}
    require(len(expected)==len(approved),'duplicate historical review identity')
    actual={('payment',r['tenant_id'],r['store_id'],r['id']):r for r in evidence}
    for key,entry in expected.items():
        require(all(re.fullmatch('[0-9a-f-]{36}',entry[k]) for k in ('tenant_id','store_id','id')),'invalid historical review identity')
        require(re.fullmatch('[0-9a-f]{64}',entry['fingerprint']) is not None,'invalid historical evidence fingerprint')
        require(key in actual and actual[key]['eligible'] is True and actual[key]['fingerprint']==entry['fingerprint'],
          'historical attempt association changed or is not eligible; retain maintenance')
    selected=[r for r in rows if r['kind'] in ('payment','provider_action') and ('payment',r['tenant_id'],r['store_id'],r['id']) in expected]
    require({('payment',r['tenant_id'],r['store_id'],r['id']) for r in selected}==set(expected),'historical review subject missing')
    return selected

FUNDS_CLASSIFICATION_SQL = r'''
-- Read-only classification proposal, verified against source schema 233.
-- Run inside a REPEATABLE READ READ ONLY transaction with an authorized audit
-- identity over ALL stores (or enumerate every scope; RLS-filtered empty is unsafe).
-- Pin session TimeZone=UTC and DateStyle=ISO,YMD for repeatable timestamp hashing.
-- This query does not authorize exclusions. Only matching IDs AND fingerprints
-- from an immutable, pre-migration/post-drain baseline may be excluded later.
-- No raw provider payload, employee/customer data or payment credentials leave SQL.
WITH payment_facts AS (
  SELECT p.*, to_jsonb(s) AS reconciliation_state, to_jsonb(a) AS action_state,
    s.phase AS reconciliation_phase, s.stop_reason, s.automatic_query_stopped_at,
    s.next_query_at, s.lease_until,
    COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id)
      FROM mbox.reconciliation_entries e WHERE e.tenant_id=p.tenant_id
        AND e.store_id=p.store_id AND e.payment_id=p.id), '[]'::jsonb) AS ledger_facts
  FROM mbox.payments p
  LEFT JOIN mbox.payment_reconciliation_states s ON s.tenant_id=p.tenant_id
    AND s.store_id=p.store_id AND s.payment_id=p.id
  LEFT JOIN mbox.payment_provider_actions a ON a.tenant_id=p.tenant_id
    AND a.store_id=p.store_id AND a.payment_id=p.id
  WHERE p.provider IN ('postar','wechat')
), classified AS (
  SELECT 'payment'::text AS kind,p.id,p.tenant_id,p.store_id,
    CASE WHEN p.provider='postar' AND p.reconciliation_phase='stopped'
       AND p.stop_reason='finance_review_required'
       AND p.automatic_query_stopped_at IS NOT NULL
       AND p.next_query_at IS NULL AND p.lease_until IS NULL
      THEN 'baseline_candidate:stopped_payment_finance_review'
      ELSE 'block:unresolved_payment' END AS classification,
    to_jsonb(p) AS protected_facts
  FROM payment_facts p WHERE p.status IN ('created','pending')
  UNION ALL
  SELECT 'refund',r.id,r.tenant_id,r.store_id,
    CASE
      WHEN r.provider_submission_state='not_started'
        AND r.merchant_refund_id IS NULL AND r.provider_submission_started_at IS NULL
        AND r.auto_execute_requested_at IS NULL
        AND (s.refund_id IS NULL OR (s.phase='stopped' AND s.lease_until IS NULL))
        THEN 'baseline_candidate:approved_or_processing_without_submit_intent'
      WHEN r.status='processing' AND r.provider_submission_state='manual_review'
        AND r.merchant_refund_id IS NULL AND r.provider_submission_started_at IS NULL
        AND r.auto_execute_requested_at IS NULL
        AND (s.refund_id IS NULL OR (s.phase='stopped' AND s.lease_until IS NULL))
        THEN 'baseline_candidate:legacy_refund_manual_review'
      WHEN r.status='processing' AND r.provider_submission_state='not_started'
        AND r.auto_execute_requested_at IS NOT NULL
        THEN 'block:durable_refund_first_submission_intent'
      WHEN r.provider_submission_state IN ('submitting','submitted')
        THEN 'block:refund_original_submission_unresolved'
      ELSE 'block:refund_requires_explicit_review' END,
    jsonb_build_object('refund',to_jsonb(r),'payment',to_jsonb(p),
      'reconciliation_state',to_jsonb(s),
      'items',COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id)
        FROM mbox.refund_items i WHERE i.tenant_id=r.tenant_id
          AND i.store_id=r.store_id AND i.refund_id=r.id),'[]'::jsonb))
  FROM mbox.refunds r JOIN mbox.payments p ON p.tenant_id=r.tenant_id
    AND p.store_id=r.store_id AND p.id=r.payment_id
  LEFT JOIN mbox.refund_reconciliation_states s ON s.tenant_id=r.tenant_id
    AND s.store_id=r.store_id AND s.refund_id=r.id
  WHERE r.status IN ('approved','processing')
  UNION ALL
  SELECT 'provider_action',a.payment_id,a.tenant_id,a.store_id,
    'block:payment_action_'||a.state,
    jsonb_build_object('action',to_jsonb(a),'payment',to_jsonb(p))
  FROM mbox.payment_provider_actions a JOIN mbox.payments p ON p.tenant_id=a.tenant_id
    AND p.store_id=a.store_id AND p.id=a.payment_id
  WHERE a.state IN ('creating','unknown')
  UNION ALL
  SELECT 'observation',o.id,o.tenant_id,o.store_id,
    CASE WHEN o.subject_kind='payment'
      AND o.observed_status IN ('payment_failed','payment_closed')
      AND o.provider=p.provider AND o.reported_amount_minor=p.amount_minor
      AND o.reported_currency=p.currency
      AND (p.provider_transaction_id IS NULL OR p.provider_transaction_id=o.provider_transaction_id)
      AND (o.settlement_channel IS NULL OR p.settlement_channel IS NULL
        OR o.settlement_channel=p.settlement_channel)
      AND (
        p.status IN ('failed','closed')
        OR (p.status IN ('succeeded','partially_refunded','refunded') AND
          (SELECT count(*) FROM mbox.reconciliation_entries e
            WHERE e.tenant_id=p.tenant_id AND e.store_id=p.store_id
              AND e.payment_id=p.id AND e.entry_type='payment')=1 AND EXISTS (
          SELECT 1 FROM mbox.reconciliation_entries e
            WHERE e.tenant_id=p.tenant_id AND e.store_id=p.store_id
              AND e.payment_id=p.id AND e.entry_type='payment'
              AND e.provider=p.provider AND e.provider_reference=p.provider_transaction_id
              AND e.amount_minor=p.amount_minor AND e.currency=p.currency))
      ) THEN 'baseline_candidate:inert_terminal_payment_failure_observation'
      ELSE 'block:unconsumed_terminal_observation' END,
    jsonb_build_object('observation',to_jsonb(o),'payment',to_jsonb(p),'refund',to_jsonb(r))
  FROM mbox.verified_provider_observations o
  LEFT JOIN payment_facts p ON p.tenant_id=o.tenant_id AND p.store_id=o.store_id AND p.id=o.payment_id
  LEFT JOIN mbox.refunds r ON r.tenant_id=o.tenant_id AND r.store_id=o.store_id AND r.id=o.refund_id
  WHERE o.consumed_at IS NULL AND o.observed_status IN
    ('payment_succeeded','payment_failed','payment_closed','refund_succeeded','refund_failed')
)
SELECT kind,id,tenant_id,store_id,classification,
  encode(sha256(convert_to(protected_facts::text,'UTF8')),'hex') AS facts_sha256
FROM classified ORDER BY kind,tenant_id,store_id,id
'''

FUNDS_RESOLVED_SQL = {'payment':r'''SELECT EXISTS (
 SELECT 1 FROM mbox.payments p
 WHERE p.tenant_id=$1::uuid AND p.store_id=$2::uuid AND p.id=$3::uuid
  AND p.provider IN ('postar','wechat')
  AND EXISTS (
   SELECT 1 FROM mbox.verified_provider_observations o
   WHERE o.tenant_id=p.tenant_id AND o.store_id=p.store_id AND o.payment_id=p.id
    AND o.subject_kind='payment' AND o.provider=p.provider
    AND o.reported_amount_minor=p.amount_minor AND o.reported_currency=p.currency
    AND o.provider_transaction_id=p.provider_transaction_id
    AND (o.settlement_channel IS NULL OR o.settlement_channel=p.settlement_channel)
    AND o.consumed_at IS NOT NULL AND o.consumed_idempotency_key IS NOT NULL
    AND o.consumed_operation IN ('payment.callback','payment.provider-query')
    AND ((p.status IN ('succeeded','partially_refunded','refunded') AND o.observed_status='payment_succeeded')
      OR (p.status='failed' AND o.observed_status='payment_failed')
      OR (p.status='closed' AND o.observed_status='payment_closed'))
  )
  AND (
   (p.status IN ('succeeded','partially_refunded','refunded')
    AND (SELECT count(*) FROM mbox.reconciliation_entries e WHERE e.tenant_id=p.tenant_id
      AND e.store_id=p.store_id AND e.payment_id=p.id AND e.entry_type='payment')=1
    AND EXISTS (SELECT 1 FROM mbox.reconciliation_entries e WHERE e.tenant_id=p.tenant_id
      AND e.store_id=p.store_id AND e.payment_id=p.id AND e.entry_type='payment'
      AND e.provider=p.provider AND e.provider_reference=p.provider_transaction_id
      AND e.amount_minor=p.amount_minor AND e.currency=p.currency))
   OR (p.status IN ('failed','closed') AND NOT EXISTS (
    SELECT 1 FROM mbox.reconciliation_entries e WHERE e.tenant_id=p.tenant_id
      AND e.store_id=p.store_id AND e.payment_id=p.id AND e.entry_type='payment'))
  )
) AS original_payment_resolved''','refund':r'''SELECT EXISTS (
 SELECT 1 FROM mbox.refunds r JOIN mbox.payments p ON p.tenant_id=r.tenant_id
  AND p.store_id=r.store_id AND p.id=r.payment_id
 WHERE r.tenant_id=$1::uuid AND r.store_id=$2::uuid AND r.id=$3::uuid
  AND p.provider IN ('postar','wechat') AND r.status IN ('succeeded','failed')
  AND EXISTS (
   SELECT 1 FROM mbox.verified_provider_observations o
   WHERE o.tenant_id=r.tenant_id AND o.store_id=r.store_id AND o.refund_id=r.id
    AND o.subject_kind='refund' AND o.provider=p.provider
    AND o.reported_amount_minor=r.amount_minor AND o.reported_currency=r.currency
    AND o.original_provider_transaction_id=p.provider_transaction_id
    AND o.provider_transaction_id=r.provider_refund_id
    AND o.consumed_at IS NOT NULL AND o.consumed_operation='refund.result'
    AND o.consumed_idempotency_key IS NOT NULL
    AND o.observed_status=CASE r.status WHEN 'succeeded' THEN 'refund_succeeded' ELSE 'refund_failed' END
  )
  AND (
   (r.status='succeeded'
    AND (SELECT count(*) FROM mbox.reconciliation_entries e WHERE e.tenant_id=r.tenant_id
      AND e.store_id=r.store_id AND e.refund_id=r.id AND e.entry_type='refund')=1
    AND EXISTS (SELECT 1 FROM mbox.reconciliation_entries e WHERE e.tenant_id=r.tenant_id
      AND e.store_id=r.store_id AND e.refund_id=r.id AND e.payment_id=r.payment_id
      AND e.entry_type='refund' AND e.provider=p.provider
      AND e.provider_reference=r.provider_refund_id
      AND e.amount_minor=-r.amount_minor AND e.currency=r.currency))
   OR (r.status='failed' AND NOT EXISTS (SELECT 1 FROM mbox.reconciliation_entries e
     WHERE e.tenant_id=r.tenant_id AND e.store_id=r.store_id
      AND e.refund_id=r.id AND e.entry_type='refund'))
  )
) AS original_refund_resolved'''}

def funds_key(row): return (row['kind'],row['tenant_id'],row['store_id'],row['id'])
def funds_delta(rows, baseline, resolved, reviewed=()):
    current={funds_key(row):row for row in rows}; original={funds_key(row):row for row in baseline}
    require(len(current)==len(rows) and len(original)==len(baseline),'duplicate provider fact identity')
    held={funds_key(row):row for row in reviewed}
    preserved=[]; blockers=[]
    for key,row in current.items():
        if (key in original and row==original[key]) or (key in held and row==held[key]): preserved.append(row)
        else: blockers.append(row)
    missing=[row for key,row in original.items() if key not in current and key not in resolved]
    return {'blockingCount':len(blockers)+len(missing),'preservedHistoricalCount':len(preserved),'resolvedHistoricalCount':len(set(original)&resolved),'blockers':blockers,'missingOriginalFacts':missing}

class Host:
    def __init__(self,release,tier,public):
        self.release=Path(release); self.root=Path('/opt/mbox'); self.tier=tier; self.public=public.rstrip('/')
        self.manifest=json.loads((self.release/'release-manifest.json').read_text())
        self.plan=json.loads(protected(self.release/'maintenance-plan.json').read_text())
        self.controller_python=str(Path(self.plan['controllerPython']).resolve())
        require(str(Path(sys.executable).resolve())==self.controller_python,'controller interpreter differs from protected plan')
        require(sys.version_info >= (3,7),'Python 3.7+ required')
        interpreter=Path(self.controller_python)
        require(re.fullmatch(r'/[A-Za-z0-9_./-]+',self.controller_python) and interpreter.is_file() and os.access(interpreter,os.X_OK),'invalid controller interpreter')
        require(all(p.stat().st_uid==0 and p.stat().st_mode&0o022==0 for p in [interpreter,*interpreter.parents]),'controller interpreter path writable by non-root')
        self.sha=self.manifest['releaseSha']; self.image=self.manifest['imageTag']; self.schema=self.manifest['migration']['count']
        require(self.plan.get('mode')=='planned-maintenance-forward-only','explicit planned maintenance mode required')
        require(self.plan.get('targetReleaseSha')==self.sha and self.plan.get('targetImageDigest')==self.manifest['imageDigest'],'maintenance plan target mismatch')
        require(re.fullmatch('[a-z0-9][a-z0-9-]{7,63}',self.plan['transitionId']),'invalid transition id')
        self.directory=self.root/'maintenance'/self.plan['transitionId']
        self.candidate='mbox-maintenance-candidate-'+self.sha[:7]; self.ingress='mbox-maintenance-ingress-'+self.plan['transitionId'][-12:]
        self.envpath=protected(self.root/'secrets/maintenance-runtime.env')
        self.runtime=env_file(self.envpath)
        self.maintenance=env_file(protected(self.root/'secrets/database-maintenance.env'))
        require(set(self.maintenance)==set(['APPLICATION_DATABASE_SERVICE','BACKUP_DATABASE_SERVICE','ADMIN_DATABASE_SERVICE','PGSERVICEFILE','PGPASSFILE']),'invalid database maintenance keys')
        self.services=configparser.ConfigParser(interpolation=None); self.services.read(protected(self.maintenance['PGSERVICEFILE']))
        protected(self.maintenance['PGPASSFILE'])
        require(all('password' not in s and 'passfile' not in s for s in self.services.values()),'service files must not embed passwords')
        self.appservice=self.maintenance['APPLICATION_DATABASE_SERVICE']; self.backupservice=self.maintenance['BACKUP_DATABASE_SERVICE']; self.adminservice=self.maintenance['ADMIN_DATABASE_SERVICE']; self.clusteradmin=self.plan['clusterAdminService']
        self.database=self.services[self.appservice]['dbname']
        self.login=self.services[self.appservice]['user']; self.adminlogin=self.services[self.adminservice]['user']; self.backuplogin=self.services[self.backupservice]['user']
        require(len({self.login,self.adminlogin,self.backuplogin})==3,'runtime/admin/backup logins must be distinct')
        require(self.services[self.adminservice]['dbname']==self.database, 'migration admin service must target application database')
        require(self.services[self.clusteradmin]['dbname']!=self.database and self.services[self.clusteradmin]['user']==self.adminlogin, 'cluster admin service must use the separate maintenance login outside application database')
        require(self.plan.get('retiredLogins') and all(re.fullmatch('[A-Za-z0-9_]{1,63}',x) for x in [self.login,*self.plan['retiredLogins']]),'invalid runtime/retired role names')
        self.pg_env={k:self.maintenance[k] for k in ('PGSERVICEFILE','PGPASSFILE')}
        self.args=['--network','mbox-net','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=32m','--cap-drop','ALL','--security-opt','no-new-privileges']
        self.adapter=[]; self.data_mount=None
        self.journal=None; self.draining=False; self.reentry=False
        # This must precede even recovery failure handling: a wrong cluster
        # administrator must never receive ALTER ROLE for another cluster.
        identity_sql="SELECT json_build_object('address',inet_server_addr()::text,'port',inet_server_port(),'system',system_identifier::text) FROM pg_control_system()"
        identities=[json.loads(self.sql(identity_sql,service)) for service in (self.adminservice,self.clusteradmin)]
        require(identities[0]==identities[1],'migration/cluster-admin services target different physical clusters')
        backup_identity=json.loads(self.sql("SELECT json_build_object('address',inet_server_addr()::text,'port',inet_server_port())",self.backupservice))
        require(all(backup_identity[key]==identities[0][key] for key in backup_identity),'backup service targets another physical cluster')
        require(self.sql('SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user')=='t','cluster administrator must see all store facts without RLS filtering')
        self.cluster_identity=identities[0]
    def run(self,args,input=None,env=None,check=True):
        # Never print command arguments/output on failure: providers and process
        # environments may contain secrets. Raw output is not a public artifact.
        result=subprocess.run([str(x) for x in args],input=input,text=True,capture_output=True,env={**os.environ,**(env or {})})
        if check and result.returncode: raise Blocked('command failed: '+str(args[0])+' (exit '+str(result.returncode)+')')
        return result.stdout.strip()
    def sql(self,statement,service=None,database=None):
        reference='service='+str(service or self.clusteradmin)
        if database is not None:
            require(re.fullmatch('[A-Za-z0-9_]{1,63}',database),'invalid database name'); reference+=' dbname='+database
        return self.run(['psql','-XAt','--set=ON_ERROR_STOP=1','--dbname='+reference],input=statement,env=self.pg_env)
    def inspect(self,name): return json.loads(self.run(['docker','inspect',name]))[0]
    def optional_container(self,name):
        output=self.run(['docker','inspect',name],check=False)
        rows=json.loads(output) if output else []
        require(isinstance(rows,list) and len(rows)<=1,'ambiguous optional container identity')
        if rows: return rows[0]
        # A missing inspect result alone also occurs when dockerd is down.
        # Prove absence against a successful full inventory before treating a
        # deleted candidate as fenced. Existing-but-uninspectable is unsafe.
        inventory=self.run(['docker','ps','-a','--no-trunc','--format','{{.ID}}\t{{.Names}}'])
        for line in inventory.splitlines():
            fields=line.split('\t'); require(len(fields)==2,'invalid container inventory')
            require(not (fields[0]==name or name.lstrip('/') in fields[1].split(',') or (re.fullmatch('[a-f0-9]{12,64}',name) and fields[0].startswith(name))),'container exists but immutable inspect failed')
        return None
    def ip(self,name): return self.inspect(name)['NetworkSettings']['Networks']['mbox-net']['IPAddress']
    def request(self,url,method='GET',headers=None):
        try:
            with urllib.request.urlopen(urllib.request.Request(url,method=method,headers=headers or {}),timeout=20) as response: return response.status,json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code,json.loads(error.read())
    def control(self,action,method='GET',target=None):
        headers={'X-Mbox-Maintenance-Token':(self.directory/'control-token').read_text().strip()}
        if target: headers['X-Mbox-Maintenance-Target']=target
        status,body=self.request('http://'+self.ip(self.ingress)+':8787/__maintenance/'+action,method,headers)
        require(status==200,'maintenance control failed: '+action); return body
    def save(self,name,value): atomic(self.release/name,value)
    def assert_zero(self):
        value=self.sql("SELECT json_build_object('clients',count(*) FILTER (WHERE backend_type='client backend'),'transactions',count(*) FILTER (WHERE xact_start IS NOT NULL),'prepared',(SELECT count(*) FROM pg_prepared_xacts WHERE database=current_database())) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()",database=self.database)
        evidence=json.loads(value); self.save('maintenance-connections.json',evidence)
        require(evidence=={'clients':0,'transactions':0,'prepared':0},'writers or prepared transactions remain')
    def restricted(self):
        output=self.run(['docker','run','--rm','--env-file',self.release/'app.env',*self.args,'--mount','type=bind,src='+str(self.store)+',dst=/run/mbox-config/store.json,readonly',self.image,'node','dist-normalized/server/verify-normalized-runtime-config.js','--database','--store=/run/mbox-config/store.json'])
        report=json.loads(output)
        require(report.get('databaseIdentity',{}).get('login')==self.login,'runtime DATABASE_URL differs from the application service login')
        self.save('maintenance-database-identity.json',report)
        value=json.loads(self.run(['docker','run','--rm','--env-file',self.release/'app.env',*self.args,self.image,'node','--input-type=module','-e',"import pg from 'pg';const p=new pg.Pool({connectionString:process.env.DATABASE_URL});console.log(JSON.stringify((await p.query('select current_database() as database,inet_server_addr()::text as address,inet_server_port() as port')).rows[0]));await p.end()" ]))
        require(value=={'database':self.database,'address':self.cluster_identity['address'],'port':self.cluster_identity['port']},'actual candidate DATABASE_URL targets another physical database')
    def maintenance_command(self,module,*arguments):
        mounts=[]
        for key in ('PGSERVICEFILE','PGPASSFILE'):
            file=self.maintenance[key]; require(file.startswith('/opt/mbox/secrets/'),'secret mount must be under secrets')
            mounts+=['--env',key+'='+file,'--mount','type=bind,src='+file+',dst='+file+',readonly']
        certificates=set()
        for service in (self.adminservice,self.appservice,self.backupservice):
            cert=self.services[service].get('sslrootcert')
            if cert:
                require(cert.startswith('/opt/mbox/secrets/') and Path(cert).is_file() and not Path(cert).is_symlink(),'invalid root certificate')
                if cert not in certificates:
                    mounts+=['--mount','type=bind,src='+cert+',dst='+cert+',readonly'];certificates.add(cert)
        mounts+=['--mount','type=bind,src='+str(self.store)+',dst=/run/mbox-config/store.json,readonly','--mount','type=bind,src='+str(self.catalog)+',dst=/run/mbox-config/catalog.json,readonly']
        return self.run(['docker','run','--rm','--user','0:0','--env-file',self.release/'app.env',*self.args,*mounts,self.image,'node',module,*arguments,'--maintenance-service='+self.adminservice])
    def preflight(self):
        require(os.geteuid()==0,'maintenance activation requires root')
        for path in (self.root/'maintenance').glob('*/journal.jsonl'):
            if path.parent==self.directory: continue
            records=[json.loads(line) for line in path.read_text().splitlines()]
            require(records,'empty prior maintenance journal')
            if records[-1]['event']!='completed': self.verify_withdrawn_transition(path,records)
        require(self.tier=='production','maintenance transition requires explicit production tier')
        for command in ('docker','psql','pg_dump','pg_restore','systemctl','sha256sum'): require(shutil.which(command),'missing command '+command)
        self.store=self.release/self.manifest['configuration']['store']['file']; self.catalog=self.release/self.manifest['configuration']['catalog']['file']
        for kind,path in [('store',self.store),('catalog',self.catalog)]:
            require(not path.is_symlink() and path.is_file() and sha(path)==self.manifest['configuration'][kind]['sha256'],'config binding mismatch')
            # These signed JSON assets contain public store/catalog config.
            # The candidate runs as node (gid 1000); root:0600 cannot be read.
            os.chown(path,0,1000); os.chmod(path,0o440)
        # Config changes are local-only until the final candidate succeeds.
        values={**self.runtime,'MBOX_RELEASE_SHA':self.sha,'APP_COMMIT_SHA':self.sha,'MBOX_RELEASE_IMAGE_DIGEST':self.manifest['imageDigest'],'MBOX_EXPECTED_RELEASE_SHA':self.sha,'MBOX_EXPECTED_IMAGE_DIGEST':self.manifest['imageDigest'],'MBOX_DEPLOYMENT_TIER':self.tier,'MBOX_PUBLIC_URL':self.public}
        require(values.get('MBOX_START_WORKERS')=='true','final runtime must enable workers')
        with open(self.release/'app.env','w') as output: output.write(''.join(k+'='+v+'\n' for k,v in values.items()))
        os.chmod(self.release/'app.env',0o600)
        self.run([self.release/'normalize-runtime-env.sh',self.release/'app.env',self.tier])
        module=values.get('MBOX_WORKER_ADAPTER_MODULE','')
        require(module.startswith('/app/worker-adapters/'),'production worker adapter required')
        adapter=Path(self.plan['workerAdapterDirectory'])
        require(str(adapter).startswith('/opt/mbox/releases/') and adapter.is_dir() and not any(p.is_symlink() for p in adapter.rglob('*')),'invalid immutable worker adapter')
        tree=[(str(p.relative_to(adapter)),sha(p)) for p in sorted(adapter.rglob('*')) if p.is_file()]
        require(hashlib.sha256(canonical(tree)).hexdigest()==self.plan['workerAdapterTreeSha256'],'worker adapter tree mismatch')
        require(all(p.stat().st_uid==0 and p.stat().st_mode&0o022==0 for p in adapter.rglob('*')),'worker adapter writable by non-root')
        self.adapter=['--mount','type=bind,src='+str(adapter)+',dst=/app/worker-adapters,readonly']
        if not self.reentry:
            self.restricted()
            self.maintenance_command('dist-normalized/server/migrate-normalized.js','--verify-only')
        source=self.inspect(self.plan['sourceLive']['containerId'])
        expected=self.plan['sourceLive']
        require(source['Id']==expected['containerId'] and source['Image']==expected['platformImageDigest'] and source['Config']['Labels']['org.opencontainers.image.revision']==expected['releaseSha'],'sourceLive immutable identity mismatch')
        require(hashlib.sha256(canonical(sorted(source['Config']['Env']))).hexdigest()==expected['environmentSha256'],'sourceLive environment mismatch')
        mounts=[{'type':x['Type'],'source':x.get('Name') if x['Type']=='volume' else x['Source'],'target':x['Destination'],'readOnly':not x['RW']} for x in source['Mounts'] if x['Destination']!='/app/worker-adapters']
        require(sorted(mounts,key=lambda x:x['target'])==sorted(self.plan['persistentMounts'],key=lambda x:x['target']),'source persistent mount binding changed')
        require(all(x['target']=='/data' and x['type'] in ('volume','bind') for x in mounts),'unrecognized legacy persistent mount requires an explicit reviewed adapter')
        require(len(mounts)<=1,'ambiguous data mounts')
        self.data_mount=mounts[0] if mounts else None
        oldenv=dict(value.split('=',1) for value in source['Config']['Env'] if '=' in value)
        for key in ('POSTAR_PUBLIC_KEY','POSTAR_AGENCY_ID','POSTAR_MERCHANT_ID','POSTAR_CALLBACK_URL','MBOX_PAYMENT_PROVIDER','MBOX_TENANT_ID','MBOX_STORE_ID'):
            require(oldenv.get(key,'').replace('\\n','\n')==values.get(key,'').replace('\\n','\n'),'provider binding changed during maintenance: '+key)
        # Credentials are used inside their existing container, never copied or
        # inferred from a URL username. This is audit identity, not qualification.
        if source['State']['Running']:
            actual=json.loads(self.run(['docker','exec',source['Id'],'node','--input-type=module','-e',"import pg from 'pg';const p=new pg.Pool({connectionString:process.env.DATABASE_URL});console.log(JSON.stringify((await p.query('select current_user as login,current_database() as database,inet_server_addr()::text as address,inet_server_port() as port')).rows[0]));await p.end()" ]))
            require(actual['login'] in self.plan['retiredLogins'] and actual['database']==self.database,'sourceLive actual database identity mismatch')
            self.save('maintenance-source-identity.json',actual)
        require(self.login not in self.plan['retiredLogins'] and self.adminlogin not in self.plan['retiredLogins'] and self.backuplogin not in self.plan['retiredLogins'],'maintenance/runtime login cannot be retired')
        # Every presently running application container is explicit. Unknown
        # containers block rather than being guessed safe or stopped silently.
        running=set(self.run(['docker','ps','--no-trunc','--format','{{.ID}}']).splitlines())
        excluded={self.inspect('mbox-caddy')['Id']}
        ingress=self.optional_container(self.ingress)
        if ingress: excluded.add(ingress['Id'])
        candidate=self.optional_container(self.candidate)
        if candidate: excluded.add(candidate['Id'])
        if self.reentry:
            for record in self.journal.records:
                if record['event']=='candidate-started': excluded.add(record['data']['containerId'])
        require(running-excluded <= set(self.plan['writerContainerIds']),'unaccounted running containers; update physical writer inventory')
        require(expected['containerId'] in self.plan['writerContainerIds'],'sourceLive absent from writer inventory')
        require(self.plan.get('callbackUrls') and all(re.fullmatch(r'https://[A-Za-z0-9.-]+/api/(payments|refunds)/providers/(postar|wechat)/callback',x) for x in self.plan['callbackUrls']),'all callback routes required')
        configured=values.get('POSTAR_CALLBACK_URL')
        require(configured in self.plan['callbackUrls'] and configured.replace('/payments/','/refunds/') in self.plan['callbackUrls'],'configured payment/refund callbacks not covered')
        require(self.plan.get('systemdUnits') and all(re.fullmatch(r'[A-Za-z0-9_.@-]+\.(service|timer)',x) for x in self.plan['systemdUnits']),'explicit writer/cron service inventory required')
        require(any(x in self.plan['systemdUnits'] for x in ('cron.service','crond.service')),'cron daemon must be fenced')
        # Binding the persistent inventory catches newly installed watchdogs between
        # the operator's read-only inventory and the stop operation.
        inventory=self.run(['systemctl','list-unit-files','--no-legend','--no-pager'])
        if not self.reentry: require(systemd_inventory_sha256(inventory)==self.plan['systemdInventorySha256'],'systemd inventory changed')
        else:
            for unit in self.plan['systemdUnits']:
                require(self.run(['systemctl','is-enabled',unit],check=False)=='masked','writer restart fence changed during recovery')
        previous=Path(self.plan['sourceLive']['releaseDirectory'])
        require(str(previous).startswith('/opt/mbox/releases/') and json.loads((previous/'release-manifest.json').read_text())['releaseSha']==expected['releaseSha'],'original manifest required')
        self.previous=previous
        if not self.reentry: require(self.sql('select current_user',self.appservice)==self.login,'application service login mismatch')
        application=json.loads(self.sql("SELECT json_build_object('database',current_database(),'address',inet_server_addr()::text,'port',inet_server_port())", self.adminservice if self.reentry else self.appservice))
        backup=json.loads(self.sql("SELECT json_build_object('database',current_database(),'address',inet_server_addr()::text,'port',inet_server_port())",self.backupservice))
        require(application==backup,'backup service points to another physical database')
        if source['State']['Running']: require(all(actual[k]==application[k] for k in application),'sourceLive and target database differ')
        self.save('maintenance-target-identity.json',application)
        self.caddy_sources() # reject unsupported imports before touching public routes
        self.funds_preview()
    def verify_withdrawn_transition(self,path,records,record=True):
        """Accept only an explicitly bound, unmigrated operator withdrawal."""
        entries=self.plan.get('withdrawnTransitions',[])
        entries=[entry for entry in entries if entry.get('transitionId')==path.parent.name]
        require(len(entries)==1,'another maintenance transition remains unfinished')
        entry=entries[0]; receipt_path=protected(path.parent/'operator-cancelled-unmigrated.json')
        require(sha(protected(path))==entry.get('journalSha256') and sha(receipt_path)==entry.get('receiptSha256'),'withdrawal evidence changed')
        previous='0'*64
        for index,row in enumerate(records):
            body={key:value for key,value in row.items() if key!='hash'}
            require(row.get('sequence')==index and row.get('previous')==previous and hashlib.sha256(canonical(body)).hexdigest()==row.get('hash'),'withdrawn journal corrupted')
            previous=row['hash']
        receipt=json.loads(receipt_path.read_text())
        require(receipt.get('status')=='original-production-restored' and receipt.get('databaseReplaced') is False,'withdrawal did not preserve source database')
        require(all(receipt.get(key) is True for key in ('sourceEvidenceUnchangedBeforeRestart','journalAndEpochPreserved','maintenanceGuardDisabled','maintenanceIngressStopped')),'incomplete withdrawal evidence')
        queue=receipt.get('callbackQueue',{})
        require(queue.get('pending')==0 and queue.get('active')==0 and queue.get('replaying') is False,'withdrawal callback work unresolved')
        require(receipt.get('at',0)>=max(row['at'] for row in records),'withdrawal predates journal changes')
        require(not any(row['event'] in ('schema-provisioned','candidate-started','public-verified','completed') for row in records),'withdrawn transition had crossed migration boundary')
        binding=next(row['data'] for row in records if row['event']=='bound')
        require(receipt.get('sourceReleaseSha')==binding['sourceLive']['releaseSha'] and receipt.get('deploymentCancelled')==binding['forwardRecoveryTarget']['releaseSha'],'withdrawal release binding mismatch')
        source_manifest=json.loads((Path(self.plan['sourceLive']['releaseDirectory'])/'release-manifest.json').read_text())
        require(int(source_manifest['migration']['count'])==receipt.get('schemaVersion'),'source schema changed since unmigrated withdrawal')
        current_schema=self.sql('SELECT schema_version FROM mbox.normalized_schema_metadata WHERE singleton=true',self.adminservice)
        expected_schema=receipt['schemaVersion']
        if self.reentry:
            # The withdrawal describes the old source, not a later completed
            # migration in this hash-verified transition. Only an actual
            # schema-provisioned event admits that event's bound target schema.
            active=None
            for event in self.journal.records:
                if event['event'] in ('bound','forward-target'):
                    active=event['data']
                elif event['event']=='schema-provisioned':
                    require(active and active['sourceLive']==self.plan['sourceLive'],'provisioned schema source binding changed')
                    expected_schema=int(active['forwardRecoveryTarget']['schema'])
        ancestry=getattr(self,'ordinary_schema_evidence',None)
        if ancestry is not None:
            require(record is False and self.reentry and self.journal.records[-1]['event']=='completed' and expected_schema==ancestry['baseline'],'ordinary ancestry cannot authorize maintenance recovery')
            expected_schema=ancestry['current']
        require(int(current_schema)==expected_schema,'database schema differs from withdrawal and verified provisioned targets')
        unit='mbox-maintenance-guard-'+path.parent.name+'.service'
        state=self.run(['systemctl','show',unit,'--property=MainPID','--property=ActiveState','--property=UnitFileState'])
        values=dict(line.split('=',1) for line in state.splitlines() if '=' in line)
        require(values.get('MainPID')=='0' and values.get('ActiveState') in ('inactive','failed') and values.get('UnitFileState') in ('disabled','masked'),'withdrawn maintenance guard remains active')
        ingress=self.optional_container('mbox-maintenance-ingress-'+path.parent.name[-12:])
        require(ingress is None or (not ingress['State']['Running'] and ingress['HostConfig']['RestartPolicy']['Name']=='no'),'withdrawn ingress may restart')
        if record: self.save('maintenance-withdrawal-'+path.parent.name+'.json',{'verified':True,**entry})
    def verify_completed_withdrawals(self,ordinary_release=None):
        # Ordinary releases may retain a withdrawal only with the completed
        # plan that validated it and an exactly verified migration ancestry. Read-only: never
        # append a journal, rewrite a receipt, fence a writer or recover a target.
        current=(self.root/'current').resolve()
        require(current.parent==(self.root/'releases').resolve(),'current release path is invalid')
        current_manifest=json.loads(protected(current/'release-manifest.json').read_text())
        self.ordinary_schema_evidence=None
        current_schema=self.schema
        if ordinary_release is None:
            require(current_manifest['migration']==self.manifest['migration'],'current schema differs from completed maintenance')
        else:
            target=Path(ordinary_release)
            require(not target.is_symlink() and target.resolve().parent==(self.root/'releases').resolve(),'ordinary release path is invalid')
            candidate=json.loads(protected(target/'release-manifest.json').read_text())
            require(re.fullmatch('[0-9a-f]{40}',candidate.get('releaseSha','')) and target.name==candidate['releaseSha'][:7],'ordinary release identity mismatch')
            snapshot=json.loads(self.run(['psql','-XqAt','--set=ON_ERROR_STOP=1','--dbname=service='+self.adminservice],input="""BEGIN READ ONLY;
SET LOCAL statement_timeout='8s'; SET LOCAL lock_timeout='1s';
SELECT json_build_object('schemaVersion',schema_version,'schemaFlavor',schema_flavor,
'applied',(SELECT COALESCE(json_agg(row_to_json(m) ORDER BY version),'[]'::json) FROM
(SELECT version,filename,checksum FROM mbox.normalized_schema_migrations) m))
FROM mbox.normalized_schema_metadata WHERE singleton=true;
ROLLBACK;""",env=self.pg_env))
            current_schema=verify_ordinary_migration_ancestry(self.manifest,current_manifest,candidate,snapshot)
        records=read_verified_journal(self.directory/'journal.jsonl')
        require(records[-1]['event']=='completed','current maintenance did not complete')
        binding=next(row['data'] for row in reversed(records) if row['event'] in ('bound','forward-target'))
        require(binding=={'transitionId':self.plan['transitionId'],'sourceLive':self.plan['sourceLive'],'forwardRecoveryTarget':{'releaseSha':self.sha,'imageDigest':self.manifest['imageDigest'],'schema':self.schema,'migrationDigest':self.manifest['migration']['digest']},'planSha256':sha(self.release/'maintenance-plan.json')},'completed maintenance binding mismatch')
        live=self.inspect('mbox-app')
        require(live['State']['Running'] and live['Image']==current_manifest['platformImageDigest'] and live['Config']['Labels']['org.opencontainers.image.revision']==current_manifest['releaseSha'],'completed maintenance runtime mismatch')
        status,ready=self.request(self.public+'/api/ready')
        require(status==200 and ready.get('status')=='ready' and ready.get('writeEnabled') is True and ready.get('commitSha')==current_manifest['releaseSha'] and ready.get('releaseImageDigest')==current_manifest['imageDigest'] and str(ready.get('schemaVersion'))==str(current_schema),'completed maintenance readiness mismatch')
        self.journal=argparse.Namespace(records=records);self.reentry=True
        if ordinary_release is not None:
            self.ordinary_schema_evidence={'baseline':self.schema,'current':current_schema}
        verified=[]
        for path in (self.root/'maintenance').glob('*/journal.jsonl'):
            if path.parent==self.directory: continue
            prior=read_verified_journal(path)
            if prior[-1]['event']=='completed' or not any(row['event']=='drain-intent' for row in prior): continue
            self.verify_withdrawn_transition(path,prior,record=False)
            verified.append(path.parent.name)
        return {'verified':True,'completedTransitionId':self.plan['transitionId'],'withdrawnTransitions':verified,'schemaVersion':current_schema,'productionWrites':0}
    def caddy_sources(self):
        caddy=self.inspect('mbox-caddy')
        mounts=caddy['Mounts']
        main=[m for m in mounts if m['Destination']=='/etc/caddy/Caddyfile' and m['Type']=='bind']
        require(len(main)==1,'persistent Caddyfile bind mount required')
        paths=[Path(main[0]['Source'])]
        for path in paths:
            require(path.is_file() and not path.is_symlink(),'persistent Caddy source missing or symlinked')
            imports=re.findall(r'^\s*import\s+([^#\n]+)',path.read_text(),re.M)
            for reference in imports:
                require(path==paths[0] and reference.strip()=='/data/mbox-ingress/*.caddy','unreviewed Caddy import; explicit route adapter required')
                data=[m for m in mounts if m['Destination']=='/data' and m['Type'] in ('volume','bind')]
                require(len(data)==1,'persistent Caddy data mount required for payment domain')
                snippets=sorted((Path(data[0]['Source'])/'mbox-ingress').glob('*.caddy'))
                require(snippets,'payment domain import matches no persistent files')
                paths.extend(snippets)
        return paths
    def route(self,maintenance):
        paths=self.caddy_sources();baseline=self.directory/'caddy-sources.json'
        if not baseline.exists():
            sources=[{'path':str(path),'content':path.read_text()} for path in paths]
            require(any('mbox-app:8787' in row['content'] for row in sources),'canonical Caddy upstream missing')
            atomic(baseline,sources)
        sources=json.loads(baseline.read_text())
        require({str(p) for p in paths}=={row['path'] for row in sources},'persistent Caddy import inventory changed')
        for row in sources:
            content=row['content'].replace('mbox-app:8787',self.ingress+':8787') if maintenance else row['content']
            # Flush host files in place: bind mounts and Caddy restarts observe
            # the same main AND imported payment-domain maintenance routes.
            with open(row['path'],'w') as output:output.write(content);output.flush();os.fsync(output.fileno())
        self.run(['docker','exec','mbox-caddy','caddy','validate','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'])
        self.run(['docker','exec','mbox-caddy','caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'])
    def ingress_binding(self,container):
        mounts={m['Destination']:m for m in container['Mounts']}
        require(set(mounts)=={'/maintenance','/maintenance-ingress.mjs'},'unexpected maintenance ingress mounts')
        spool=mounts['/maintenance'];script=mounts['/maintenance-ingress.mjs']
        require(spool['Type']=='bind' and spool['Source']==str(self.directory) and spool['RW'],'maintenance ingress spool binding mismatch')
        require(script['Type']=='bind' and not script['RW'],'maintenance ingress script must be immutable')
        source=Path(script['Source']);manifest=json.loads((source.parent/'release-manifest.json').read_text())
        allowed={r['data']['forwardRecoveryTarget']['releaseSha']:r['data']['forwardRecoveryTarget']['imageDigest'] for r in self.journal.records if r['event'] in ('bound','forward-target')}
        revision=container['Config']['Labels'].get('org.opencontainers.image.revision')
        require(revision in allowed and manifest['releaseSha']==revision and manifest['imageDigest']==allowed[revision],'existing ingress release binding mismatch')
        require(source==self.root/'releases'/revision[:7]/'maintenance-ingress.mjs','existing ingress script path mismatch')
        require(container['Image']==manifest['platformImageDigest'],'existing ingress platform image mismatch')
        require(sha(source)==manifest['deploymentScripts']['maintenance_ingress.mjs']['sha256'],'existing ingress script hash mismatch')
        require(container['Config']['Cmd']==['node','/maintenance-ingress.mjs','/maintenance'],'existing ingress command mismatch')
        return {'containerId':container['Id'],'releaseSha':revision,'platformImageDigest':container['Image'],'scriptSha256':sha(source)}
    def start_ingress(self):
        self.directory.mkdir(parents=True,mode=0o700,exist_ok=True)
        require(not self.directory.is_symlink() and self.directory.stat().st_uid==0 and stat.S_IMODE(self.directory.stat().st_mode)==0o700,'maintenance journal directory must be root:0700')
        if not (self.directory/'control-token').exists():
            fd=os.open(self.directory/'control-token',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
            with os.fdopen(fd,'w') as output: output.write(secrets.token_hex(32)); output.flush(); os.fsync(output.fileno())
        lock=os.open(self.directory/'ingress-transition.lock',os.O_CREAT|os.O_RDWR,0o600)
        try:
            fcntl.flock(lock,fcntl.LOCK_EX)
            current=self.optional_container(self.ingress)
            if current:
                container=current; binding=self.ingress_binding(container)
                if binding['releaseSha']!=self.sha:
                    # Disable restart and stop the sole spool writer before
                    # rebinding. Never discard old receipts or the write epoch.
                    self.run(['docker','update','--restart=no',container['Id']])
                    self.run(['docker','stop','-t','60',container['Id']])
                    require(not self.inspect(container['Id'])['State']['Running'],'old ingress remains running')
                    files=sorted([p for p in (self.directory/'callbacks').glob('*.json') if p.is_file()])
                    epoch=self.directory/'business-write-epoch.json'
                    if epoch.exists(): files.append(epoch)
                    retained=[{'file':str(p.relative_to(self.directory)),'sha256':sha(p),'originalSha256':hashlib.sha256(canonical({k:v for k,v in json.loads(p.read_text()).items() if k not in ('status','response','appliedAt')})).hexdigest()} for p in files]
                    atomic(self.directory/('ingress-retired-'+container['Id'][:12]+'.json'),{'binding':binding,'retainedFiles':retained})
                    self.run(['docker','rename',container['Id'],self.ingress+'-retired-'+container['Id'][:12]])
                    current=''
                else: self.run(['docker','start',self.ingress])
            if not current:
                self.run(['docker','run','-d','--name',self.ingress,'--restart=unless-stopped','--user','0:0',*self.args,'--mount','type=bind,src='+str(self.directory)+',dst=/maintenance','--mount','type=bind,src='+str(self.release/'maintenance-ingress.mjs')+',dst=/maintenance-ingress.mjs,readonly',self.image,'node','/maintenance-ingress.mjs','/maintenance'])
            for record in self.directory.glob('ingress-retired-*.json'):
                retired=json.loads(record.read_text())
                require(not self.inspect(retired['binding']['containerId'])['State']['Running'],'retired ingress writer restarted')
                for item in retired['retainedFiles']:
                    path=self.directory/item['file']
                    # The immutable original request bytes are validated by the
                    # ingress parser; a later legitimate ACK may update a receipt.
                    require(path.is_file(),'forward ingress lost a retained receipt or epoch')
                    if item['file']=='business-write-epoch.json': require(sha(path)==item['sha256'],'forward ingress changed the write epoch')
                    else: require(hashlib.sha256(canonical({k:v for k,v in json.loads(path.read_text()).items() if k not in ('status','response','appliedAt')})).hexdigest()==item['originalSha256'],'forward ingress changed original callback bytes or binding')
            bound=self.ingress_binding(self.inspect(self.ingress))
            require(bound['releaseSha']==self.sha,'forward ingress did not bind the current release')
            for _ in range(30):
                try:
                    self.control('state');atomic(self.directory/'ingress-active.json',bound);return
                except Exception: time.sleep(1)
            raise Blocked('maintenance ingress did not start')
        finally: os.close(lock)
    def install_guard(self):
        # This independent persistent service survives SSH/controller death.
        # It observes process identity, never readiness, and closes every fence.
        identity=Path('/proc/'+str(os.getpid())+'/stat').read_text().split(') ',1)[1].split()[19]
        atomic(self.directory/'controller.json',{'pid':os.getpid(),'start':identity})
        unit='mbox-maintenance-guard-'+self.plan['transitionId']+'.service'
        require(re.fullmatch(r'https://[A-Za-z0-9.-]+',self.public),'invalid public origin')
        require(re.fullmatch(r'/opt/mbox/releases/[a-f0-9]{7}',str(self.release)),'invalid immutable release path')
        contents='[Unit]\nAfter=docker.service network-online.target\nRequires=docker.service\n[Service]\nType=simple\nExecStart='+self.controller_python+' '+str(self.release/'maintenance-bootstrap.py')+' '+str(self.release)+' '+self.tier+' '+self.public+' --watchdog\nRestart=on-failure\nRestartSec=2\n[Install]\nWantedBy=multi-user.target\n'
        file=Path('/etc/systemd/system')/unit
        with file.open('w') as output: output.write(contents); output.flush(); os.fsync(output.fileno())
        os.chmod(file,0o600)
        self.run(['systemctl','daemon-reload']); self.run(['systemctl','enable',unit]); self.run(['systemctl','restart',unit])
        require(self.run(['systemctl','is-active',unit])=='active','independent maintenance watchdog unavailable')
        self.journal.append('watchdog-active',{'unit':unit})
    def watchdog(self):
        self.draining=True
        while True:
            try:
                lock=os.open(self.directory/'journal.lock',os.O_CREAT|os.O_RDWR,0o600)
                try:
                    fcntl.flock(lock,fcntl.LOCK_SH)
                    records=[json.loads(line) for line in (self.directory/'journal.jsonl').read_text().splitlines()]
                    latest=next(x['data'] for x in reversed(records) if x['event'] in ('bound','forward-target'))
                    Journal(self.directory,latest) # validate the hash chain before accepting completed
                finally: os.close(lock)
                if records[-1]['event']=='completed': return
                controller=json.loads((self.directory/'controller.json').read_text())
                fields=Path('/proc/'+str(controller['pid'])+'/stat').read_text().split(') ',1)[1].split()
                actual=fields[19]
                if fields[0]=='Z': raise Blocked('controller exited')
                if actual != controller['start']: raise Blocked('controller process identity changed')
            except Exception:
                # No stale in-memory Journal instance here: a watchdog writes
                # separate evidence and never corrupts the controller hash chain.
                if self.journal is None:
                    try:
                        latest=next(x['data'] for x in reversed(records) if x['event'] in ('bound','forward-target'))
                        self.journal=Journal(self.directory,latest)
                        self.start_ingress()
                    finally: self.journal=None
                fenced=self.fail_closed('controller-lost')
                atomic(self.directory/'watchdog-failure.json',{'at':time.time(),'action':'maintenance-required','allFencesVerified':fenced})
                # Keep enforcing until a new controller takes ownership. A
                # failed route reload or stop is not a successful fence.
                time.sleep(5)
            time.sleep(1)
    def fence_unit(self,unit):
        # systemd 219 has no mask --now. Locally installed unit files must be
        # durably preserved before replacing their exact path with /dev/null.
        target=Path('/etc/systemd/system')/unit
        if target.exists() and not target.is_symlink():
            require(target.stat().st_uid==0 and target.stat().st_mode&0o022==0,'unsafe local writer unit permissions')
            stash=self.directory/'retired-systemd-units';stash.mkdir(mode=0o700,exist_ok=True)
            backup=stash/unit
            if backup.exists(): require(sha(backup)==sha(target),'retired service definition changed')
            else:
                fd=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
                try: os.write(fd,target.read_bytes());os.fsync(fd)
                finally:os.close(fd)
                fd=os.open(stash,os.O_RDONLY)
                try:os.fsync(fd)
                finally:os.close(fd)
            temporary=target.with_name(unit+'.maintenance-mask')
            if temporary.is_symlink():temporary.unlink()
            os.symlink('/dev/null',temporary);os.replace(temporary,target)
            fd=os.open(target.parent,os.O_RDONLY)
            try:os.fsync(fd)
            finally:os.close(fd)
            self.run(['systemctl','daemon-reload'])
        # Attempt stop even when masking itself fails. The result only counts
        # as fenced when both independent postconditions are observed.
        try:self.run(['systemctl','mask',unit])
        finally:self.run(['systemctl','stop',unit])
        require(self.run(['systemctl','is-enabled',unit],check=False)=='masked','restart service not persistently fenced')
        require(self.run(['systemctl','is-active',unit],check=False) not in ('active','activating','deactivating','reloading'),'writer service remains active')
    def verify_ingress_routes(self):
        evidence=[]
        for url in [self.public+'/api/ready',*self.plan['callbackUrls']]:
            # The exact callback/ready route proves the receiver; a payment edge
            # need not expose any additional control path. GET has no side effect.
            token=(self.directory/'control-token').read_text().strip()
            challenge=secrets.token_hex(32)
            status,body=self.request(url+'?mboxMaintenanceChallenge='+challenge)
            proof=hmac.new(token.encode(),challenge.encode(),hashlib.sha256).hexdigest()
            require(status==503 and body.get('reason')=='planned_maintenance_upgrade' and hmac.compare_digest(str(body.get('proof','')),proof),'actual callback/public path is not fenced by this ingress')
            evidence.append({'url':url,'status':status,'instanceVerified':True})
        self.save('maintenance-route-proof.json',evidence)
    def drain(self):
        self.draining=True; self.journal.append('drain-intent'); self.install_guard()
        self.start_ingress(); self.route(True)
        self.verify_ingress_routes()
        self.journal.append('route-fenced')
        for unit in self.plan['systemdUnits']:
            self.fence_unit(unit)
        for name in self.plan['writerContainerIds']:
            self.run(['docker','update','--restart=no',name]); self.run(['docker','stop','-t','60',name])
            container=self.inspect(name)
            require(not container['State']['Running'] and container['HostConfig']['RestartPolicy']['Name']=='no','writer container restart is not fenced')
        for role in [*self.plan['retiredLogins'],self.login]:
            require(re.fullmatch('[a-zA-Z0-9_]{1,63}',role),'invalid runtime role')
            self.sql('ALTER ROLE "'+role+'" NOLOGIN;')
        # Do not silently terminate unknown financial transactions. If graceful
        # stop leaves any client/prepared transaction, maintenance stays closed.
        self.assert_zero()
        self.freeze_funds()
        facts=self.pending_funds(); self.save('maintenance-original-inflight.json',facts)
        if facts['hasPotentialExternalChange']: self.journal.epoch('external-provider-inflight-at-drain')
        self.journal.append('writers-drained',{'inflight':facts})
    def archive(self,kind,directory):
        directory=Path(directory)
        files=sorted(p for p in directory.iterdir() if p.is_file() and p.name!='SHA256SUMS')
        (directory/'SHA256SUMS').write_text(''.join(sha(p)+'  '+p.name+'\n' for p in files))
        prefix='mbox/evidence/rc/v'+self.manifest['releaseVersion']+'/'+self.sha+'/'+kind
        report=self.release/('oss-'+kind+'-verification.json')
        if (self.release/'.maintenance-evidence-relay').exists():
            marker=self.release/('.'+kind+'-evidence-relay-ready.json')
            if report.exists(): report.unlink()
            atomic(marker,{'releaseSha':self.sha,'prefix':prefix,'evidenceDirectory':str(directory),'report':str(report)})
            for _ in range(600):
                if report.exists(): break
                time.sleep(1)
            require(report.exists(),'OSS relay timeout: '+kind)
        else:
            self.run([self.release/'upload-oss-verified.sh',directory,prefix],env={'MBOX_OSS_VERIFICATION_REPORT':str(report)})
        receipt=json.loads(report.read_text())
        require(receipt.get('verified') is True and receipt.get('authMode')=='EcsRamRole' and receipt.get('prefix')==prefix,'OSS readback identity mismatch')
        actual={o['key']:(o['sha256'],o['bytes'],o['verified']) for o in receipt['objects']}
        expected={prefix+'/'+p.name:(sha(p),p.stat().st_size,True) for p in files+[directory/'SHA256SUMS']}
        require(actual==expected,'OSS readback bytes differ from this exact stage')
        marker=self.release/('.'+kind+'-evidence-relay-ready.json')
        if marker.exists(): marker.unlink()
    def backup(self):
        self.assert_zero(); evidence=self.release/'maintenance-restore-source.json'
        env={**self.pg_env,'DATABASE_SERVICE':self.backupservice,'MBOX_EXPECTED_RESTORE_DATABASE':self.database,'MBOX_RESTORE_PYTHON':self.controller_python}
        self.run([self.release/'restore-postgres.sh','capture',evidence],env=env)
        path=Path(self.run([self.release/'backup-postgres.sh'],env={**env,'BACKUP_DIR':str(self.root/'backups')}))
        require(path.is_file() and Path(str(path)+'.sha256').is_file(),'post-drain backup missing')
        self.assert_zero()
        report=self.release/'maintenance-restore-verification.json'
        self.run([self.release/'restore-postgres.sh','verify',path],env={**env,'ADMIN_DATABASE_SERVICE':self.clusteradmin,'MBOX_EXPECTED_RESTORE_SCHEMA_VERSION':str(json.loads(evidence.read_text())['schemaVersion']),'MBOX_EXPECTED_RESTORE_MANIFEST':str(self.previous/'release-manifest.json'),'MBOX_EXPECTED_RESTORE_EVIDENCE':str(evidence),'MBOX_RESTORE_REPORT':str(report),'MBOX_CONFIRM_RESTORE':'VERIFY'})
        stage=self.release/'oss-maintenance-backup'; stage.mkdir(mode=0o700,exist_ok=True)
        for source in (path,evidence,report,self.previous/'release-manifest.json',self.directory/'provider-funds-preview.json',self.directory/'provider-funds-baseline.json'): shutil.copy2(source,stage/source.name)
        self.archive('maintenance-backup',stage)
        self.journal.append('backup-verified',{'releaseSha':self.sha,'backup':str(path),'sha256':sha(path),'restoreReportSha256':sha(report)})
    def verified_backup_stage(self,record):
        origin=record.get('releaseSha')
        if origin is None:
            # Legacy events inherit the exact active target at their position
            # in the verified chain, then still require manifest/file proofs.
            found=False
            for event in self.journal.records:
                if event['event'] in ('bound','forward-target'): origin=event['data']['forwardRecoveryTarget']['releaseSha']
                if event['event']=='backup-verified' and event['data']==record:
                    found=True;break
            require(found,'legacy backup event is not in the verified journal')
        allowed={r['data']['forwardRecoveryTarget']['releaseSha'] for r in self.journal.records if r['event'] in ('bound','forward-target')}
        require(origin in allowed and re.fullmatch('[a-f0-9]{40}',origin),'backup archive is not bound to this transition')
        release=self.root/'releases'/origin[:7]
        require(json.loads((release/'release-manifest.json').read_text())['releaseSha']==origin,'backup origin manifest mismatch')
        stage=release/'oss-maintenance-backup'
        require(sha(Path(record['backup']))==record['sha256'] and sha(stage/Path(record['backup']).name)==record['sha256'],'original verified backup bytes changed')
        require(sha(stage/'maintenance-restore-verification.json')==record['restoreReportSha256'],'original restore proof changed')
        return stage
    def start_candidate(self,readonly):
        existing=self.optional_container(self.candidate)
        if existing:
            self.run(['docker','update','--restart=no',self.candidate]); self.run(['docker','stop','-t','60',self.candidate]); self.run(['docker','rm',self.candidate])
        arguments=['docker','run','-d','--name',self.candidate,'--restart=no','--env-file',str(self.release/'app.env'),*self.args,*self.adapter,'--mount','type=bind,src='+str(self.store)+',dst=/run/mbox-config/store.json,readonly','--mount','type=bind,src='+str(self.catalog)+',dst=/run/mbox-config/catalog.json,readonly']
        if self.data_mount:
            mount=self.data_mount
            arguments+=['--mount','type='+mount['type']+',src='+mount['source']+',dst=/data'+(',readonly' if readonly or mount['readOnly'] else '')]
        else: arguments+=['--volume','mbox-maintenance-'+self.sha[:7]+':/data'+(':ro' if readonly else '')]
        if readonly: arguments+=['--env','MBOX_RUNTIME_ROLE=contract_candidate','--env','MBOX_START_WORKERS=false','--env','PGOPTIONS=-c default_transaction_read_only=on']
        self.run([*arguments,self.image])
        self.journal.append('candidate-started',{'containerId':self.inspect(self.candidate)['Id'],'readOnly':readonly,'releaseSha':self.sha})
        for _ in range(90):
            try:
                status,ready=self.request('http://'+self.ip(self.candidate)+':8787/api/ready')
                if status==200:
                    require(ready['commitSha']==self.sha and ready['releaseImageDigest']==self.manifest['imageDigest'] and int(ready['schemaVersion'])==int(self.schema),'candidate identity/schema mismatch')
                    require(ready['writeEnabled']==(not readonly),'candidate write mode mismatch')
                    self.save('maintenance-'+('readonly' if readonly else 'worker')+'-ready.json',ready); return
            except (OSError,ValueError): pass
            time.sleep(2)
        raise Blocked('candidate did not become ready')
    def assert_running_identities(self):
        rows=json.loads(self.sql("SELECT COALESCE(json_agg(json_build_object('pid',pid,'login',usename,'application',application_name)),'[]') FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()",database=self.database))
        self.save('maintenance-running-identities.json',rows)
        require(rows and all(row['login']==self.login for row in rows),'unexpected database writer login during recovery')
        names={row['application'] for row in rows}
        require('mbox-normalized:'+self.sha[:16] in names and 'mbox-normalized-worker:'+self.sha[:16] in names,'actual API and independent worker backends must both be observed')
    def funds_snapshot(self):
        # SET row_security=off fails instead of silently observing only one store.
        query="BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL row_security=off; SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO,YMD'; SELECT COALESCE(json_agg(f),'[]') FROM ("+FUNDS_CLASSIFICATION_SQL+") f; COMMIT;"
        # psql --quiet removes transaction command tags from machine-readable JSON.
        result=self.run(['psql','-XqAt','--set=ON_ERROR_STOP=1','--dbname=service='+self.clusteradmin+' dbname='+self.database],input=query,env=self.pg_env)
        rows=json.loads(result)
        require(all(re.fullmatch('[a-f0-9]{64}',r['facts_sha256']) for r in rows),'invalid provider fact fingerprint')
        return rows
    def funds_preview(self):
        path=self.directory/'provider-funds-preview.json'
        if not path.exists():
            require(not self.journal.has('drain-intent'),'original provider preview missing after drain')
            atomic(path,{'rows':self.funds_snapshot()})
            self.journal.append('provider-preview',{'sha256':sha(path)})
        else:
            record=next((r['data'] for r in self.journal.records if r['event']=='provider-preview'),None)
            require(record and record['sha256']==sha(path),'original provider preview binding changed')
        rows=json.loads(path.read_text())['rows']
        self.save('maintenance-provider-preflight.json',{'historicalCandidates':sum(r['classification'].startswith('baseline_candidate:') for r in rows),'requiresOriginalIdReconciliation':sum(r['classification'].startswith('block:') for r in rows),'previewSha256':sha(path)})
    def freeze_funds(self):
        path=self.directory/'provider-funds-baseline.json'
        record=next((r['data'] for r in self.journal.records if r['event']=='provider-baseline'),None)
        if record:
            require(path.exists() and sha(path)==record['sha256'],'original provider baseline missing or changed');return
        require(not self.journal.has('backup-verified') and not self.journal.has('schema-provisioned'),'cannot refresh original provider baseline')
        if not path.exists():
            preview=json.loads((self.directory/'provider-funds-preview.json').read_text())['rows']
            permitted={funds_key(r):r for r in preview if r['classification'].startswith('baseline_candidate:')}
            rows=[r for r in self.funds_snapshot() if r['classification'].startswith('baseline_candidate:')]
            require(all(permitted.get(funds_key(r))==r for r in rows),'historical candidate changed since preflight; explicit review required')
            atomic(path,{'sourceLive':self.plan['sourceLive'],'previewSha256':sha(self.directory/'provider-funds-preview.json'),'rows':rows})
        saved=json.loads(path.read_text())
        require(saved.get('sourceLive')==self.plan['sourceLive'] and saved.get('previewSha256')==sha(self.directory/'provider-funds-preview.json'),'unjournaled provider baseline binding mismatch')
        permitted={funds_key(r):r for r in json.loads((self.directory/'provider-funds-preview.json').read_text())['rows'] if r['classification'].startswith('baseline_candidate:')}
        require(all(permitted.get(funds_key(r))==r for r in saved['rows']),'unjournaled provider baseline contains unreviewed facts')
        self.journal.append('provider-baseline',{'sha256':sha(path)})
    def historical_evidence(self):
        return json.loads(self.run(['psql','-XqAt','--set=ON_ERROR_STOP=1','--dbname=service='+self.clusteradmin+' dbname='+self.database],
          input="BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL row_security=off; SET LOCAL TIME ZONE 'UTC'; SET LOCAL DateStyle='ISO,YMD'; SET LOCAL statement_timeout='8s'; "+historical_review_sql(self.plan['historicalPaymentReview']['attempts'])+" COMMIT;",env=self.pg_env))
    def apply_historical_review(self):
        review=self.plan.get('historicalPaymentReview')
        if review is None: return
        require(review.get('reason')=='business-confirmed-system-duplicate-settled-orders','explicit historical review reason required')
        evidence=self.historical_evidence()
        historical_review_matches(self.funds_snapshot(),evidence,review['attempts'])
        preview=self.directory/'provider-funds-preview.json'
        record=next((r['data'] for r in self.journal.records if r['event']=='provider-preview'),None)
        require(record and sha(protected(preview))==record['sha256'],'original review preview changed')
        historical_review_matches(json.loads(preview.read_text())['rows'],evidence,review['attempts'])
        path=self.directory/'historical-payment-review.json'
        if path.exists():
            saved=json.loads(protected(path).read_text())
            require(saved['review']==review and saved['rows']==historical_review_matches(self.funds_snapshot(),evidence,review['attempts']),
              'historical review receipt no longer matches current facts')
            if not self.journal.has('historical-payment-review'):
                self.journal.append('historical-payment-review',{'sha256':sha(path),'count':len(review['attempts'])})
            self.reviewed_funds(self.funds_snapshot())
            return
        self.assert_zero()
        # One fenced transaction; no payment/refund/receipt/ledger mutation and
        # no provider I/O. SQL literals are JSON-encoded then hex-encoded.
        selected={(r['tenant_id'],r['store_id'],r['id']) for r in review['attempts']}
        statements=["BEGIN; SET LOCAL row_security=off; SET LOCAL statement_timeout='8s';"]
        for row in evidence:
            if (row['tenant_id'],row['store_id'],row['id']) not in selected: continue
            t,s,p=row['tenant_id'],row['store_id'],row['id']
            payload=canonical({'version':1,'fingerprint':row['fingerprint'],'association':row['facts']}).hex()
            statements.append("SELECT set_config('app.tenant_id','{t}',true),set_config('app.store_id','{s}',true);".format(t=t,s=s))
            statements.append("DO $review$ BEGIN IF EXISTS(SELECT 1 FROM mbox.audit_events WHERE tenant_id='{t}' AND store_id='{s}' AND object_type='payment' AND object_id='{p}' AND action='payment.historical_attempt.held' AND (after_snapshot->>'fingerprint' IS DISTINCT FROM '{fingerprint}' OR after_snapshot->>'version' IS DISTINCT FROM '1')) THEN RAISE EXCEPTION 'existing historical association does not match current approved evidence'; END IF; END $review$;".format(t=t,s=s,p=p,fingerprint=row['fingerprint']))
            statements.append("INSERT INTO mbox.audit_events(tenant_id,store_id,actor_type,actor_ref,action,object_type,object_id,after_snapshot,reason,business_date) SELECT '{t}','{s}','system','approved-maintenance-review','payment.historical_attempt.held','payment','{p}',convert_from(decode('{payload}','hex'),'UTF8')::jsonb,'business-confirmed-system-duplicate-settled-orders',mbox.current_operating_business_date('{t}','{s}') WHERE NOT EXISTS (SELECT 1 FROM mbox.audit_events WHERE tenant_id='{t}' AND store_id='{s}' AND object_id='{p}' AND action='payment.historical_attempt.held');".format(t=t,s=s,p=p,payload=payload))
            statements.append("INSERT INTO mbox.payment_reconciliation_states(payment_id,tenant_id,store_id,phase,automatic_query_stopped_at,stop_reason) VALUES('{p}','{t}','{s}','stopped',clock_timestamp(),'historical_system_attempt_review') ON CONFLICT(payment_id) DO UPDATE SET phase='stopped',next_query_at=NULL,lease_until=NULL,automatic_query_stopped_at=COALESCE(mbox.payment_reconciliation_states.automatic_query_stopped_at,clock_timestamp()),stop_reason='historical_system_attempt_review',updated_at=clock_timestamp();".format(t=t,s=s,p=p))
        statements.append('COMMIT;')
        self.run(['psql','-XqAt','--set=ON_ERROR_STOP=1','--dbname=service='+self.clusteradmin+' dbname='+self.database],input='\n'.join(statements),env=self.pg_env)
        rows=historical_review_matches(self.funds_snapshot(),self.historical_evidence(),review['attempts'])
        atomic(path,{'review':review,'rows':rows})
        self.journal.append('historical-payment-review',{'sha256':sha(path),'count':len(review['attempts'])})
    def reviewed_funds(self,rows):
        path=self.directory/'historical-payment-review.json'
        if not path.exists(): return []
        record=next((r['data'] for r in reversed(self.journal.records) if r['event']=='historical-payment-review'),None)
        require(record and sha(protected(path))==record['sha256'],'historical review receipt changed')
        value=json.loads(path.read_text())
        require(value['review']==self.plan.get('historicalPaymentReview'),'historical review plan changed')
        current=historical_review_matches(rows,self.historical_evidence(),value['review']['attempts'])
        require(current==value['rows'],'historical attempt changed after review')
        return current
    def pending_funds(self):
        path=self.directory/'provider-funds-baseline.json'
        record=next((r['data'] for r in self.journal.records if r['event']=='provider-baseline'),None)
        require(record and path.exists() and sha(path)==record['sha256'],'provider baseline unavailable or changed')
        baseline=json.loads(path.read_text())['rows'];rows=self.funds_snapshot();keys={funds_key(r) for r in rows};resolved=set()
        # Missing rows never cancel new blockers by count. Verify each original
        # subject really reached a terminal state / its observation was consumed.
        for row in baseline:
            key=funds_key(row)
            if key in keys: continue
            require(all(re.fullmatch('[a-fA-F0-9-]{36}',row[k]) for k in ('id','tenant_id','store_id')),'invalid persisted subject identity')
            if row['kind']=='observation':
                query="SELECT EXISTS (SELECT 1 FROM mbox.verified_provider_observations WHERE id=$3::uuid AND tenant_id=$1::uuid AND store_id=$2::uuid AND consumed_at IS NOT NULL AND consumed_operation IS NOT NULL AND consumed_idempotency_key IS NOT NULL)"
            else: query=FUNDS_RESOLVED_SQL[row['kind']]
            for index,keyname in enumerate(('tenant_id','store_id','id'),1):query=query.replace('$'+str(index),"'"+row[keyname]+"'")
            value=self.run(['psql','-XqAt','--set=ON_ERROR_STOP=1','--dbname=service='+self.clusteradmin+' dbname='+self.database],input="BEGIN READ ONLY; SET LOCAL row_security=off; "+query+"; COMMIT;",env=self.pg_env)
            if value=='t': resolved.add(key)
        result=funds_delta(rows,baseline,resolved,self.reviewed_funds(rows))
        # Even permitted manual-review payments may have late provider success.
        potential=self.sql("SELECT (SELECT count(*) FROM mbox.payments WHERE provider IN ('postar','wechat') AND status IN ('created','pending'))+(SELECT count(*) FROM mbox.refunds WHERE status='processing' AND (provider_submission_state IN ('submitting','submitted') OR auto_execute_requested_at IS NOT NULL))+(SELECT count(*) FROM mbox.payment_provider_actions WHERE state IN ('creating','unknown'))",database=self.database)
        result['hasPotentialExternalChange']=int(potential)>0
        return result
    def fail_closed(self,reason):
        if not self.draining and self.journal and self.journal.records[-1]['event']=='completed': return
        if not self.draining and not (self.journal and self.journal.has('drain-intent')): return
        # Best effort at each independent fence; one failure must not skip the
        # remaining ones. Never start sourceLive or restore old runtime secrets.
        errors=[]
        for action in [lambda:self.route(True), *[lambda role=role:self.sql('ALTER ROLE "'+role+'" NOLOGIN;') for role in [self.login,*self.plan.get('retiredLogins',[])]]]:
            try: action()
            except Exception as e: errors.append(type(e).__name__)
        for unit in self.plan.get('systemdUnits',[]):
            try: self.fence_unit(unit)
            except Exception as e: errors.append(type(e).__name__)
        for container in list(dict.fromkeys([self.candidate,'mbox-app',*self.plan['writerContainerIds'], *[r['data']['containerId'] for r in self.journal.records if r['event']=='candidate-started']] if self.journal else [self.candidate,'mbox-app',*self.plan['writerContainerIds']])):
            try:
                actual=self.optional_container(container)
                if actual is None: continue
                identity=actual['Id']
                self.run(['docker','update','--restart=no',identity]); self.run(['docker','stop','-t','60',identity])
                stopped=self.inspect(identity)
                require(not stopped['State']['Running'] and stopped['HostConfig']['RestartPolicy']['Name']=='no','writer stop/restart fence not verified')
            except Exception as e: errors.append(type(e).__name__)
        try: self.assert_zero()
        except Exception as e: errors.append(type(e).__name__)
        if self.journal: self.journal.append('maintenance-required',{'reason':reason,'fenceErrors':errors,'epoch':(self.directory/'business-write-epoch.json').exists()})
        self.save('maintenance-operator-state.json',{'status':'maintenance-required','recovery':'same-schema-forward-repair','sourceLiveStartAllowed':False,'epoch':(self.directory/'business-write-epoch.json').exists(),'fenceErrors':errors})
        return not errors
    def execute(self):
        binding={'transitionId':self.plan['transitionId'],'sourceLive':self.plan['sourceLive'],'forwardRecoveryTarget':{'releaseSha':self.sha,'imageDigest':self.manifest['imageDigest'],'schema':self.schema,'migrationDigest':self.manifest['migration']['digest']},'planSha256':sha(self.release/'maintenance-plan.json')}
        self.journal=Journal(self.directory,binding,self.plan.get('recoveryFromJournalHash'))
        require(self.journal.records[-1]['event']!='completed','transition already completed; use a new explicit maintenance plan')
        self.reentry=self.journal.has('drain-intent')
        self.draining=self.reentry
        if self.reentry: self.fail_closed('reentry-fence-before-preflight')
        self.preflight()
        require(self.journal.records[-1]['event']!='completed','transition already completed; do not replay')
        if self.journal.has('drain-intent'):
            self.draining=True
            self.install_guard()
            # Re-entry starts fenced and reconstructs state from journal. A
            # failed candidate is stopped before examining/migrating the DB.
            self.fail_closed('reentry'); self.start_ingress(); self.assert_zero(); self.freeze_funds()
        else: self.drain()
        for role in self.plan['retiredLogins']:
            require(re.fullmatch('[A-Za-z0-9_]{1,63}',role),'invalid retired login')
            require(self.sql("SELECT rolcanlogin FROM pg_roles WHERE rolname='"+role+"'")=='f','retired high-privilege login is not fenced')
        if not self.journal.has('backup-verified'): self.backup()
        else:
            original=next(r['data'] for r in self.journal.records if r['event']=='backup-verified')
            stage=self.release/'oss-maintenance-backup'; stage.mkdir(mode=0o700,exist_ok=True)
            # A prior target may have failed before backup. Bind the first
            # verified archive to its actual target, not the first attempted SHA.
            oldstage=self.verified_backup_stage(original)
            for file in oldstage.iterdir():
                if file.is_file() and file.name!='SHA256SUMS' and file.resolve()!=(stage/file.name).resolve(): shutil.copy2(file,stage/file.name)
            self.archive('maintenance-backup',stage)
        self.sql('ALTER ROLE "'+self.login+'" LOGIN;')
        self.restricted(); self.assert_zero()
        # Migrations are checksum-idempotent; a partial DDL chain is resumed
        # using the exact same immutable package, never another backup.
        self.maintenance_command('dist-normalized/server/migrate-normalized.js')
        self.maintenance_command('dist-normalized/server/provision-normalized-release.js','--store=/run/mbox-config/store.json','--catalog=/run/mbox-config/catalog.json')
        self.journal.append('schema-provisioned')
        self.apply_historical_review()
        self.restricted(); self.assert_zero(); self.start_candidate(True)
        self.run(['docker','stop','-t','60',self.candidate]); self.assert_zero()
        # No public GET or business smoke before this durable epoch. Even an
        # empty worker tick is conservatively treated as a new write domain.
        self.journal.epoch('before-first-worker-or-callback-replay')
        stage=self.release/'oss-maintenance-epoch'; stage.mkdir(mode=0o700,exist_ok=True)
        epoch_sources=[self.directory/'journal.jsonl',self.directory/'business-write-epoch.json']
        if (self.directory/'historical-payment-review.json').exists(): epoch_sources.append(protected(self.directory/'historical-payment-review.json'))
        for source in epoch_sources: shutil.copy2(source,stage/source.name)
        self.archive('maintenance-epoch',stage)
        self.start_candidate(False); self.control('target','POST','http://'+self.ip(self.candidate)+':8787')
        stable=0
        for _ in range(90):
            queue=self.control('replay','POST'); funds=self.pending_funds(); self.save('maintenance-provider-reconciliation.json',{'queue':queue,'funds':funds})
            if queue['pending']==0 and queue['active']==0 and funds['blockingCount']==0: stable+=1
            else: stable=0
            if stable>=3: break
            time.sleep(2)
        require(stable>=3,'unresolved in-flight provider/callback facts; retain maintenance and original identifiers')
        self.restricted(); self.assert_running_identities()
        # Recheck actual ready after reconciliation, including worker failures.
        status,ready=self.request('http://'+self.ip(self.candidate)+':8787/api/ready'); require(status==200,'worker readiness degraded')
        self.run([self.release/'verify-public-app.sh','http://'+self.ip(self.candidate)+':8787',self.sha,self.manifest['imageDigest'],str(self.schema),self.tier,'15'])
        old=self.optional_container('mbox-app')
        if old:
            require(not old['State']['Running'],'writer unexpectedly restarted')
            self.run(['docker','rename','mbox-app','mbox-retired-'+old['Id'][:12]])
        self.run(['docker','rename',self.candidate,'mbox-app']); self.candidate='mbox-app'
        # Keep restart=no until all public/callback evidence is complete. A
        # crash or lost SSH connection leaves the durable route in maintenance.
        self.route(False)
        self.run([self.release/'verify-public-app.sh',self.public,self.sha,self.manifest['imageDigest'],str(self.schema),self.tier,'15'])
        for _ in range(10):
            queue=self.control('replay','POST')
            if queue['pending']==0 and queue['active']==0: break
            time.sleep(1)
        require(queue['pending']==0 and queue['active']==0,'callback spool still active after route switch')
        self.journal.append('public-verified')
        deployment={'schemaVersion':1,'releaseSha':self.sha,'imageDigest':self.manifest['imageDigest'],'platformImageDigest':self.manifest['platformImageDigest'],'tier':self.tier,'rollbackMode':'planned_maintenance_forward_only','sourceLive':self.plan['sourceLive'],'forwardRecoveryTarget':binding['forwardRecoveryTarget'],'maintenanceDirectory':str(self.directory),'maintenanceIngress':self.ingress,'transitionId':self.plan['transitionId']}
        self.save('deployment-manifest.json',deployment)
        for kind in ('deployment','completion'):
            stage=self.release/('oss-'+kind); stage.mkdir(mode=0o700,exist_ok=True)
            for source in (self.release/'deployment-manifest.json',self.directory/'journal.jsonl',self.release/'maintenance-provider-reconciliation.json'): shutil.copy2(source,stage/source.name)
            self.archive(kind,stage)
        self.run(['docker','update','--restart=unless-stopped','mbox-app'])
        self.run(['ln','-sfn',self.release,self.root/'current']); self.run(['ln','-sfn',self.release/'app.env',self.root/'.env'])
        shutil.copy2(self.release/'app.env',self.root/'secrets/app.env')
        self.journal.append('completed'); self.save('maintenance-operator-state.json',{'status':'completed','retiredLogins':self.plan['retiredLogins'],'retiredServices':self.plan['systemdUnits'],'sourceLiveStartAllowed':False,'epoch':True})


def inventory(release):
    """Read-only inventory template; never prints credentials or process argv."""
    require(os.geteuid()==0,'inventory requires root')
    release=Path(release); manifest=json.loads((release/'release-manifest.json').read_text())
    def run(args): return subprocess.run(args,check=True,text=True,capture_output=True).stdout.strip()
    source=json.loads(run(['docker','inspect','mbox-app']))[0]
    env=dict(x.split('=',1) for x in source['Config']['Env'] if '=' in x)
    actual=json.loads(run(['docker','exec',source['Id'],'node','--input-type=module','-e',"import pg from 'pg';const p=new pg.Pool({connectionString:process.env.DATABASE_URL});console.log(JSON.stringify((await p.query('select current_user as login')).rows[0]));await p.end()" ]))
    units=run(['systemctl','list-unit-files','--no-legend','--no-pager'])
    names=[line.split()[0] for line in units.splitlines() if line.strip()]
    selected=[name for name in names if name in ('cron.service','crond.service') or (name.startswith('mbox-') and re.search(r'(worker|watchdog|runtime|app|scheduler)',name))]
    adapters=[item['Source'] for item in source['Mounts'] if item['Type']=='bind' and item['Destination']=='/app/worker-adapters' and not item['RW']]
    require(len(adapters)==1,'one immutable worker adapter mount required')
    adapter=Path(adapters[0]); tree=[(str(p.relative_to(adapter)),sha(p)) for p in sorted(adapter.rglob('*')) if p.is_file()]
    containers=json.loads(run(['docker','inspect',*run(['docker','ps','--no-trunc','-q']).splitlines()]))
    callback=env.get('POSTAR_CALLBACK_URL','');require(callback,'configured callback URL required')
    plan={'mode':'planned-maintenance-forward-only','transitionId':'maintenance-'+time.strftime('%Y%m%d%H%M%S'),'targetReleaseSha':manifest['releaseSha'],'targetImageDigest':manifest['imageDigest'],'sourceLive':{'containerId':source['Id'],'platformImageDigest':source['Image'],'releaseSha':source['Config']['Labels']['org.opencontainers.image.revision'],'environmentSha256':hashlib.sha256(canonical(sorted(source['Config']['Env']))).hexdigest(),'releaseDirectory':str(Path('/opt/mbox/current').resolve())},'retiredLogins':[actual['login']],'persistentMounts':[{'type':x['Type'],'source':x.get('Name') if x['Type']=='volume' else x['Source'],'target':x['Destination'],'readOnly':not x['RW']} for x in source['Mounts'] if x['Destination']!='/app/worker-adapters'],'writerContainerIds':[c['Id'] for c in containers if c['Name']!='/mbox-caddy'],'workerAdapterDirectory':str(adapter),'workerAdapterTreeSha256':hashlib.sha256(canonical(tree)).hexdigest(),'systemdUnits':selected,'systemdInventorySha256':systemd_inventory_sha256(units),'callbackUrls':sorted({callback,callback.replace('/payments/','/refunds/')}),'controllerPython':str(Path(sys.executable).resolve()),'clusterAdminService':'REPLACE_WITH_PREPARED_CLUSTER_ADMIN_SERVICE'}
    print(json.dumps(plan,indent=2))

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('release'); parser.add_argument('tier'); parser.add_argument('public'); parser.add_argument('--hold',action='store_true'); parser.add_argument('--watchdog',action='store_true'); parser.add_argument('--inventory',action='store_true'); parser.add_argument('--verify-completed-withdrawals',action='store_true'); parser.add_argument('--ordinary-release'); args=parser.parse_args()
    require(args.ordinary_release is None or args.verify_completed_withdrawals,'ordinary release is only valid for read-only completed verification')
    os.umask(0o077)
    if args.inventory:
        inventory(args.release); return 0
    if args.verify_completed_withdrawals:
        try: print(json.dumps(Host(args.release,args.tier,args.public).verify_completed_withdrawals(args.ordinary_release))); return 0
        except Exception as error:
            print(str(error) if isinstance(error,Blocked) else type(error).__name__,file=sys.stderr); return 1
    host=None
    def interrupted(signum,frame): raise Blocked('interrupted '+str(signum))
    signal.signal(signal.SIGTERM,interrupted); signal.signal(signal.SIGINT,interrupted); signal.signal(signal.SIGHUP,interrupted)
    try:
        host=Host(args.release,args.tier,args.public)
        if args.watchdog:
            host.watchdog()
        elif args.hold:
            host.draining=True
            path=host.directory/'journal.jsonl'; require(path.exists(),'persistent maintenance journal required')
            records=[json.loads(line) for line in path.read_text().splitlines()]
            latest=next(x['data'] for x in reversed(records) if x['event'] in ('bound','forward-target'))
            host.journal=Journal(host.directory,latest)
            host.fail_closed('post-cutover-verification-failed'); host.install_guard()
        else: host.execute()
    except Exception as error:
        if host:
            try: host.fail_closed(type(error).__name__)
            except Exception: pass
        # Controlled errors contain paths/identities only, never subprocess
        # stderr or connection strings. Unexpected errors are type-only.
        print(str(error) if isinstance(error,Blocked) else type(error).__name__,file=sys.stderr); return 1
    return 0
if __name__=='__main__': sys.exit(main())
