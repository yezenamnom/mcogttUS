using System.Diagnostics;
using System.Text.Json;

internal static partial class Program
{
    static async Task<object> ProcessControl(JsonElement args)
    {
        RequirePermission("commands");RequirePermission("processes");
        var before=Process.GetProcesses().Select(p=>p.Id).ToArray();var action=S(args,"action");int pid;
        if(action=="start"){
            var executable=S(args,"executable");if(!System.IO.Path.IsPathFullyQualified(executable)||!File.Exists(executable)||!executable.EndsWith(".exe",StringComparison.OrdinalIgnoreCase))throw new ArgumentException("An existing absolute executable path is required");
            var start=new ProcessStartInfo(executable){UseShellExecute=false,CreateNoWindow=true};
            if(Has(args,"arguments"))foreach(var arg in args.GetProperty("arguments").EnumerateArray())start.ArgumentList.Add(arg.GetString()??"");
            using var process=Process.Start(start)??throw new Exception("Process start failed");pid=process.Id;
        }else if(action=="stop"){
            pid=I(args,"pid");if(pid==Environment.ProcessId)throw new Exception("Cannot stop the GPT US agent through its own process tool");
            using var process=Process.GetProcessById(pid);
            if(!long.TryParse(S(args,"startTicks"),out var ticks)||process.StartTime.ToUniversalTime().Ticks!=ticks)throw new Exception("Process identity changed; refresh before stopping");
            process.Kill();await process.WaitForExitAsync();
        }else throw new Exception("Unsupported process action");
        await Task.Delay(100);var after=Process.GetProcesses().Select(p=>p.Id).ToArray();
        bool verified=action=="start"?after.Contains(pid):!after.Contains(pid);
        return new{executed=true,verified,pid,before,after,comparison=new{presentBefore=before.Contains(pid),presentAfter=after.Contains(pid)},startTicks=verified&&action=="start"?Safe(()=>Process.GetProcessById(pid).StartTime.ToUniversalTime().Ticks.ToString(),""):""};
    }
}
