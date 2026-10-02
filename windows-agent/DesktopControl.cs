using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Drawing.Imaging;

internal static partial class Program
{
    delegate bool WindowCallback(IntPtr handle,IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback,IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr handle);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr handle,int command);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle,out uint pid);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr handle,StringBuilder text,int count);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle,out WindowRect rect);
    [DllImport("user32.dll",SetLastError=true)] static extern bool PostMessage(IntPtr handle,uint message,IntPtr wParam,IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] struct WindowRect{public int Left,Top,Right,Bottom;}
    static IntPtr SelectedWindow;
    static int SelectedProcess;
    static long SelectedProcessStart;
    static Rectangle Bounds(IntPtr handle){if(!GetWindowRect(handle,out var r))throw new Exception("Cannot read window bounds");return Rectangle.FromLTRB(r.Left,r.Top,r.Right,r.Bottom);}
    static object WindowState(IntPtr handle){GetWindowThreadProcessId(handle,out var pid);var text=new StringBuilder(1024);GetWindowText(handle,text,text.Capacity);var rect=Bounds(handle);return new{hwnd=handle.ToInt64(),pid,title=text.ToString(),name=Safe(()=>Process.GetProcessById((int)pid).ProcessName,""),active=GetForegroundWindow()==handle,minimized=IsIconic(handle),maximized=IsZoomed(handle),bounds=new{x=rect.X,y=rect.Y,width=rect.Width,height=rect.Height}};}
    static IntPtr[] VisibleWindows(){var handles=new List<IntPtr>();EnumWindows((h,_)=>{if(IsWindowVisible(h)){var name=new StringBuilder(1024);GetWindowText(h,name,name.Capacity);if(name.Length>0)handles.Add(h);}return true;},IntPtr.Zero);return handles.ToArray();}
    static IntPtr TargetWindow(){
        RestoreTarget();
        if(SelectedWindow==IntPtr.Zero)throw new Exception("Select a target window first");
        GetWindowThreadProcessId(SelectedWindow,out var pid);
        if(!IsWindow(SelectedWindow)||pid!=SelectedProcess||Safe(()=>Process.GetProcessById((int)pid).StartTime.ToUniversalTime().Ticks,0L)!=SelectedProcessStart)throw new Exception("Selected window is closed or changed; select a new target");
        return SelectedWindow;
    }
    static void RequirePermission(string permission){if(!Config.Permissions.Get(permission))throw new Exception("Permission disabled: "+permission);}
    static async Task<bool> RestoreWindow(IntPtr handle){
        ShowWindowAsync(handle,9);
        for(int attempt=0;attempt<10;attempt++){await Task.Delay(50);if(!IsIconic(handle)&&!IsZoomed(handle))return true;}
        try{
            var root=System.Windows.Automation.AutomationElement.FromHandle(handle);
            if(root.TryGetCurrentPattern(System.Windows.Automation.WindowPattern.Pattern,out var pattern))
                ((System.Windows.Automation.WindowPattern)pattern).SetWindowVisualState(System.Windows.Automation.WindowVisualState.Normal);
        }catch{}
        if(!IsIconic(handle)&&!IsZoomed(handle))return true;
        // An idempotent restore message is safe to retry on the same exact hwnd.
        // Some UWP windows ignore ShowWindow across the owner thread.
        PostMessage(handle,0x0112,new IntPtr(0xF120),IntPtr.Zero);
        for(int attempt=0;attempt<10;attempt++){await Task.Delay(50);if(!IsIconic(handle)&&!IsZoomed(handle))return true;}
        return false;
    }
    static async Task FocusWindow(IntPtr handle){
        RequirePermission("windows");
        if(IsIconic(handle)&&!await RestoreWindow(handle))throw new Exception("Target could not be restored; input was not sent");
        SetForegroundWindow(handle);await Task.Delay(80);
        if(GetForegroundWindow()!=handle){ShowWindow(handle,9);SetForegroundWindow(handle);await Task.Delay(100);}
        if(GetForegroundWindow()!=handle)throw new Exception("Target is not foreground; input was not sent");
    }
    static object CaptureArea(Rectangle rect){
        if(rect.Width<1||rect.Height<1||!SystemInformation.VirtualScreen.Contains(rect))throw new Exception("Capture region is outside the desktop");
        using var image=new Bitmap(rect.Width,rect.Height);using(var graphics=Graphics.FromImage(image))graphics.CopyFromScreen(rect.Left,rect.Top,0,0,image.Size);
        using var memory=new MemoryStream();image.Save(memory,ImageFormat.Png);
        return new{data=Convert.ToBase64String(memory.ToArray()),mimeType="image/png",x=rect.X,y=rect.Y,width=rect.Width,height=rect.Height,originalResolution=true};
    }
    static object CaptureTarget(JsonElement args){
        RequirePermission("screen");var target=TargetWindow();
        if(IsIconic(target))throw new Exception("Window is minimized; restore before capture");
        var bounds=Rectangle.Intersect(Bounds(target),SystemInformation.VirtualScreen);
        object? crop=null;
        if(Has(args,"region")){var r=args.GetProperty("region");var region=new Rectangle(I(r,"x"),I(r,"y"),I(r,"width"),I(r,"height"));if(!bounds.Contains(region))throw new Exception("Region must be inside target window");crop=CaptureArea(region);}
        return new{window=WindowState(target),windowImage=CaptureArea(bounds),screenImage=CaptureArea(Screen.FromHandle(target).Bounds),crop,visiblePixels=true,occlusionPossible=GetForegroundWindow()!=target,observedAt=DateTimeOffset.UtcNow};
    }
    static async Task<object> DesktopControl(JsonElement args){
        RestoreTarget();var kind=S(args,"kind");RequirePermission("windows");
        if(kind=="list")return VisibleWindows().Select(h=>Safe(()=>WindowState(h),new{unavailable=true} as object)).ToArray();
        if(kind=="active"){var target=SelectedWindow==IntPtr.Zero?null:Safe(()=>WindowState(TargetWindow()),null as object);return new{active=GetForegroundWindow()==IntPtr.Zero?null:WindowState(GetForegroundWindow()),target,targetValid=target!=null};}
        if(kind=="select"){
            IntPtr handle;
            if(Has(args,"hwnd"))handle=new IntPtr(args.GetProperty("hwnd").GetInt64());
            else {var matches=VisibleWindows().Where(h=>{GetWindowThreadProcessId(h,out var p);return p==I(args,"pid");}).ToArray();if(matches.Length!=1)throw new Exception("PID must identify exactly one visible window; use hwnd");handle=matches[0];}
            if(!IsWindowVisible(handle))throw new Exception("Target is not a visible window");
            GetWindowThreadProcessId(handle,out var pid);SelectedWindow=handle;SelectedProcess=(int)pid;SelectedProcessStart=Process.GetProcessById((int)pid).StartTime.ToUniversalTime().Ticks;
            TargetLoaded=true;SaveTarget();if(B(args,"activate",true))await FocusWindow(handle);
            return new{selected=true,window=WindowState(handle)};
        }
        if(kind=="capture"){if(B(args,"activate",true))await FocusWindow(TargetWindow());return CaptureTarget(args);}
        if(kind!="batch")throw new Exception("Unknown desktop control operation");
        var actions=args.GetProperty("actions").EnumerateArray().ToArray();if(actions.Length is <1 or >12)throw new Exception("Expected 1–12 actions");
        var results=new List<object>();var stopwatch=Stopwatch.StartNew();bool complete=true;
        foreach(var action in actions){
            var operation=S(action,"kind");bool verified=false;
            try{
                if(stopwatch.ElapsedMilliseconds>20000)throw new Exception("Batch exceeded time limit");
                var target=TargetWindow();
                switch(operation){
                    case "activate":await FocusWindow(target);verified=true;break;
                    case "minimize":ShowWindow(target,6);await Task.Delay(80);verified=IsIconic(target);break;
                    case "maximize":ShowWindow(target,3);await Task.Delay(80);verified=IsZoomed(target);break;
                    case "restore":verified=await RestoreWindow(target);break;
                    case "close":if(!PostMessage(target,0x0010,IntPtr.Zero,IntPtr.Zero))throw new Exception("Close request rejected");await Task.Delay(150);verified=!IsWindow(target);break;
                    case "type":RequirePermission("keyboard");await FocusWindow(target);foreach(char ch in S(action,"text")){if(GetForegroundWindow()!=target)throw new Exception("Target lost focus; text input stopped");await Type(ch.ToString(),I(action,"intervalMs",0));}break;
                    case "keys":RequirePermission("keyboard");await FocusWindow(target);Combo(action.GetProperty("keys").EnumerateArray().Select(v=>v.GetString()??"").ToArray());break;
                    case "move":case "click":case "scroll":
                        RequirePermission("mouse");await FocusWindow(target);
                        int x=I(action,"x"),y=I(action,"y");
                        if(operation!="scroll"){
                            if(!Has(action,"x")||!Has(action,"y")||!Bounds(target).Contains(x,y))throw new Exception("Coordinates must be within target window");
                            await Smooth(x,y,I(action,"durationMs",80));
                        }
                        if(operation=="click")Click(S(action,"button","left"),I(action,"count",1));
                        if(operation=="scroll"){var area=Rectangle.Intersect(Bounds(target),SystemInformation.VirtualScreen);await Smooth(area.X+area.Width/2,area.Y+area.Height/2,60);MouseInput(0x0800u,data:unchecked((uint)I(action,"delta",-120)));}
                        verified=operation=="move";break;
                    default:throw new Exception("Unsupported action: "+operation);
                }
                results.Add(new{kind=operation,executed=true,uiVerified=verified});
                if(operation is "minimize" or "maximize" or "restore" or "close" && !verified){complete=false;break;}
            }catch(Exception error){complete=false;results.Add(new{kind=operation,executed=false,outcome="failed_or_partial",error=error.Message,uiVerified=false});break;}
        }
        object? evidence=null;string? captureError=null;
        if(B(args,"screenshotAfter",true)&&IsWindow(SelectedWindow)&&!IsIconic(SelectedWindow))try{evidence=CaptureTarget(args);}catch(Exception error){captureError=error.Message;}
        return new{completed=complete,results,elapsedMs=stopwatch.ElapsedMilliseconds,window=IsWindow(SelectedWindow)?WindowState(SelectedWindow):null,cursor=Pos(),evidence,captureError,needsVisualVerification=results.Any(r=>r.GetType().GetProperty("uiVerified")?.GetValue(r) is false)};
    }
}
