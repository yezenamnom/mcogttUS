using System.Text.Json;
using System.Diagnostics;

internal static partial class Program
{
 static object SaveBrowserReport(JsonElement args)
 {
  if(!Config.Permissions.Get("filesWrite"))throw new InvalidOperationException("Permission disabled: filesWrite");
  var report=args.GetProperty("report");
  var json=report.GetRawText();
  if(json.Length>2000000)throw new ArgumentException("Report exceeds 2MB limit");
  var folder=System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"ChatGPTDesktopBridge","reports");
  Directory.CreateDirectory(folder);
  var path=System.IO.Path.Combine(folder,"browser-"+DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fffffff")+".json");
  File.WriteAllText(path,json);
  return new{path,saved=true};
 }
 static object WorkspaceReport()
 {
  // Metadata only: no file contents, clipboard, tokens or background screenshots.
  Permit("desktop_list_files"); Permit("desktop_windows"); Permit("desktop_monitors");
  if(!Config.Permissions.Get("filesWrite"))throw new InvalidOperationException("Permission disabled: filesWrite");
  var desktop=Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
  var entries=Directory.EnumerateFileSystemEntries(desktop).Take(2000).Select(p=>new{
   name=System.IO.Path.GetFileName(p),path=p,directory=Directory.Exists(p)
  }).ToArray();
  var windows=Process.GetProcesses().Where(p=>p.MainWindowHandle!=IntPtr.Zero).Select(p=>new{
   pid=p.Id,title=Safe(()=>p.MainWindowTitle,""),name=p.ProcessName
  }).ToArray();
  var report=new{schemaVersion=1,observedAt=DateTimeOffset.UtcNow,coordinateSpace="physical-screen",
   desktop,entries,windows,monitors=Screen.AllScreens.Select(s=>new{name=s.DeviceName,bounds=s.Bounds}).ToArray(),
   staleAfterChanges=true,includesElementCoordinates=false};
  var folder=System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"ChatGPTDesktopBridge","reports");
  Directory.CreateDirectory(folder);
  var path=System.IO.Path.Combine(folder,"workspace-"+DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fffffff")+".json");
  File.WriteAllText(path,JsonSerializer.Serialize(report,J));
  return new{path,report};
 }
 static object ReadLatestReport(JsonElement args)
 {
  if(!Config.Permissions.Get("filesRead"))throw new InvalidOperationException("Permission disabled: filesRead");
  var kind=args.ValueKind==JsonValueKind.Object&&args.TryGetProperty("reportKind",out var value)?value.GetString():"workspace";
  if(kind is not ("workspace" or "browser"))throw new ArgumentException("Invalid report kind");
  var folder=System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"ChatGPTDesktopBridge","reports");
  if(!Directory.Exists(folder))return new{found=false,kind};
  var file=Directory.EnumerateFiles(folder,kind+"-*.json").OrderByDescending(System.IO.Path.GetFileName).FirstOrDefault();
  if(file is null)return new{found=false,kind};
  var text=File.ReadAllText(file);
  if(text.Length>2000000)throw new InvalidOperationException("Report exceeds 2MB limit");
  return new{found=true,kind,path=file,modifiedAt=File.GetLastWriteTimeUtc(file),report=JsonSerializer.Deserialize<JsonElement>(text)};
 }
}
