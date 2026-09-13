function Get-MboxProgramSummary {
  param([string]$Path)
  try {
    $bytes=[IO.File]::ReadAllBytes($Path)
    $source=[IO.File]::ReadAllText($Path)
    $version=$null
    if($source -match "const VERSION = '([0-9]+\.[0-9]+\.[0-9]+)'"){$version=$Matches[1]}
    return [pscustomobject]@{File=(Split-Path $Path -Leaf); Read='ok'; SHA256=(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash; Bytes=$bytes.Length; Version=$version; Utf8Bom=($bytes.Length -ge 3 -and $bytes[0]-eq 239 -and $bytes[1]-eq 187 -and $bytes[2]-eq 191); GdiText=($source-match 'DrawString'); GdiDocument=($source-match 'PrintDocument'); RawSpooler=($source-match 'WritePrinter|StartDocPrinter'); Raster=($source-match 'DrawImage|Bitmap|GS.?v.?0'); CutMarkers=($source-match '(?i)cut|切纸|裁纸|0x1d\s*,\s*0x56'); CodePage936=($source-match '936|gbk|GB2312|GB18030'); ExplicitUtf8=($source-match 'UTF8|utf-8|utf8'); ConsoleEncoding=($source-match 'Console\]::OutputEncoding'); Note='Markers are evidence for comparison, not proof of actual execution.'}
  } catch {return [pscustomobject]@{File=(Split-Path $Path -Leaf); Read='unavailable'; ErrorType=$_.Exception.GetType().Name}}
}
