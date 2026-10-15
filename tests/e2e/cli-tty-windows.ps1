# Exercise actual Windows ConPTY setup prompts without credentials or provider calls.
# STARTF_USESTDHANDLES prevents SSH redirected handles from replacing the pseudoconsole:
# https://github.com/microsoft/terminal/discussions/15814
$ErrorActionPreference='Stop'
$code=@'
using System;
using System.Text;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
public static class OwnedConPty {
 [StructLayout(LayoutKind.Sequential)] struct COORD { public short X,Y; public COORD(short x,short y){X=x;Y=y;} }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI { public int cb; public string reserved,desktop,title; public int x,y,xs,ys,xc,yc,fill,flags; public short show,cb2; public IntPtr reserved2,stdin,stdout,stderr; }
 [StructLayout(LayoutKind.Sequential)] struct SX { public SI si; public IntPtr attrs; }
 [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public uint pid,tid; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr r,out IntPtr w,IntPtr sec,uint size);
 [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(COORD size,IntPtr input,IntPtr output,uint flags,out IntPtr pc);
 [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr pc);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int n,int flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attr,IntPtr value,IntPtr size,IntPtr p,IntPtr q);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SX si,out PI pi);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(IntPtr h,byte[] b,uint n,out uint read,IntPtr ov);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(IntPtr h,byte[] b,uint n,out uint written,IntPtr ov);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h,out uint exit);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h,uint exit);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 static void Check(bool ok){if(!ok)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
 public static string Run(string exe,string args,string cwd,string[] env,string expected,string answer){
  IntPtr ir=IntPtr.Zero,iw=IntPtr.Zero,or=IntPtr.Zero,ow=IntPtr.Zero,pc=IntPtr.Zero,attrs=IntPtr.Zero,ep=IntPtr.Zero;PI pi=new PI();
  var bytes=new MemoryStream();bool replied=false;uint exit=uint.MaxValue;Task reader=null;
  try {
   Check(CreatePipe(out ir,out iw,IntPtr.Zero,0));Check(CreatePipe(out or,out ow,IntPtr.Zero,0));
   int hr=CreatePseudoConsole(new COORD(160,60),ir,ow,0,out pc);if(hr!=0)Marshal.ThrowExceptionForHR(hr);
   CloseHandle(ir);ir=IntPtr.Zero;CloseHandle(ow);ow=IntPtr.Zero;
   IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);attrs=Marshal.AllocHGlobal(size);Check(InitializeProcThreadAttributeList(attrs,1,0,ref size));
   Check(UpdateProcThreadAttribute(attrs,0,(IntPtr)0x00020016,pc,(IntPtr)IntPtr.Size,IntPtr.Zero,IntPtr.Zero));
   var sx=new SX();sx.si.cb=Marshal.SizeOf(typeof(SX));sx.si.flags=0x100;sx.attrs=attrs;
   ep=Marshal.StringToHGlobalUni(string.Join("\0",env)+"\0\0");
   Check(CreateProcessW(exe,new StringBuilder("\""+exe+"\" "+args),IntPtr.Zero,IntPtr.Zero,false,0x00080000|0x00000400,ep,cwd,ref sx,out pi));
   var output=or;reader=Task.Run(()=>{byte[] b=new byte[65536];uint n;while(ReadFile(output,b,(uint)b.Length,out n,IntPtr.Zero)&&n>0){lock(bytes)bytes.Write(b,0,(int)n);}});
   var until=DateTime.UtcNow.AddSeconds(25);
   while(DateTime.UtcNow<until){
    string current;lock(bytes)current=Encoding.UTF8.GetString(bytes.ToArray());
    if(!replied&&current.Contains(expected)){byte[] response=Encoding.UTF8.GetBytes(answer);uint n;Check(WriteFile(iw,response,(uint)response.Length,out n,IntPtr.Zero));replied=true;}
    if(WaitForSingleObject(pi.process,20)==0){GetExitCodeProcess(pi.process,out exit);break;}
   }
   if(exit==uint.MaxValue){TerminateProcess(pi.process,124);WaitForSingleObject(pi.process,3000);throw new Exception("Owned child timed out; replied="+replied);}
   ClosePseudoConsole(pc);pc=IntPtr.Zero;if(!reader.Wait(3000))throw new Exception("Terminal reader did not finish");
   string result;lock(bytes)result=Encoding.UTF8.GetString(bytes.ToArray());
   if(!replied)throw new Exception("Expected terminal prompt missing: "+result);
   if(exit!=0)throw new Exception("Owned child exit "+exit+": "+result);
   return result;
  } finally {
   if(pi.process!=IntPtr.Zero){if(WaitForSingleObject(pi.process,0)!=0){TerminateProcess(pi.process,125);WaitForSingleObject(pi.process,3000);}CloseHandle(pi.process);}if(pi.thread!=IntPtr.Zero)CloseHandle(pi.thread);
   if(pc!=IntPtr.Zero)ClosePseudoConsole(pc);foreach(IntPtr h in new[]{ir,iw,or,ow})if(h!=IntPtr.Zero)CloseHandle(h);
   if(attrs!=IntPtr.Zero){DeleteProcThreadAttributeList(attrs);Marshal.FreeHGlobal(attrs);}if(ep!=IntPtr.Zero)Marshal.FreeHGlobal(ep);
  }
 }
}
'@
Add-Type -TypeDefinition $code
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$binary=if($env:RDSH_E2E_BIN){[IO.Path]::GetFullPath($env:RDSH_E2E_BIN)}else{Join-Path $repo 'target/release/rdsh.exe'}
$output=if($env:RDSH_E2E_OUTPUT){[IO.Path]::GetFullPath($env:RDSH_E2E_OUTPUT)}else{Join-Path $repo 'target/cli-tty-windows'}
New-Item -ItemType Directory -Force $output|Out-Null
$cases=@()
foreach($row in @(
 @('en','paste DEEPSEEK_API_KEY here','persist DEEPSEEK_API_KEY from environment'),
 @('zh-CN','在此粘贴 DEEPSEEK_API_KEY','将环境变量 DEEPSEEK_API_KEY 保存到'),
 @('ja','DEEPSEEK_API_KEY を貼り付けてください','環境変数 DEEPSEEK_API_KEY を')
)){
 foreach($mode in @('paste','save')){
  $homeDir=Join-Path ([IO.Path]::GetTempPath()) ('rdsh-conpty-'+[guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory $homeDir|Out-Null
  $childEnv=@(('HOME='+$homeDir),('USERPROFILE='+$homeDir),('DSH_HOME='+$homeDir),('XDG_CONFIG_HOME='+$homeDir+'/config'),('XDG_DATA_HOME='+$homeDir+'/data'),('XDG_CACHE_HOME='+$homeDir+'/cache'),('LANG=C'))
  foreach($key in @('PATH','SystemRoot','WINDIR','TEMP','TMP')){ $value=[Environment]::GetEnvironmentVariable($key);if($value){$childEnv+=($key+'='+$value)}}
  $expected=if($mode -eq 'paste'){$row[1]}else{$row[2]}
  $answer=if($mode -eq 'paste'){"`r"}else{"n`r"}
  if($mode -eq 'save'){$childEnv+='DEEPSEEK_API_KEY=fixture-key'}
  try {
   $text=[OwnedConPty]::Run($binary,('--language '+$row[0]+' setup'),$homeDir,($childEnv|Sort-Object),$expected,$answer)
   if($text.Contains('fixture-key')){throw 'fixture key leaked into terminal output'}
   if(Test-Path ($homeDir+'/.credentials.yaml')){throw 'declined credential was saved'}
   $cases+=@{language=$row[0];mode=$mode;prompt=$expected;exit=0;credentials_written=$false}
  }finally{
   if((Split-Path $homeDir -Leaf) -notmatch '^rdsh-conpty-[0-9a-f]{32}$'){throw 'unexpected cleanup path'}
   Remove-Item -LiteralPath $homeDir -Recurse
  }
 }
}
$report=@{result='PASS';scope='actual Windows ConPTY, no provider/model calls, no credentials entered or stored';cases=$cases}
[IO.File]::WriteAllText((Join-Path $output 'cli-tty-results.json'),($report|ConvertTo-Json -Depth 5)+"`n",(New-Object Text.UTF8Encoding($false)))
@{result='PASS';cases=$cases.Count;output=$output}|ConvertTo-Json -Compress
