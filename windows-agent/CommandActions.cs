using System.Diagnostics;
using System.Text.Json;

internal static partial class Program
{
 static async Task<object> RunCommand(JsonElement args)
 {
  if(!Config.Permissions.Get("commands"))throw new InvalidOperationException("Permission disabled: commands. Enable it once in the Windows agent Permissions tab.");
  var command=S(args,"command");
  if(string.IsNullOrWhiteSpace(command)||command.Length>4000)throw new ArgumentException("Command must contain 1–4000 characters");
  var timeout=Math.Clamp(I(args,"timeoutMs",15000),1000,30000);
  var start=new ProcessStartInfo(System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"cmd.exe")){
   UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,
   WorkingDirectory=Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
  };
  start.ArgumentList.Add("/d");start.ArgumentList.Add("/s");start.ArgumentList.Add("/c");start.ArgumentList.Add(command);
  using var process=new Process{StartInfo=start};
  if(!process.Start())throw new InvalidOperationException("Could not start command prompt");
  using var cancel=new CancellationTokenSource(timeout);
  try{
   var stdout=process.StandardOutput.ReadToEndAsync(cancel.Token);
   var stderr=process.StandardError.ReadToEndAsync(cancel.Token);
   await process.WaitForExitAsync(cancel.Token);
   var output=await stdout;var error=await stderr;
   return new{exitCode=process.ExitCode,stdout=output.Length>64000?output[..64000]:output,stderr=error.Length>16000?error[..16000]:error,truncated=output.Length>64000||error.Length>16000};
  }catch(OperationCanceledException){try{process.Kill(true);}catch{}throw new TimeoutException("Command timed out after "+timeout+" ms");}
 }
}
