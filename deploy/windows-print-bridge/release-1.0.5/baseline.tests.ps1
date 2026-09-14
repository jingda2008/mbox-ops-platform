$ErrorActionPreference='Stop'
$t=$null;$e=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'upgrade.ps1'),[ref]$t,[ref]$e)
$assignment=$ast.Find({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$operations'},$true)
$operations= & ([scriptblock]::Create($assignment.Right.Extent.Text))
$files=@('bridge.mjs','print-ticket.ps1','list-printers.ps1');$InstallDirectory='/venue';$wasRunning=$true
$originalHashes=@{};$validatedHashes=@{};$script:hashes=@{};$mf=@{}
foreach($f in $files){$originalHashes[$f]='original-'+$f;$script:hashes[$f]=$originalHashes[$f];$mf[$f]='candidate-'+$f}
$manifest=[pscustomobject]@{files=[pscustomobject]$mf}
function Get-Content { param($LiteralPath,[switch]$Raw,$Encoding) "const VERSION = '1.0.4'" }
function Get-FileHash {param($LiteralPath,$Algorithm) [pscustomobject]@{Hash=$script:hashes[(Split-Path -Leaf $LiteralPath)]} }
function Assert-MboxIdle {}
if((& $operations.Validate)-ne $false){throw 'original not upgradeable'}
& $operations.ProbeStoppedIdle
$script:hashes['print-ticket.ps1']='unknown'
$rejected=$false;try{& $operations.Validate}catch{$rejected=$true};if(-not $rejected){throw 'unknown adaptation overwritten'}
$rejected=$false;try{& $operations.ProbeStoppedIdle}catch{$rejected=$true};if(-not $rejected){throw 'change during stop accepted'}
foreach($f in $files){$script:hashes[$f]=$mf[$f]}
if((& $operations.Validate)-ne $true){throw 'repeat install not recognized'}
Write-Output 'PASS original baseline, unknown adaptation rejection, post-stop change rejection, exact repeat install'
