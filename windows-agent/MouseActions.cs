using System.Diagnostics;
using System.Text.Json;

internal static partial class Program
{
 static async Task<object> MouseAction(JsonElement a)
 {
  if(S(a,"kind")=="live_stream_start"){
   LiveStream?.Start(I(a,"screen",0),I(a,"fps",60),I(a,"width",1024),I(a,"quality",48),B(a,"audio",true),AgentToken);
    await Task.Delay(3000);
    return new{started=LiveStream?.Running??false,targetFps=I(a,"fps",60),audio=B(a,"audio",true),mode=LiveStream?.Mode,videoError=LiveStream?.LastVideoError};
  }
  if(S(a,"kind")=="live_stream_stop"){LiveStream?.Stop();return new{stopped=true};}
  if(S(a,"kind")=="report")return WorkspaceReport();
  if(S(a,"kind")=="save_report")return SaveBrowserReport(a);
  if(S(a,"kind")=="report_latest")return ReadLatestReport(a);
  if(S(a,"kind")=="run_command")return await RunCommand(a);
  if(S(a,"kind")=="fast_batch")return await FastBatch(a);
  if(S(a,"kind")=="smart_actions_save")return SmartActionsSave(a);
  if(S(a,"kind")=="smart_actions_read")return SmartActionsRead();
  if(S(a,"kind")=="smart_actions_choose")return SmartActionsChoose(a);
  var kind=S(a,"kind","click");
  if(kind is not ("move" or "click" or "double" or "right" or "drag" or "scroll"))
   throw new ArgumentException("Unknown mouse action");
  string button=kind=="right"?"right":S(a,"button","left");
  ButtonFlag(button,false);
  if(!Has(a,"x")||!Has(a,"y"))throw new ArgumentException("x and y are required");
  int x=I(a,"x"),y=I(a,"y");
  if(!GetCursorPos(out var start))throw new InvalidOperationException("Cannot read cursor");
  var distance=Math.Sqrt(Math.Pow(x-start.X,2)+Math.Pow(y-start.Y,2));
  int duration=I(a,"durationMs",Math.Clamp((int)(distance/12),25,90));
  ValidatePoint(x,y);
  if(duration<0||duration>10000)throw new ArgumentException("Invalid duration");
  int tx=I(a,"toX"),ty=I(a,"toY");
  if(kind=="drag"){
   if(!Has(a,"toX")||!Has(a,"toY"))throw new ArgumentException("Drag endpoint required");
   ValidatePoint(tx,ty);
  }
  int delta=I(a,"delta",-120);
  if(Math.Abs((long)delta)>12000)throw new ArgumentException("Invalid wheel delta");
  var clock=Stopwatch.StartNew();
  await Smooth(x,y,kind=="drag"?80:duration);
  int updates=LastMoveUpdates;
  if(kind=="drag"){
   try{Down(button);await Task.Delay(35);await Smooth(tx,ty,duration);updates+=LastMoveUpdates;}
   finally{Up(button);}
  }else if(kind is "click" or "double" or "right")Click(button,kind=="double"?2:1);
  else if(kind=="scroll")MouseInput(B(a,"horizontal")?0x1000u:0x0800u,data:unchecked((uint)delta));
  if(!GetCursorPos(out var p))throw new InvalidOperationException("Cannot read final cursor");
  return new{executed=true,kind,x=p.X,y=p.Y,input="SendInput",targetReached=true,
   targetUpdateHz=Math.Clamp(Config.MouseUpdateHz,30,240),updates,elapsedMs=clock.Elapsed.TotalMilliseconds,
   uiVerified=false};
 }
}

