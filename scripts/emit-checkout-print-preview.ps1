# Offline only: load the exact packaged renderer functions without printer or service I/O.
param([Parameter(Mandatory=$true)][string]$BridgeDirectory,[Parameter(Mandatory=$true)][string]$LayoutPath,[Parameter(Mandatory=$true)][string]$OutputPrefix)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $BridgeDirectory 'print-ticket.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'printer syntax error'}
$functions=@($ast.FindAll({param($n) $n-is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name-in @('New-EscPosTicketBytes','New-StructuredEscPosTicketBytes','Add-ReceiptHeaderLogo')},$true))
if($functions.Count-ne 3){throw 'expected original renderer functions'}
foreach($fn in $functions){. ([scriptblock]::Create($fn.Extent.Text))}
$bridge=[IO.File]::ReadAllText((Join-Path $BridgeDirectory 'bridge.mjs'))
$logo=[regex]::Match($bridge,"const RECEIPT_HEADER_LOGO_BITS = '([^']+)'").Groups[1].Value
$text=[IO.File]::ReadAllText($LayoutPath)
if($text.Contains('{{PRINT_TIME}}')){throw 'freeze preview print time before generating bytes'}
foreach($profile in @('escpos_80','escpos_58','windows_text')){
  $bytes=New-EscPosTicketBytes -Text $text -TicketProfile $profile -HeaderLogoBits $logo -Structured
  [IO.File]::WriteAllBytes(($OutputPrefix+'-'+$profile+'.bin'),$bytes)
  Write-Output "$profile $($bytes.Length) bytes"
}
