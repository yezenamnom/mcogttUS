using System.Diagnostics;
using System.Text.Json;
using System.Windows.Automation;

internal static partial class Program
{
    static readonly string PersistentTargetPath=System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"ChatGPTDesktopBridge","target.json");
    static bool TargetLoaded;
    static JsonElement? SelectedElementRef;
    static void SaveTarget(){Directory.CreateDirectory(System.IO.Path.GetDirectoryName(PersistentTargetPath)!);var h=TargetWindow();File.WriteAllText(PersistentTargetPath+".tmp",JsonSerializer.Serialize(new{hwnd=h.ToInt64(),pid=SelectedProcess,start=SelectedProcessStart,screen=Screen.FromHandle(h).DeviceName,element=SelectedElementRef}));File.Move(PersistentTargetPath+".tmp",PersistentTargetPath,true);}
    static void RestoreTarget(){if(TargetLoaded)return;TargetLoaded=true;if(!File.Exists(PersistentTargetPath))return;using var doc=JsonDocument.Parse(File.ReadAllText(PersistentTargetPath));var root=doc.RootElement;SelectedWindow=new IntPtr(root.GetProperty("hwnd").GetInt64());SelectedProcess=root.GetProperty("pid").GetInt32();SelectedProcessStart=root.GetProperty("start").GetInt64();SelectedElementRef=root.TryGetProperty("element",out var element)&&element.ValueKind==JsonValueKind.Object?element.Clone():null;}
    static AutomationElement? FindTargetElement(JsonElement args){
        var root=AutomationElement.FromHandle(TargetWindow());
        var id=S(args,"automationId");var name=S(args,"name");
        if(id.Length==0&&name.Length==0)throw new ArgumentException("Specify automationId or exact name");
        var condition=id.Length>0?new PropertyCondition(AutomationElement.AutomationIdProperty,id):new PropertyCondition(AutomationElement.NameProperty,name);
        var matches=root.FindAll(TreeScope.Descendants,condition);
        if(matches.Count>1)throw new InvalidOperationException("Ambiguous UIA target; reselect explicitly");
        if(matches.Count==0)return null;
        var element=matches[0];if(!element.Current.IsEnabled)throw new InvalidOperationException("UIA target disabled");if(element.Current.IsOffscreen)return null;
        return element;
    }
    static object ObserveLayered(JsonElement args){
        RestoreTarget();RequirePermission("windows");RequirePermission("screen");IntPtr h;try{h=TargetWindow();}catch{if(SelectedWindow!=IntPtr.Zero)return new{window=(object?)null,element=(object?)null,targetClosed=true};throw;}
        object? element=null;
        if(S(args,"automationId").Length>0||S(args,"name").Length>0){var found=FindTargetElement(args);if(found!=null){var current=found.Current;object? value=null;
            if(!current.IsPassword&&found.TryGetCurrentPattern(ValuePattern.Pattern,out var pattern))value=((ValuePattern)pattern).Current.Value;
            element=new{name=current.Name,automationId=current.AutomationId,enabled=current.IsEnabled,value,selected=found.TryGetCurrentPattern(SelectionItemPattern.Pattern,out var selection)?((SelectionItemPattern)selection).Current.IsSelected:(bool?)null};}}
        return new{window=WindowState(h),element,cursor=Pos(),observedAt=DateTimeOffset.UtcNow};
    }
    static async Task<object> ActLayered(JsonElement args){
        RestoreTarget();RequirePermission("windows");var layer=S(args,"layer");var action=S(args,"action");
        if(layer=="os"){
            if(action is not ("activate" or "minimize" or "maximize" or "restore" or "close"))return new{notExecuted=true,retrySafe=true,reason="No direct OS operation for this action"};
            var payload=JsonSerializer.SerializeToElement(new{kind="batch",actions=new[]{new{kind=action}},screenshotAfter=false});
            var result=await DesktopControl(payload);return new{executed=true,layer,result};
        }
        if(layer=="uia"){
            if(S(args,"automationId").Length==0&&S(args,"name").Length==0)return new{notExecuted=true,retrySafe=true,reason="No UIA target reference; inspected vision coordinates may be used"};
            AutomationElement? element;try{element=FindTargetElement(args);}catch(InvalidOperationException error){return new{notExecuted=true,retrySafe=false,reason=error.Message};}if(element==null)return new{notExecuted=true,retrySafe=true,reason="Element missing or hidden"};
            if(action=="click"&&element.TryGetCurrentPattern(InvokePattern.Pattern,out var invoke)){RequirePermission("mouse");((InvokePattern)invoke).Invoke();return new{executed=true,layer};}
            if(action=="type"&&element.TryGetCurrentPattern(ValuePattern.Pattern,out var value)){RequirePermission("keyboard");if(element.Current.IsPassword)throw new Exception("Protected field cannot be verified");((ValuePattern)value).SetValue(S(args,"text"));return new{executed=true,layer};}
            if(action=="select"&&element.TryGetCurrentPattern(SelectionItemPattern.Pattern,out var selected)){RequirePermission("mouse");((SelectionItemPattern)selected).Select();return new{executed=true,layer};}
            return new{notExecuted=true,retrySafe=true,reason="UIA pattern unavailable"};
        }
        if(layer=="vision"){
            if(!B(args,"allowVision"))return new{notExecuted=true,retrySafe=false,reason="Vision fallback requires inspected target coordinates"};
            var actionArgs=JsonSerializer.SerializeToElement(new{kind=action,x=I(args,"x"),y=I(args,"y"),text=S(args,"text")});
            var actions=action=="type"?new[]{JsonSerializer.SerializeToElement(new{kind="click",x=I(args,"x"),y=I(args,"y")}),actionArgs}:new[]{actionArgs};var result=await DesktopControl(JsonSerializer.SerializeToElement(new{kind="batch",actions,screenshotAfter=false}));return new{executed=true,layer,result};
        }
        return new{notExecuted=true,retrySafe=true,reason="Unsupported layer"};
    }
}
