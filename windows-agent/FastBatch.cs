using System.Diagnostics;
using System.Text.Json;

internal static partial class Program
{
 static readonly HashSet<string> FastBatchCommands=new(StringComparer.Ordinal){
  "desktop_mouse_action","desktop_move_mouse","desktop_click","desktop_scroll",
  "desktop_type_text","desktop_key_combo","desktop_window_activate",
  "desktop_window_minimize","desktop_window_maximize","desktop_window_restore"
 };
 static async Task<object> FastBatch(JsonElement args)
 {
  if(!Has(args,"actions")||args.GetProperty("actions").ValueKind!=JsonValueKind.Array)
   throw new ArgumentException("actions must be an array");
  var actions=args.GetProperty("actions").EnumerateArray().ToArray();
  if(actions.Length is <1 or >12)throw new ArgumentException("fast_batch accepts 1–12 actions");
  var results=new List<object>();var clock=Stopwatch.StartNew();
  foreach(var action in actions){
   if(clock.ElapsedMilliseconds>20000)throw new TimeoutException("Batch exceeded 20 seconds");
   var command=S(action,"command");
   if(!FastBatchCommands.Contains(command))throw new ArgumentException("Unsupported fast batch command: "+command);
   var parameters=Has(action,"args")?action.GetProperty("args"):default;
   if(command=="desktop_mouse_action"&&S(parameters,"kind") is not ("move" or "click" or "right" or "double" or "drag" or "scroll"))
    throw new ArgumentException("Unsupported nested mouse action");
   Permit(command);
   try{results.Add(new{command,ok=true,result=await Exec(command,parameters)});}
   catch(Exception error){results.Add(new{command,ok=false,error=error.Message});return new{completed=false,count=results.Count,elapsedMs=clock.ElapsedMilliseconds,results};}
  }
  return new{completed=true,count=results.Count,elapsedMs=clock.ElapsedMilliseconds,results};
 }
}
