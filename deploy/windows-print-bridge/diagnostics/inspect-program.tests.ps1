$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'inspect-program.ps1')
$temp=Join-Path ([IO.Path]::GetTempPath()) ('mbox-inspection-' + [guid]::NewGuid().ToString('N') + '.ps1')
try {
  [IO.File]::WriteAllText($temp,"WritePrinter; 0x1d,0x56; GetEncoding(936); secret='NEVER_EXPORT_ME'",[Text.UTF8Encoding]::new($true))
  $hash=(Get-FileHash -LiteralPath $temp).Hash
  $r=Get-MboxProgramSummary $temp
  if(-not $r.RawSpooler -or -not $r.CutMarkers -or -not $r.CodePage936 -or -not $r.Utf8Bom){throw 'raw markers missing'}
  if(($r|ConvertTo-Json)-match 'NEVER_EXPORT_ME'){throw 'source leaked'}
  if((Get-FileHash -LiteralPath $temp).Hash -ne $hash){throw 'source modified'}
  [IO.File]::WriteAllText($temp,'PrintDocument DrawString Microsoft YaHei UI UTF8')
  $r=Get-MboxProgramSummary $temp
  if(-not $r.GdiText -or -not $r.GdiDocument -or $r.RawSpooler -or $r.CutMarkers){throw 'gdi markers wrong'}
  if((Get-MboxProgramSummary ($temp + '.missing')).Read -ne 'unavailable'){throw 'missing file not handled'}
  foreach($f in Get-ChildItem $PSScriptRoot -Filter '*.ps1'){$t=$null;$e=$null;[Management.Automation.Language.Parser]::ParseFile($f.FullName,[ref]$t,[ref]$e)|Out-Null;if($e.Count){throw "syntax: $($f.Name)"}}
  $raw=Get-Content (Join-Path $PSScriptRoot 'diagnose.ps1') -Raw
  if($raw -match 'Stop-Service|Start-Service|Set-Printer|Remove-PrintJob|\.Print\(|WritePrinter|config\.json|journal\.json|Invoke-WebRequest'){throw 'unexpected mutation or private-data access'}
  Write-Output 'PASS program markers, no source content export, read-only file hash, missing file, script syntax and prohibited-operation guard'
}finally{Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue}
