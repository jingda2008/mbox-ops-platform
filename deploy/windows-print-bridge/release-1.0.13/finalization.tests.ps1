param([string]$Package='artifacts/print-bridge-1.0.13/MBOX-PrintBridge-1.0.13-OneClick-r1')
$source=[IO.File]::ReadAllText((Join-Path $Package 'print-ticket.ps1')).Replace("`r`n","`n")
$start=$source.IndexOf('  public static void SendBytes(')
$end=$source.IndexOf("`n}`n'@",$start)
if($start -lt 0 -or $end -lt 0){throw 'packaged SendBytes not found'}
$method=$source.Substring($start,$end-$start)
$ErrorActionPreference='Stop'
$stub = @'
using System;
using System.Runtime.InteropServices;

public static class MboxRawPrinter {
 public static bool StartOk=true,WriteOk=true,PageOk=true,DocOk=true; public static int EndDocs=0,EndPages=0,Closed=0;
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private class DOCINFOW {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype;
  }

  private static bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd) { hPrinter=new IntPtr(1); return true; }

  private static bool ClosePrinter(IntPtr hPrinter) { Closed++; return true; }

  private static int StartDocPrinter(IntPtr hPrinter,int level,DOCINFOW di) { return 1; }

  private static bool EndDocPrinter(IntPtr hPrinter) { EndDocs++; return DocOk; }

  private static bool StartPagePrinter(IntPtr hPrinter) { return StartOk; }

  private static bool EndPagePrinter(IntPtr hPrinter) { EndPages++; return PageOk; }

  private static bool WritePrinter(IntPtr hPrinter,IntPtr pBytes,int count,out int written) { written=WriteOk?count:0; return WriteOk; }


'@
Add-Type -TypeDefinition ($stub + "`n" + $method + "`n}")
$cases=@(
 @{Name='success';Write=$true;Page=$true;Doc=$true;Start=$true;Error=''},
 @{Name='end-page';Write=$true;Page=$false;Doc=$true;Start=$true;Error='end_page_failed'},
 @{Name='end-doc';Write=$true;Page=$true;Doc=$false;Start=$true;Error='end_doc_failed'},
 @{Name='page-first-preserved';Write=$true;Page=$false;Doc=$false;Start=$true;Error='end_page_failed'},
 @{Name='write-first-preserved';Write=$false;Page=$false;Doc=$false;Start=$true;Error='write_printer_failed'},
 @{Name='start-page-preserved';Write=$true;Page=$true;Doc=$false;Start=$false;Error='start_page_failed'}
)
foreach($c in $cases){
 [MboxRawPrinter]::WriteOk=$c.Write;[MboxRawPrinter]::PageOk=$c.Page;[MboxRawPrinter]::DocOk=$c.Doc;[MboxRawPrinter]::StartOk=$c.Start
 [MboxRawPrinter]::Closed=0;[MboxRawPrinter]::EndDocs=0;[MboxRawPrinter]::EndPages=0
 $message=''
 try{[MboxRawPrinter]::SendBytes('SYNTHETIC-NOT-A-DEVICE','synthetic',[byte[]](1,2,3))}catch{$message=$_.Exception.ToString()}
 if($c.Error -eq ''){if($message){throw $message}}elseif($message -notmatch $c.Error){throw "Wrong failure: $($c.Name) $message"}
 if([MboxRawPrinter]::Closed -ne 1 -or [MboxRawPrinter]::EndDocs -ne 1){throw "Missing cleanup: $($c.Name)"}
 Write-Output "PASS $($c.Name)"
}
Write-Output '6/6 synthetic C# control-flow cases passed; no PInvoke, no device I/O'
