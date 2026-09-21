import json,runpy,sys,traceback
from pathlib import Path
try:
 sys.argv=['/root/LAB-final/fixture/run-inside.py',sys.argv[1]]
 runpy.run_path(sys.argv[0],run_name='__main__')
except BaseException as error:
 report={'verified':False,'exceptionType':type(error).__name__,'frames':[{'file':Path(f.filename).name,'line':f.lineno,'function':f.name} for f in traceback.extract_tb(error.__traceback__)]}
 Path('/root/LAB-final/error.json').write_text(json.dumps(report,indent=2)+'\n')
 raise SystemExit(1)
