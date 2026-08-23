$ErrorActionPreference = 'Stop'
$names = @(Get-Printer | Where-Object { $_.Name } | ForEach-Object { [string]$_.Name })
ConvertTo-Json -InputObject $names -Compress
