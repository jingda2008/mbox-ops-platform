$ErrorActionPreference='Stop'
$parent=Split-Path -Parent $PSScriptRoot
foreach($entry in @(@('print-ticket.ps1','New-EscPosTicketBytes'),@('raw-ticket.tests.ps1','Decode-Ticket'))){
  $tokens=$null;$errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $parent $entry[0]),[ref]$tokens,[ref]$errors)
  if($errors.Count){throw 'PowerShell syntax invalid'}
  $name=$entry[1]
  $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
  . ([scriptblock]::Create($fn.Extent.Text))
}
$gbk=[Text.Encoding]::GetEncoding(936)
$number='单号：20260914-213508-004271'
$trace='原始追溯码：session-0123456789abcdef0123456789abcdef'
foreach($profile in @('escpos_80','escpos_58')){
  $width=if($profile -eq 'escpos_58'){32}else{42}
  $records=Decode-Ticket (New-EscPosTicketBytes "$number`n合计：￥100.00`n$trace" $profile) $width
  if(@($records|Where-Object{$_.Text -eq $number -and $_.Size -eq 0}).Count -ne 1){throw 'OCR number wraps or changes'}
  if(-not (($records|ForEach-Object{$_.Text}) -join '').Contains($trace)){throw 'original trace truncated'}
  Write-Output "PASS $profile OCR number on one line, full trace preserved, single cut"
}
