using System.Diagnostics;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Drawing;
using System.Drawing.Imaging;
using System.Windows.Forms;

internal static class Program
{
    [DllImport("user32.dll")] static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
    [DllImport("user32.dll")] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] static extern short VkKeyScan(char ch);

    const uint MOUSEEVENTF_LEFTDOWN=0x0002, MOUSEEVENTF_LEFTUP=0x0004, MOUSEEVENTF_RIGHTDOWN=0x0008, MOUSEEVENTF_RIGHTUP=0x0010;
    const uint INPUT_KEYBOARD=1, KEYEVENTF_KEYUP=0x0002, KEYEVENTF_UNICODE=0x0004;

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }

    static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web);

    [STAThread]
    static async Task Main()
    {
        ApplicationConfiguration.Initialize();
        var cfg = LoadConfig();
        while (true)
        {
            try { await RunAsync(cfg); }
            catch (Exception ex) { Console.WriteLine(ex.Message); }
            await Task.Delay(2500);
        }
    }

    static Config LoadConfig()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "settings.json");
        if (!File.Exists(path)) throw new FileNotFoundException("settings.json not found", path);
        return JsonSerializer.Deserialize<Config>(File.ReadAllText(path), JsonOpts) ?? throw new Exception("Invalid settings.json");
    }

    static async Task RunAsync(Config cfg)
    {
        using var ws = new ClientWebSocket();
        var baseUrl = cfg.BridgeUrl.TrimEnd('/').Replace("https://","wss://").Replace("http://","ws://");
        var uri = new Uri($"{baseUrl}/desktop?token={Uri.EscapeDataString(cfg.BridgeToken)}");
        await ws.ConnectAsync(uri, CancellationToken.None);
        Console.WriteLine("Desktop bridge connected");

        var buf = new byte[1024*1024];
        while (ws.State == WebSocketState.Open)
        {
            using var ms = new MemoryStream();
            WebSocketReceiveResult r;
            do {
                r = await ws.ReceiveAsync(buf, CancellationToken.None);
                if (r.MessageType == WebSocketMessageType.Close) return;
                ms.Write(buf,0,r.Count);
            } while (!r.EndOfMessage);

            using var doc = JsonDocument.Parse(ms.ToArray());
            var root = doc.RootElement;
            if (!root.TryGetProperty("type", out var t) || t.GetString() != "command") continue;
            var id = root.GetProperty("id").GetString()!;
            var command = root.GetProperty("command").GetString()!;
            var args = root.TryGetProperty("args", out var a) ? a : default;

            object? result=null; string? error=null;
            try { result = await ExecuteAsync(command,args); }
            catch(Exception ex){ error=ex.Message; }

            var payload = JsonSerializer.Serialize(new { type="result", id, ok=error is null, result, error }, JsonOpts);
            await ws.SendAsync(Encoding.UTF8.GetBytes(payload), WebSocketMessageType.Text, true, CancellationToken.None);
        }
    }

    static async Task<object> ExecuteAsync(string cmd, JsonElement a)
    {
        switch(cmd)
        {
            case "desktop_info":
                return new { version="0.1.0", machine=Environment.MachineName, user=Environment.UserName, os=Environment.OSVersion.VersionString };
            case "desktop_screen_size":
                var b=SystemInformation.VirtualScreen; return new { x=b.X,y=b.Y,width=b.Width,height=b.Height };
            case "desktop_screenshot":
                return CaptureScreen();
            case "desktop_move_mouse":
                await SmoothMove(I(a,"x"),I(a,"y"),I(a,"durationMs",220)); return Pos();
            case "desktop_click":
                if (Has(a,"x")&&Has(a,"y")) await SmoothMove(I(a,"x"),I(a,"y"),I(a,"durationMs",160));
                Click(S(a,"button","left"),I(a,"count",1)); return Pos();
            case "desktop_mouse_path":
                return await MousePath(a);
            case "desktop_type_text":
                await TypeText(S(a,"text",""),I(a,"intervalMs",5)); return new { typed=true };
            case "desktop_key_combo":
                KeyCombo(a.GetProperty("keys").EnumerateArray().Select(x=>x.GetString()??"").ToArray()); return new { pressed=true };
            case "desktop_open_path":
                var p=S(a,"path",""); if(!File.Exists(p)&&!Directory.Exists(p)) throw new Exception("Path not found");
                Process.Start(new ProcessStartInfo(p){UseShellExecute=true}); return new { opened=true,path=p };
            case "desktop_file_exists":
                var fp=S(a,"path",""); return new { path=fp,exists=File.Exists(fp),directory=Directory.Exists(fp) };
            case "desktop_list_files":
                var dir=S(a,"path",Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
                var files=Directory.EnumerateFileSystemEntries(dir).Take(300).Select(x=>new { name=Path.GetFileName(x), path=x, directory=Directory.Exists(x) }).ToArray();
                return new { path=dir,items=files };
            default: throw new Exception("Unknown desktop command: "+cmd);
        }
    }

    static object CaptureScreen()
    {
        var r=SystemInformation.VirtualScreen;
        using var bmp=new Bitmap(r.Width,r.Height);
        using(var g=Graphics.FromImage(bmp)) g.CopyFromScreen(r.Left,r.Top,0,0,bmp.Size);
        using var ms=new MemoryStream(); bmp.Save(ms,ImageFormat.Png);
        return new { mimeType="image/png", data=Convert.ToBase64String(ms.ToArray()), x=r.X,y=r.Y,width=r.Width,height=r.Height };
    }

    static async Task<object> MousePath(JsonElement a)
    {
        var pts=a.GetProperty("points").EnumerateArray().Select(p=>(x:p.GetProperty("x").GetInt32(),y:p.GetProperty("y").GetInt32())).ToArray();
        if(pts.Length<2) throw new Exception("At least 2 points required");
        var dur=I(a,"durationMs",700); var press=B(a,"press",false); var button=S(a,"button","left");
        await SmoothMove(pts[0].x,pts[0].y,120);
        if(press) MouseDown(button);
        var total=Math.Max(1,pts.Zip(pts.Skip(1),(u,v)=>Math.Sqrt(Math.Pow(v.x-u.x,2)+Math.Pow(v.y-u.y,2))).Sum());
        for(int i=1;i<pts.Length;i++)
        {
            var u=pts[i-1]; var v=pts[i]; var seg=Math.Sqrt(Math.Pow(v.x-u.x,2)+Math.Pow(v.y-u.y,2));
            await SmoothMove(v.x,v.y,Math.Max(20,(int)(dur*seg/total)));
        }
        if(press) MouseUp(button);
        return new { moved=true,points=pts.Length };
    }

    static async Task SmoothMove(int x,int y,int duration)
    {
        GetCursorPos(out var s); duration=Math.Clamp(duration,0,10000);
        if(duration==0){ SetCursorPos(x,y); return; }
        var sw=Stopwatch.StartNew();
        while(sw.ElapsedMilliseconds<duration)
        {
            var t=Math.Clamp(sw.Elapsed.TotalMilliseconds/duration,0,1);
            var e=t<.5?4*t*t*t:1-Math.Pow(-2*t+2,3)/2;
            SetCursorPos((int)Math.Round(s.X+(x-s.X)*e),(int)Math.Round(s.Y+(y-s.Y)*e));
            await Task.Delay(8);
        }
        SetCursorPos(x,y);
    }

    static void Click(string button,int count){ for(int i=0;i<Math.Clamp(count,1,3);i++){ MouseDown(button); Thread.Sleep(35); MouseUp(button); Thread.Sleep(55); } }
    static void MouseDown(string b)=>mouse_event(b=="right"?MOUSEEVENTF_RIGHTDOWN:MOUSEEVENTF_LEFTDOWN,0,0,0,UIntPtr.Zero);
    static void MouseUp(string b)=>mouse_event(b=="right"?MOUSEEVENTF_RIGHTUP:MOUSEEVENTF_LEFTUP,0,0,0,UIntPtr.Zero);

    static async Task TypeText(string text,int interval)
    {
        foreach(var ch in text)
        {
            var inputs=new[]{ new INPUT{type=INPUT_KEYBOARD,U=new InputUnion{ki=new KEYBDINPUT{wScan=ch,dwFlags=KEYEVENTF_UNICODE}}},
                              new INPUT{type=INPUT_KEYBOARD,U=new InputUnion{ki=new KEYBDINPUT{wScan=ch,dwFlags=KEYEVENTF_UNICODE|KEYEVENTF_KEYUP}}}};
            SendInput(2,inputs,Marshal.SizeOf<INPUT>()); if(interval>0) await Task.Delay(interval);
        }
    }

    static void KeyCombo(string[] keys)
    {
        var map=new Dictionary<string,ushort>(StringComparer.OrdinalIgnoreCase){{"CTRL",0x11},{"CONTROL",0x11},{"SHIFT",0x10},{"ALT",0x12},{"WIN",0x5B},{"ENTER",0x0D},{"TAB",0x09},{"ESC",0x1B},{"ESCAPE",0x1B},{"BACKSPACE",0x08},{"DELETE",0x2E},{"SPACE",0x20},{"UP",0x26},{"DOWN",0x28},{"LEFT",0x25},{"RIGHT",0x27},{"F5",0x74}};
        var vks=keys.Select(k=>map.TryGetValue(k,out var v)?v:(ushort)char.ToUpperInvariant(k.FirstOrDefault())).Where(v=>v!=0).ToArray();
        foreach(var vk in vks) SendVk(vk,false);
        foreach(var vk in vks.Reverse()) SendVk(vk,true);
    }
    static void SendVk(ushort vk,bool up)
    {
        var input=new[]{new INPUT{type=INPUT_KEYBOARD,U=new InputUnion{ki=new KEYBDINPUT{wVk=vk,dwFlags=up?KEYEVENTF_KEYUP:0}}}};
        SendInput(1,input,Marshal.SizeOf<INPUT>());
    }

    static object Pos(){ GetCursorPos(out var p); return new { x=p.X,y=p.Y }; }
    static bool Has(JsonElement a,string n)=>a.ValueKind==JsonValueKind.Object&&a.TryGetProperty(n,out _);
    static int I(JsonElement a,string n,int d=0)=>Has(a,n)&&a.GetProperty(n).TryGetInt32(out var v)?v:d;
    static string S(JsonElement a,string n,string d="")=>Has(a,n)?a.GetProperty(n).GetString()??d:d;
    static bool B(JsonElement a,string n,bool d=false)=>Has(a,n)&&a.GetProperty(n).ValueKind is JsonValueKind.True or JsonValueKind.False?a.GetProperty(n).GetBoolean():d;

    record Config(string BridgeUrl,string BridgeToken);
}
