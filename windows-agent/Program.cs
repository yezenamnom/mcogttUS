using System.Diagnostics;
using System.Net;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO.Compression;
using System.Windows.Forms;

internal static partial class Program
{
 [DllImport("user32.dll")] static extern bool SetCursorPos(int X,int Y);
 [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
 [DllImport("user32.dll")] static extern void mouse_event(uint f,uint dx,uint dy,uint data,UIntPtr e);
 [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n,INPUT[] i,int s);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h,int n);
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr h,int x,int y,int w,int hgt,bool repaint);
 const uint LD=2,LU=4,RD=8,RU=16,INPUT_KEYBOARD=1,KU=2,UNICODE=4;
 [StructLayout(LayoutKind.Sequential)] struct POINT{public int X,Y;}
 [StructLayout(LayoutKind.Sequential)] struct INPUT{public uint type;public InputUnion U;}
 [StructLayout(LayoutKind.Explicit)] struct InputUnion{[FieldOffset(0)]public KEYBDINPUT ki;[FieldOffset(0)]public MOUSEINPUT mi;}
 [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT{public ushort wVk,wScan;public uint dwFlags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT{public int dx,dy;public uint mouseData,dwFlags,time;public UIntPtr extra;}
 static readonly JsonSerializerOptions J=new(JsonSerializerDefaults.Web){WriteIndented=true}; static AppConfig Config=new();

 static MainForm? MainWindow;
 static DesktopActivityWaves? ActivityWaves;
 [STAThread] static void Main(){ApplicationConfiguration.Initialize();Config=Load();MainWindow=new MainForm();ActivityWaves=new DesktopActivityWaves();Application.Run(MainWindow);ActivityWaves.Dispose();}
 static void PulseDesktopActivity(string command){
  if(command is "desktop_screenshot" or "desktop_monitors" or "desktop_screen_size" or "desktop_info" or "desktop_cursor_position" or "desktop_windows" or "desktop_processes" or "desktop_system_info")return;
  var form=MainWindow;
  if(form is {IsHandleCreated:true,IsDisposed:false})form.BeginInvoke(()=>ActivityWaves?.Pulse());
 }
 sealed class MainForm:Form{
  readonly Label state=new(){AutoSize=true,Text="● Starting",Font=new Font("Segoe UI",10,FontStyle.Bold)},latency=new(){AutoSize=true,Text="Railway latency: —"},last=new(){AutoSize=true,Text="Last connection: —"};
  readonly TextBox url=new(){Width=530},token=new(){Width=530,UseSystemPasswordChar=true}; readonly NumericUpDown port=new(){Minimum=1024,Maximum=65535,Width=100}; readonly CheckBox local=new(){Text="Enable local helper server (127.0.0.1)"}; readonly CheckedListBox perms=new(){CheckOnClick=true,Width=330,Height=190}; readonly ListBox log=new(){Dock=DockStyle.Fill}; CancellationTokenSource? cts; HttpListener? listener;
  string[] pn={"screen","mouse","keyboard","clipboard","windows","filesRead","filesWrite","processes","system","commands"};
  public MainForm(){Text="ChatGPT Desktop Bridge v0.8.0";Width=720;Height=520;StartPosition=FormStartPosition.CenterScreen;var tabs=new TabControl{Dock=DockStyle.Fill};Controls.Add(tabs);var conn=new TabPage("Connection");var sec=new TabPage("Permissions");var act=new TabPage("Activity");var sys=new TabPage("System");tabs.TabPages.AddRange([conn,sec,act,sys]);int y=20;A(conn,new Label{Text="Bridge URL",Left=20,Top=y+4,AutoSize=true});url.SetBounds(130,y,530,25);url.Text=Config.BridgeUrl;A(conn,url);y+=42;A(conn,new Label{Text="Bridge token",Left=20,Top=y+4,AutoSize=true});token.SetBounds(130,y,530,25);token.Text=Config.BridgeToken;A(conn,token);y+=42;local.SetBounds(20,y,360,25);local.Checked=Config.LocalServerEnabled;A(conn,local,new Label{Text="Port",Left=420,Top=y+3,AutoSize=true});port.SetBounds(460,y-2,100,25);port.Value=Config.LocalPort;A(conn,port);y+=42;var save=new Button{Text="Save & Reconnect",Left=20,Top=y,Width=150};var test=new Button{Text="Test latency",Left=185,Top=y,Width=120};var mini=new Button{Text="Minimize",Left=320,Top=y,Width=100};A(conn,save,test,mini);y+=48;state.SetBounds(20,y,600,25);latency.SetBounds(20,y+30,600,25);last.SetBounds(20,y+58,600,25);A(conn,state,latency,last,new Label{Left=20,Top=y+92,Width=640,Height=65,Text="Local mode is for same-PC testing. ChatGPT cloud cannot call 127.0.0.1 directly; Railway remains the remote MCP transport."});perms.SetBounds(20,20,330,190);A(sec,perms);foreach(var p in pn){int i=perms.Items.Add(p);perms.SetItemChecked(i,Config.Permissions.Get(p));}var ps=new Button{Text="Save permissions",Left=380,Top=180,Width=140};A(sec,new Label{Left=380,Top=20,Width=280,Height=150,Text="Permissions are enforced inside the agent. File write is OFF by default."},ps);act.Controls.Add(log);var info=new TextBox{Dock=DockStyle.Fill,Multiline=true,ReadOnly=true,ScrollBars=ScrollBars.Vertical};sys.Controls.Add(info);save.Click+=(_,__)=>{Config.BridgeUrl=url.Text.Trim();Config.BridgeToken=token.Text.Trim();Config.LocalServerEnabled=local.Checked;Config.LocalPort=(int)port.Value;SP();Save();Restart();};ps.Click+=(_,__)=>{SP();Save();};mini.Click+=(_,__)=>WindowState=FormWindowState.Minimized;test.Click+=async(_,__)=>await Test();Shown+=(_,__)=>{Restart();info.Text=JsonSerializer.Serialize(new{version="0.8.0",machine=Environment.MachineName,os=Environment.OSVersion.VersionString,processors=Environment.ProcessorCount,screens=Screen.AllScreens.Length},J);};FormClosing+=(_,__)=>{cts?.Cancel();try{listener?.Stop();}catch{}};}
  static void A(Control p,params Control[] c)=>p.Controls.AddRange(c);void SP(){for(int i=0;i<pn.Length;i++)Config.Permissions.Set(pn[i],perms.GetItemChecked(i));}void L(string s){if(InvokeRequired){BeginInvoke(()=>L(s));return;}log.Items.Insert(0,$"{DateTime.Now:HH:mm:ss}  {s}");}async Task Test(){try{var sw=Stopwatch.StartNew();using var h=new HttpClient{Timeout=TimeSpan.FromSeconds(5)};var r=await h.GetAsync(Config.BridgeUrl.TrimEnd('/')+"/health");sw.Stop();latency.Text=$"Railway latency: {sw.ElapsedMilliseconds} ms ({(int)r.StatusCode})";}catch(Exception e){latency.Text=e.Message;}}void Restart(){cts?.Cancel();try{listener?.Stop();}catch{}cts=new();_ = Task.Run(()=>Worker(cts.Token));if(Config.LocalServerEnabled)_ = Task.Run(()=>Local(cts.Token));}async Task Worker(CancellationToken ct){while(!ct.IsCancellationRequested){try{await Remote(s=>{if(InvokeRequired)BeginInvoke(()=>State(s));else State(s);},L,ct);}catch(Exception e){State("Disconnected: "+e.Message);}try{await Task.Delay(900,ct);}catch{}}}void State(string s){if(InvokeRequired){BeginInvoke(()=>State(s));return;}state.Text="● "+s;if(s.StartsWith("Connected"))last.Text="Last connection: "+DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");}async Task Local(CancellationToken ct){try{listener=new();listener.Prefixes.Add($"http://127.0.0.1:{Config.LocalPort}/");listener.Start();while(!ct.IsCancellationRequested){var x=await listener.GetContextAsync();var b=Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new{ok=true,version="0.8.0",local=true}));x.Response.ContentType="application/json";await x.Response.OutputStream.WriteAsync(b);x.Response.Close();}}catch{}}
 }
 static async Task Remote(Action<string> report,Action<string> log,CancellationToken ct){using var ws=new ClientWebSocket();var b=Config.BridgeUrl.TrimEnd('/').Replace("https://","wss://").Replace("http://","ws://");await ws.ConnectAsync(new Uri($"{b}/desktop?token={Uri.EscapeDataString(Config.BridgeToken)}"),ct);report("Connected to bridge /desktop");var buf=new byte[1024*1024];while(ws.State==WebSocketState.Open&&!ct.IsCancellationRequested){using var ms=new MemoryStream();WebSocketReceiveResult r;do{r=await ws.ReceiveAsync(buf,ct);if(r.MessageType==WebSocketMessageType.Close)return;ms.Write(buf,0,r.Count);}while(!r.EndOfMessage);using var d=JsonDocument.Parse(ms.ToArray());var root=d.RootElement;if(!root.TryGetProperty("type",out var t)||t.GetString()!="command")continue;var id=root.GetProperty("id").GetString()!;var cmd=root.GetProperty("command").GetString()!;var a=root.TryGetProperty("args",out var q)?q:default;object? result=null;string? error=null;try{Permit(cmd);var sw=Stopwatch.StartNew();result=await Exec(cmd,a);sw.Stop();log($"{cmd} {sw.ElapsedMilliseconds}ms");}catch(Exception e){error=e.Message;}var payload=JsonSerializer.Serialize(new{type="result",id,ok=error is null,result,error},J);await ws.SendAsync(Encoding.UTF8.GetBytes(payload),WebSocketMessageType.Text,true,ct);}}
 static void Permit(string c){
  string p=c switch{
   var x when x.Contains("screenshot")||x.Contains("screen")||x.Contains("monitor")=>"screen",
   var x when x.Contains("mouse")||x.Contains("cursor")||x.Contains("click")||x.Contains("scroll")=>"mouse",
   var x when x.Contains("type")||x.Contains("key")=>"keyboard",
   var x when x.Contains("clipboard")=>"clipboard",
   var x when x.Contains("window")=>"windows",
   var x when x.Contains("file")||x.Contains("folder")||x.Contains("path")||x.Contains("extract")||x.Contains("directory")=>x.Contains("copy")||x.Contains("move")||x.Contains("create")||x.Contains("extract")?"filesWrite":"filesRead",
   var x when x.Contains("process")=>"processes",_=>"system"};
  if(!Config.Permissions.Get(p))throw new Exception("Permission disabled: "+p);
  PulseDesktopActivity(c);
 }
 static async Task<object> Exec(string c,JsonElement a){if(c=="desktop_mouse_action")return await MouseAction(a);switch(c){case"desktop_info":return new{version="0.8.0",machine=Environment.MachineName,user=Environment.UserName,os=Environment.OSVersion.VersionString,capabilities=new[]{"screens","mouse","keyboard","clipboard","windows","files","processes","system","local-helper"}};case"desktop_monitors":return Screen.AllScreens.Select((s,i)=>new{index=i,name=s.DeviceName,primary=s.Primary,x=s.Bounds.X,y=s.Bounds.Y,width=s.Bounds.Width,height=s.Bounds.Height}).ToArray();case"desktop_screen_size":var v=SystemInformation.VirtualScreen;return new{x=v.X,y=v.Y,width=v.Width,height=v.Height};case"desktop_screenshot":return Capture(Has(a,"screen")?I(a,"screen"):-1);case"desktop_cursor_position":return Pos();case"desktop_move_mouse":await Smooth(I(a,"x"),I(a,"y"),I(a,"durationMs",120));return Pos();case"desktop_click":if(Has(a,"x")&&Has(a,"y"))await Smooth(I(a,"x"),I(a,"y"),I(a,"durationMs",90));Click(S(a,"button","left"),I(a,"count",1));return Pos();case"desktop_scroll":MouseInput(B(a,"horizontal")?0x1000u:0x0800u,data:unchecked((uint)I(a,"delta",-120)));return Pos();case"desktop_mouse_path":return await Path(a);case"desktop_type_text":await Type(S(a,"text"),I(a,"intervalMs",1));return new{typed=true};case"desktop_key_combo":Combo(a.GetProperty("keys").EnumerateArray().Select(e=>e.GetString()??"").ToArray());return new{pressed=true};case"desktop_clipboard_get":return new{text=Clipboard.ContainsText()?Clipboard.GetText():""};case"desktop_clipboard_set":Clipboard.SetText(S(a,"text"));return new{set=true};case"desktop_windows":return Process.GetProcesses().Where(p=>p.MainWindowHandle!=IntPtr.Zero).Select(p=>new{pid=p.Id,name=p.ProcessName,title=Safe(()=>p.MainWindowTitle,"")}).ToArray();case"desktop_window_activate":return WA(I(a,"pid"),"a",a);case"desktop_window_minimize":return WA(I(a,"pid"),"n",a);case"desktop_window_maximize":return WA(I(a,"pid"),"x",a);case"desktop_window_restore":return WA(I(a,"pid"),"r",a);case"desktop_window_move":return WA(I(a,"pid"),"m",a);case"desktop_processes":return Process.GetProcesses().Take(500).Select(p=>new{pid=p.Id,name=p.ProcessName,memory=Safe(()=>p.WorkingSet64,0L)}).ToArray();case"desktop_system_info":return new{machine=Environment.MachineName,os=Environment.OSVersion.VersionString,logicalProcessors=Environment.ProcessorCount,drives=DriveInfo.GetDrives().Where(d=>d.IsReady).Select(d=>new{name=d.Name,total=d.TotalSize,free=d.AvailableFreeSpace}).ToArray()};case"desktop_file_exists":var fp=S(a,"path");return new{path=fp,exists=File.Exists(fp),directory=Directory.Exists(fp)};case"desktop_list_files":var dir=S(a,"path",Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));return new{path=dir,items=Directory.EnumerateFileSystemEntries(dir).Take(500).Select(x=>new{name=System.IO.Path.GetFileName(x),path=x,directory=Directory.Exists(x),size=File.Exists(x)?new FileInfo(x).Length:0}).ToArray()};case"desktop_create_folder":Directory.CreateDirectory(S(a,"path"));return new{created=true};case"desktop_copy_file":File.Copy(S(a,"source"),S(a,"destination"),B(a,"overwrite"));return new{copied=true};case"desktop_move_file":File.Move(S(a,"source"),S(a,"destination"),B(a,"overwrite"));return new{moved=true};case"desktop_extract_zip":var zs=S(a,"source");var zd=S(a,"destination");Directory.CreateDirectory(zd);ZipFile.ExtractToDirectory(zs,zd,B(a,"overwrite",true));return new{extracted=true,source=zs,destination=zd};case"desktop_copy_directory":CopyDir(S(a,"source"),S(a,"destination"),B(a,"overwrite",true));return new{copied=true};case"desktop_open_path":Process.Start(new ProcessStartInfo(S(a,"path")){UseShellExecute=true});return new{opened=true};default:throw new Exception("Unknown desktop command: "+c);}}
 static void CopyDir(string source,string destination,bool overwrite){Directory.CreateDirectory(destination);foreach(var f in Directory.GetFiles(source))File.Copy(f,System.IO.Path.Combine(destination,System.IO.Path.GetFileName(f)),overwrite);foreach(var d in Directory.GetDirectories(source))CopyDir(d,System.IO.Path.Combine(destination,System.IO.Path.GetFileName(d)),overwrite);}
 static object Capture(int n){Rectangle r=n>=0&&n<Screen.AllScreens.Length?Screen.AllScreens[n].Bounds:SystemInformation.VirtualScreen;using var bmp=new Bitmap(r.Width,r.Height);using(var g=Graphics.FromImage(bmp))g.CopyFromScreen(r.Left,r.Top,0,0,bmp.Size);using var ms=new MemoryStream();bmp.Save(ms,ImageFormat.Png);return new{mimeType="image/png",data=Convert.ToBase64String(ms.ToArray()),screen=n,x=r.X,y=r.Y,width=r.Width,height=r.Height};}static object WA(int pid,string a,JsonElement j){var h=Process.GetProcessById(pid).MainWindowHandle;if(h==IntPtr.Zero)throw new Exception("No main window");if(a=="a")SetForegroundWindow(h);else if(a=="n")ShowWindow(h,6);else if(a=="x")ShowWindow(h,3);else if(a=="r")ShowWindow(h,9);else MoveWindow(h,I(j,"x"),I(j,"y"),I(j,"width",900),I(j,"height",700),true);return new{ok=true,pid};}
 static async Task<object> Path(JsonElement a){
  var p=a.GetProperty("points").EnumerateArray().Select(x=>(I(x,"x"),I(x,"y"))).ToArray();
  if(p.Length<2||p.Length>1000)throw new ArgumentException("Path requires 2–1000 points");
  foreach(var point in p)ValidatePoint(point.Item1,point.Item2);
  bool press=B(a,"press");string btn=S(a,"button","left");ButtonFlag(btn,false);
  int d=I(a,"durationMs",400);if(d<20||d>15000)throw new ArgumentException("Invalid path duration");
  await Smooth(p[0].Item1,p[0].Item2,60);
  try{if(press)Down(btn);for(int i=1;i<p.Length;i++)await Smooth(p[i].Item1,p[i].Item2,Math.Max(1,d/(p.Length-1)));}
  finally{if(press)Up(btn);}
  return new{moved=true,points=p.Length,cursor=Pos(),input="SendInput",uiVerified=false};
 }
 static void ValidatePoint(int x,int y){if(!Screen.AllScreens.Any(s=>s.Bounds.Contains(x,y)))throw new ArgumentOutOfRangeException("coordinates","Target is outside the connected monitors");}
 static void MouseInput(uint flags,int x=0,int y=0,uint data=0){
  var inputs=new[]{new INPUT{type=0,U=new InputUnion{mi=new MOUSEINPUT{dx=x,dy=y,mouseData=data,dwFlags=flags}}}};
  if(SendInput(1,inputs,Marshal.SizeOf<INPUT>())!=1)throw new InvalidOperationException("Windows rejected mouse input; error "+Marshal.GetLastWin32Error());
 }
 static void MoveNative(int x,int y){
  var v=SystemInformation.VirtualScreen;
  MouseInput(0x0001|0x8000|0x4000,(int)Math.Round((x-v.Left)*65535.0/Math.Max(1,v.Width-1)),(int)Math.Round((y-v.Top)*65535.0/Math.Max(1,v.Height-1)));
 }
 [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint period);
 [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint period);
 static int LastMoveUpdates;
 static double LastMoveElapsedMs;
 static async Task Smooth(int x,int y,int ms){
  ValidatePoint(x,y);if(ms<0||ms>15000)throw new ArgumentOutOfRangeException(nameof(ms));
  if(!GetCursorPos(out var s))throw new InvalidOperationException("Cannot read cursor position");
  var sw=Stopwatch.StartNew();int updates=0;
  double interval=1000.0/Math.Clamp(Config.MouseUpdateHz,30,240);
  bool timerRaised=timeBeginPeriod(1)==0;
  try{
   double next=0;
   while(sw.Elapsed.TotalMilliseconds<ms){
    double now=sw.Elapsed.TotalMilliseconds;
    if(now<next){await Task.Delay(1).ConfigureAwait(false);continue;}
    double t=Math.Clamp(now/ms,0,1),e=t*t*(3-2*t);
    MoveNative((int)Math.Round(s.X+(x-s.X)*e),(int)Math.Round(s.Y+(y-s.Y)*e));updates++;
    next=(Math.Floor(sw.Elapsed.TotalMilliseconds/interval)+1)*interval;
   }
   MoveNative(x,y);updates++;
  }finally{if(timerRaised)timeEndPeriod(1);LastMoveUpdates=updates;LastMoveElapsedMs=sw.Elapsed.TotalMilliseconds;}
  await Task.Delay(8);
  if(!GetCursorPos(out var actual)||Math.Abs(actual.X-x)>1||Math.Abs(actual.Y-y)>1)throw new InvalidOperationException("Cursor did not reach target");
 }
 static uint ButtonFlag(string b,bool up)=>b switch{"left"=>up?LU:LD,"right"=>up?RU:RD,"middle"=>up?0x40u:0x20u,_=>throw new ArgumentException("Invalid mouse button")};
 static void Click(string b,int n){if(n<1||n>3)throw new ArgumentOutOfRangeException(nameof(n));for(int i=0;i<n;i++){try{Down(b);Thread.Sleep(20);}finally{Up(b);}if(i+1<n)Thread.Sleep(50);}}
 static void Down(string b)=>MouseInput(ButtonFlag(b,false));
 static void Up(string b)=>MouseInput(ButtonFlag(b,true));
 static async Task Type(string t,int d){foreach(char ch in t){var a=new[]{new INPUT{type=INPUT_KEYBOARD,U=new InputUnion{ki=new KEYBDINPUT{wScan=ch,dwFlags=UNICODE}}},new INPUT{type=INPUT_KEYBOARD,U=new InputUnion{ki=new KEYBDINPUT{wScan=ch,dwFlags=UNICODE|KU}}}};SendInput(2,a,Marshal.SizeOf<INPUT>());if(d>0)await Task.Delay(d);}}static void Combo(string[] k){var m=new Dictionary<string,ushort>(StringComparer.OrdinalIgnoreCase){{"CTRL",0x11},{"SHIFT",0x10},{"ALT",0x12},{"WIN",0x5B},{"ENTER",0x0D},{"TAB",9},{"ESC",0x1B},{"DELETE",0x2E}};var v=k.Select(x=>m.TryGetValue(x,out var z)?z:(ushort)char.ToUpperInvariant(x.FirstOrDefault())).ToArray();foreach(var x in v)Vk(x,false);foreach(var x in v.Reverse())Vk(x,true);}static void Vk(ushort v,bool u){var a=new[]{new INPUT{type=INPUT_KEYBOARD,U=new InputUnion{ki=new KEYBDINPUT{wVk=v,dwFlags=u?KU:0}}}};SendInput(1,a,Marshal.SizeOf<INPUT>());}
 static object Pos(){GetCursorPos(out var p);return new{x=p.X,y=p.Y};}static bool Has(JsonElement a,string n)=>a.ValueKind==JsonValueKind.Object&&a.TryGetProperty(n,out _);static int I(JsonElement a,string n,int d=0)=>Has(a,n)&&a.GetProperty(n).TryGetInt32(out var v)?v:d;static string S(JsonElement a,string n,string d="")=>Has(a,n)?a.GetProperty(n).GetString()??d:d;static bool B(JsonElement a,string n,bool d=false)=>Has(a,n)&&a.GetProperty(n).ValueKind is JsonValueKind.True or JsonValueKind.False?a.GetProperty(n).GetBoolean():d;static T Safe<T>(Func<T> f,T d){try{return f();}catch{return d;}}
 static string CP=>System.IO.Path.Combine(AppContext.BaseDirectory,"settings.json");static AppConfig Load(){try{return File.Exists(CP)?JsonSerializer.Deserialize<AppConfig>(File.ReadAllText(CP),J)??new():new();}catch{return new();}}static void Save()=>File.WriteAllText(CP,JsonSerializer.Serialize(Config,J));
 sealed class AppConfig{public string BridgeUrl{get;set;}="https://mcogttus-production.up.railway.app";public string BridgeToken{get;set;}="";public bool LocalServerEnabled{get;set;}=true;public int LocalPort{get;set;}=8765;public int MouseUpdateHz{get;set;}=240;public PermissionSet Permissions{get;set;}=new();}
 sealed class PermissionSet{
  public bool Screen{get;set;}=true;
  public bool Mouse{get;set;}=true;
  public bool Keyboard{get;set;}=true;
  public bool Clipboard{get;set;}=true;
  public bool Windows{get;set;}=true;
  public bool FilesRead{get;set;}=true;
  public bool FilesWrite{get;set;}=false;
  public bool Processes{get;set;}=true;
  public bool System{get;set;}=true;
  public bool Commands{get;set;}=false;
  public bool Get(string n)=>n switch{"screen"=>Screen,"mouse"=>Mouse,"keyboard"=>Keyboard,"clipboard"=>Clipboard,"windows"=>Windows,"filesRead"=>FilesRead,"filesWrite"=>FilesWrite,"processes"=>Processes,"commands"=>Commands,_=>System};
  public void Set(string n,bool v){if(n=="screen")Screen=v;else if(n=="mouse")Mouse=v;else if(n=="keyboard")Keyboard=v;else if(n=="clipboard")Clipboard=v;else if(n=="windows")Windows=v;else if(n=="filesRead")FilesRead=v;else if(n=="filesWrite")FilesWrite=v;else if(n=="processes")Processes=v;else if(n=="commands")Commands=v;else System=v;}
 }
}
