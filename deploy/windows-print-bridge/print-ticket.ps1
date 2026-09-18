param(
  [Parameter(Mandatory=$true)][string]$QueueName,
  [Parameter(Mandatory=$true)][string]$ContentPath,
  [Parameter(Mandatory=$true)][string]$DocumentName,
  [Parameter(Mandatory=$true)][ValidateSet('escpos_58','escpos_80','windows_text')][string]$Profile,
  [Parameter(Mandatory=$true)][ValidateRange(1,5)][int]$Copies
)

$ErrorActionPreference = 'Stop'

# Venue-verified RAW transport restored from the user backup (2026-09-09).
# Do not substitute Windows font drawing for this transport without device acceptance.
$printer = Get-Printer -Name $QueueName -ErrorAction Stop
if ($printer.PrinterStatus -match 'Error|Offline|PaperProblem|NoToner') {
  throw "printer_unavailable:$($printer.PrinterStatus)"
}

$content = [System.IO.File]::ReadAllText($ContentPath, [System.Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($content)) {
  throw 'empty_ticket_content'
}

if (-not ('MboxRawPrinter' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class MboxRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private class DOCINFOW {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype;
  }

  [DllImport("winspool.Drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);

  [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true)]
  private static extern bool ClosePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern int StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFOW di);

  [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
  private static extern bool EndDocPrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
  private static extern bool StartPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
  private static extern bool EndPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true)]
  private static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

  public static void SendBytes(string printerName, string documentName, byte[] payload) {
    if (string.IsNullOrWhiteSpace(printerName)) throw new ArgumentException("printerName");
    if (payload == null || payload.Length == 0) throw new ArgumentException("payload");

    IntPtr hPrinter;
    if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) {
      throw new InvalidOperationException("open_printer_failed:" + Marshal.GetLastWin32Error());
    }

    try {
      DOCINFOW di = new DOCINFOW();
      di.pDocName = string.IsNullOrWhiteSpace(documentName) ? "M-BOX Ticket" : documentName;
      di.pOutputFile = null;
      di.pDatatype = "RAW";

      if (StartDocPrinter(hPrinter, 1, di) <= 0) {
        throw new InvalidOperationException("start_doc_failed:" + Marshal.GetLastWin32Error());
      }
      try {
        if (!StartPagePrinter(hPrinter)) {
          throw new InvalidOperationException("start_page_failed:" + Marshal.GetLastWin32Error());
        }
        try {
          IntPtr unmanaged = Marshal.AllocHGlobal(payload.Length);
          try {
            Marshal.Copy(payload, 0, unmanaged, payload.Length);
            int written;
            if (!WritePrinter(hPrinter, unmanaged, payload.Length, out written) || written != payload.Length) {
              throw new InvalidOperationException("write_printer_failed:" + Marshal.GetLastWin32Error());
            }
          } finally {
            Marshal.FreeHGlobal(unmanaged);
          }
        } finally {
          EndPagePrinter(hPrinter);
        }
      } finally {
        EndDocPrinter(hPrinter);
      }
    } finally {
      ClosePrinter(hPrinter);
    }
  }
}
'@
}

function New-EscPosTicketBytes {
  param([string]$Text, [string]$TicketProfile)
  if ([string]::IsNullOrWhiteSpace($Text)) { throw 'empty_ticket_content' }
  $gbk = [System.Text.Encoding]::GetEncoding(936)
  $chunks = New-Object System.Collections.Generic.List[byte]
  # Keep the venue-proven initialization, code table and left alignment.
  $chunks.AddRange([byte[]](0x1B, 0x40, 0x1B, 0x74, 0x00, 0x1B, 0x61, 0x00))
  $normalized = ($Text -replace "`r`n", "`n" -replace "`r", "`n").TrimEnd()
  # Ticket data cannot inject ESC/POS commands. Preserve printable data and newlines.
  $normalized = ($normalized -replace "`t", '    ') -replace '[\x00-\x09\x0B-\x1F\x7F]', ''
  $normalized = $normalized.Replace([string][char]0x00A5, [string][char]0xFFE5)
  $lineWidth = if ($TicketProfile -eq 'escpos_58') { 32 } else { 42 }
  foreach ($line in ($normalized -split "`n")) {
    $label = $line.TrimStart()
    [byte]$size = 0
    [byte]$bold = 0
    if ($label -eq '陆家嘴中心 L+MALL') { $size=0; $bold=1 }
    elseif ($label -match '^(桌台|桌号)：') { $size=0x22; $bold=1 }
    elseif ($label -match '^(合计|净收|应收|应付)：') { $size=0x11; $bold=1 }
    elseif ($label -match '×\d+\s*$') { $size=0x11; $bold=1 }
    elseif ($label -match '^备注：') { $bold=1 }
    $chunks.AddRange([byte[]](0x1D, 0x21, $size, 0x1B, 0x45, $bold))
    $width = [int][Math]::Floor($lineWidth / (1 + ($size -shr 4)))
    $used = 0
    $elements = [Globalization.StringInfo]::GetTextElementEnumerator($line)
    while ($elements.MoveNext()) {
      $bytes = $gbk.GetBytes($elements.GetTextElement())
      if ($used -gt 0 -and $used + $bytes.Length -gt $width) { $chunks.Add(0x0A); $used=0 }
      $chunks.AddRange($bytes); $used += $bytes.Length
    }
    $chunks.Add(0x0A)
    if ($size -gt 0) { $chunks.Add(0x0A) }
    # Explicit reset prevents emphasis leaking into subsequent fields/jobs.
    $chunks.AddRange([byte[]](0x1D, 0x21, 0x00, 0x1B, 0x45, 0x00))
  }
  # Identical feed-and-half-cut suffix to the working venue script.
  $chunks.AddRange([byte[]](0x0A, 0x0A, 0x0A, 0x1D, 0x56, 0x01))
  return ,$chunks.ToArray()
}

$payload = New-EscPosTicketBytes -Text $content -TicketProfile $Profile
for ($i = 1; $i -le $Copies; $i++) {
  $docName = if ($Copies -gt 1) { "$DocumentName#$i" } else { $DocumentName }
  [MboxRawPrinter]::SendBytes($QueueName, $docName, $payload)
}
