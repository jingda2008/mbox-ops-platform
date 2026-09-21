"""Build the note-size-only upgrade from immutable PrintBridge 1.0.10.
No service, print queue, backend, or credentials are accessed.
"""
import argparse, copy, hashlib, json, subprocess, tempfile, zipfile
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--previous-package',type=Path,required=True)
p.add_argument('--pwsh',type=Path,required=True)
a=p.parse_args();root=Path(__file__).resolve().parents[1]
hashof=lambda b:hashlib.sha256(b).hexdigest()
assert hashof(a.previous_package.read_bytes())=='412b3ee4fd61030da7a37214049feb8809b82bce4bebab6b7c6e7ec7efdf9fe3'
with zipfile.ZipFile(a.previous_package) as z:
    assert z.testzip() is None
    old={n:z.read(n) for n in z.namelist()}
manifest=json.loads(old['manifest.json'])
assert set(old)==set(manifest['files'])|{'manifest.json'}
for n,h in manifest['files'].items():assert hashof(old[n])==h,n
payload={n:b for n,b in old.items() if n!='manifest.json'}
windows=lambda s:s.replace('\r\n','\n').replace('\n','\r\n').encode('utf-8-sig')
out=root/'artifacts/print-bridge-one-click-1.0.11-r1';out.mkdir(parents=True,exist_ok=True)
package=out/'MBOX-PrintBridge-1.0.11-OneClick-r1';package.mkdir(exist_ok=True)
proof={'baselineVersion':'1.0.10','version':'1.0.11','changedKinds':['bar_production','kitchen_production'],'physicalVerified':False,'windowsNativeVerified':False}
with tempfile.TemporaryDirectory(prefix='mbox-111-') as temp:
    temp=Path(temp)
    for n in ('bridge.mjs','print-ticket.ps1'):(temp/n).write_bytes(old[n])
    subprocess.run(['node',str(root/'scripts/patch-production-print-notes.mjs'),str(temp/'bridge.mjs'),str(temp/'new.mjs')],check=True)
    payload['bridge.mjs']=(temp/'new.mjs').read_bytes()
    # Compare actual renderers. Only note size may differ, including empty/long notes.
    kinds=['bar_production','kitchen_production','production_notice','delivery','cashier_payment','cashier_settlement','cashier_refund','table_settlement','daily_settlement','order_summary']
    def render(bridge,snapshot):
        f=temp/'snapshot.json';f.write_text(json.dumps(snapshot,ensure_ascii=False))
        return json.loads(subprocess.check_output(['node',str(bridge),'render-layout',str(f)]))
    cases=0
    for kind in kinds:
        for note in [None,'少冰，不要香菜','不要冰块，少糖，不加香菜；请分开制作并确认过敏原。'*12]:
            snapshot={'schemaVersion':1,'kind':kind,'title':'系统测试','subtitle':'M-BOX 现场系统','test':True,'issuedAt':'2026-09-20T18:00:00Z','businessDate':'2026-09-20','ticketReference':'TEST-NOTE-111','tableCode':'TEST','guestCount':4,'operatorLabel':'测试','note':note,'payment':None,'totalAmountMinor':12300,'currency':'CNY','lines':[{'name':'测试饮品','quantity':2,'note':note},{'name':'无备注商品','quantity':1}]}
            before=render(temp/'bridge.mjs',snapshot);after=render(temp/'new.mjs',snapshot)
            expected=copy.deepcopy(before)
            if kind in proof['changedKinds']:
                for row in expected['rows']:
                    if row.get('type')=='text' and row.get('text','').startswith('备注：'):row['size']=17
            assert after==expected,(kind,note)
            if kind in proof['changedKinds'] and note:
                suffix='long' if len(note)>100 else 'short'
                (out/f'{kind}-{suffix}.layout.json').write_text(json.dumps(after,ensure_ascii=False).replace("{{PRINT_TIME}}","2026-09-21 02:30:00"))
                (out/f'{kind}-{suffix}-before.layout.json').write_text(json.dumps(before,ensure_ascii=False).replace("{{PRINT_TIME}}","2026-09-21 02:30:00"))
            cases+=1
    proof['rendererComparisons']=cases
    (temp/'bridge.mjs').write_bytes(payload['bridge.mjs'])
    catalog=json.loads(old['test-catalog.json']);unchanged=0
    for entry in catalog:
        name=entry['file'];target=name in ['test-bar_production.layout.json','test-kitchen_production.layout.json']
        if target:
            layout=json.loads(old[name])
            for row in layout['rows']:
                if row.get('type')=='text' and row.get('text','').startswith('备注：'):row['size']=17
            payload[name]=(json.dumps(layout,ensure_ascii=False,indent=2)+'\n').encode()
        f=temp/name;f.write_bytes(payload[name]);prefix=temp/'raw'
        subprocess.run([str(a.pwsh.resolve()),'-NoLogo','-NoProfile','-File',str(root/'scripts/emit-checkout-print-preview.ps1'),'-BridgeDirectory',str(temp),'-LayoutPath',str(f),'-OutputPrefix',str(prefix)],check=True,stdout=subprocess.DEVNULL)
        hashes={profile:hashof((temp/f'raw-{profile}.bin').read_bytes()) for profile in ['escpos_58','escpos_80','windows_text']}
        if not target:
            assert hashes==entry['rawSha256'],name
            unchanged+=3
        entry['rawSha256']=hashes
    proof.update(profilePayloadsVerified=len(catalog)*3,unchangedNonProductionPayloads=unchanged)
    payload['test-catalog.json']=(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n').encode()
# Keep transport, encoding, logo, column layout, service transaction and rollback unchanged.
for name in ['print-ticket.ps1','upgrade-core.ps1','list-printers.ps1','MBOX-OneClick-Upgrade.cmd']:
    assert payload[name]==old[name]
upgrade=old['upgrade.ps1'].decode('utf-8-sig').replace('\r\n','\n').replace('1.0.10','1.0.11')
baseline='  $productionBaseHashes = @{\n'+''.join(f"    '{n}'='{manifest['files'][n]}'\n" for n in ['bridge.mjs','print-ticket.ps1','list-printers.ps1'])+'  }\n'
assert upgrade.count('  $validatedHashes = @{}')==1
upgrade=upgrade.replace('  $validatedHashes = @{}',baseline+'  $validatedHashes = @{}')
old_loop='@($originalHashes, $previousHashes, $latestHashes, $layoutHashes, $allTicketsHashes, $brand108Hashes, $brand109Hashes)'
assert upgrade.count(old_loop)==1
# This narrow update accepts the observed 1.0.10 baseline or an already identical 1.0.11.
upgrade=upgrade.replace(old_loop,'@($productionBaseHashes)')
payload['upgrade.ps1']=windows(upgrade)
payload['test-print.ps1']=windows(old['test-print.ps1'].decode('utf-8-sig').replace('1.0.10','1.0.11').replace('MBOX-PrintBridge-110-r1','MBOX-PrintBridge-111-r1').replace('MBOX-LAYOUT-110-','MBOX-LAYOUT-111-'))
payload['使用说明.txt']=windows('''M-BOX PrintBridge 1.0.11-r1 制作单备注放大

仅适用于原版1.0.10。只放大吧台、后厨制作单的商品备注与整单备注（两倍宽高）。
品名、数量、桌号、Logo、其他票种、原配对配置、打印队列及防重复记录保持原样。
长备注沿用原打印函数自动换行，纸张可能相应变长。

完整解压到新文件夹。先运行MBOX-Test-Only.cmd选择原打印机及实际纸宽，试打吧台/后厨制作单。
没有出单时运行MBOX-OneClick-Upgrade.cmd，允许管理员授权；自动校验、备份，失败尝试恢复。
不是首次安装工具，不会重新配对。未知修改或更高版本将停止覆盖。
升级后确认后台心跳1.0.11，并检查实际纸票。此包不需要更新后台。
未在门店Windows和打印机上安装验收；离线预览不证明实体打印机字库完全相同。
''')
manifest={'version':'1.0.11','packageRevision':'r1','files':{n:hashof(b) for n,b in payload.items()}}
payload['manifest.json']=(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode()
archive_path=out/(package.name+'.zip')
with zipfile.ZipFile(archive_path,'w',zipfile.ZIP_DEFLATED) as z:
    for n,b in sorted(payload.items()):
        (package/n).write_bytes(b)
        info=zipfile.ZipInfo(n,date_time=(2026,9,21,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;z.writestr(info,b)
with zipfile.ZipFile(archive_path) as z:
    assert z.testzip() is None
    for n,b in payload.items():assert z.read(n)==b
proof['sha256']=hashof(archive_path.read_bytes())
archive_path.with_suffix('.zip.sha256').write_text(f"{proof['sha256']}  {archive_path.name}\n")
(out/'build-evidence.json').write_text(json.dumps(proof,indent=2)+'\n')
print(json.dumps(proof,indent=2));print(archive_path)
