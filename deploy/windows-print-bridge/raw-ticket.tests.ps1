$ErrorActionPreference='Stop'
$p=Join-Path $PSScriptRoot 'print-ticket.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($p,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'syntax'}
$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'New-EscPosTicketBytes'},$true)
. ([scriptblock]::Create($fn.Extent.Text))
$gbk=[Text.Encoding]::GetEncoding(936)
function Decode-Ticket([byte[]]$Bytes,[int]$Width) {
  $records=@();$line=[Collections.Generic.List[byte]]::new();$size=0;$bold=0;$cuts=0;$i=0
  while($i -lt $Bytes.Length){
    $b=$Bytes[$i]
    if($b -ge 0x81 -and $b -le 0xFE){$line.Add($b);$i++;$line.Add($Bytes[$i]);$i++;continue}
    if($b -eq 0x1B){$cmd=$Bytes[$i+1];if($cmd -eq 0x40){$i+=2;continue};if($cmd -eq 0x45){$bold=$Bytes[$i+2]};$i+=3;continue}
    if($b -eq 0x1D){$cmd=$Bytes[$i+1];if($cmd -eq 0x21){$size=$Bytes[$i+2]}elseif($cmd -eq 0x56){$cuts++;if($i -ne $Bytes.Length-3 -or $Bytes[$i+2]-ne 1){throw 'cut not at end'}}else{throw 'unknown GS'};$i+=3;continue}
    if($b -eq 10){$limit=[int][Math]::Floor($Width/(1+($size -shr 4)));if($line.Count -gt $limit){throw 'line exceeds printable width'};$records += [pscustomobject]@{Text=$gbk.GetString($line.ToArray());Size=$size;Bold=$bold};$line.Clear()}else{$line.Add($b)};$i++
  }
  if($cuts -ne 1){throw 'cut count'}
  return ,$records
}
foreach($profile in @('escpos_80','escpos_58')){
  $width=if($profile-eq 'escpos_58'){32}else{42}
  $long='中文长备注矿泉水'*90
  $text="【打印测试】`n桌台：B05`n人数：2`n矿泉水 ×2`n单价：¥8.00`n小计：¥16.00`n备注：$long`n合计：¥16.00`nEND"
  [byte[]]$bytes=New-EscPosTicketBytes $text $profile
  $r=Decode-Ticket $bytes $width
  $all=($r|ForEach-Object{$_.Text})-join ''
  if(-not $all.Contains($long)){throw 'long text truncated'}
  if(-not $all.Contains('小计：￥16.00')){throw 'amount changed'}
  if(@($r|Where-Object{$_.Text-eq '桌台：B05' -and $_.Size-eq 34}).Count-ne 1){throw 'table size'}
  if(@($r|Where-Object{$_.Text-eq '矿泉水 ×2' -and $_.Size-eq 17}).Count-ne 1){throw 'product size'}
  if(@($r|Where-Object{$_.Text-eq 'END' -and $_.Size-eq 0 -and $_.Bold-eq 0}).Count-ne 1){throw 'format leaked'}
  Write-Output "PASS $profile GBK, width, long text, amount, size/reset, single terminal cut"
}
$injected="测试$([char]27)@$([char]29)V$([char]1)完"
$r=Decode-Ticket (New-EscPosTicketBytes $injected 'escpos_80') 42
if((($r|ForEach-Object{$_.Text})-join '')-ne '测试@V完'){throw 'control stripping'}
Write-Output 'PASS untrusted text cannot inject extra printer commands'
$original=Get-Content (Join-Path $PSScriptRoot '../../artifacts/venue-original-20260913/print-ticket.ps1') -Raw -Encoding UTF8
$current=Get-Content $p -Raw -Encoding UTF8
$nativePattern="(?s)using System;.*?^'@"
# Compare native transport byte-for-byte after newline normalization.
$a=$original.Substring($original.IndexOf('using System;'));$a=$a.Substring(0,$a.IndexOf("'@"))
$b=$current.Substring($current.IndexOf('using System;'));$b=$b.Substring(0,$b.IndexOf("'@"))
if($a.Replace("`r`n","`n") -ne $b.Replace("`r`n","`n")){throw 'native transport changed'}
Write-Output 'PASS original WinSpool RAW transport retained exactly'
