#!/bin/bash
set -euo pipefail
if [[ $# -ne 1 ]]; then echo 'Usage: verify-keychain-simulator.sh <booted simulator UUID>' >&2; exit 2; fi
python3 - "$1" <<'PY'
import pathlib, subprocess, sys, time
simulator=sys.argv[1]
bundle='com.mbox.staff.native'
for mode,expected in [('write','PASS simulator keychain create/read/update'),('read','PASS simulator keychain relaunch/read/delete')]:
    container=subprocess.check_output(['xcrun','simctl','get_app_container',simulator,bundle,'data'],text=True).strip()
    result=pathlib.Path(container)/'Library/Caches/keychain-selftest-result.txt'
    result.unlink(missing_ok=True)
    subprocess.run(['xcrun','simctl','launch','--terminate-running-process',simulator,bundle,f'--mbox-keychain-{mode}-check'],check=True)
    for _ in range(100):
        if result.exists(): break
        time.sleep(0.1)
    text=result.read_text() if result.exists() else 'FAIL simulator probe did not return; install the Debug build first'
    print(text,flush=True)
    if not text.startswith(expected): raise SystemExit(1)
subprocess.run(['xcrun','simctl','launch','--terminate-running-process',simulator,bundle],check=True)
PY
