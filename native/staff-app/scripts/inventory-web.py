#!/usr/bin/env python3
"""Capture the actual web baseline; this inventory never marks a feature implemented."""
import hashlib, json, re, subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[3]
ui=root/'src/normalized-ui'
routes=re.findall(r"path === '([^']+)'\) return '([^']+)'",(ui/'normalized-staff-routes.ts').read_text())
files=[root/'src/normalized-api.ts',*sorted(ui.rglob('*.tsx')),*sorted((ui/'staff-actions').glob('*.ts'))]
files=[p for p in files if '.test.' not in p.name]
inventory={'baseline':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'routes':[{'path':p,'module':m} for p,m in routes],'sources':[]}
for p in files:
    text=p.read_text()
    inventory['sources'].append({'path':str(p.relative_to(root)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'apiReferences':sorted(set(re.findall(r"['\"`](/api/[^'\"`\s]+)",text)))})
out=root/'native/staff-app/shared/web-reference-inventory.json'
out.write_text(json.dumps(inventory,ensure_ascii=False,indent=2)+'\n')
print(f'{len(routes)} web routes; {len(files)} source files inventoried. Implementation status is tracked separately.')
