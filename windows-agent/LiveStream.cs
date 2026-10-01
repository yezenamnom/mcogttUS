using System.Buffers.Binary;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using NAudio.Wave;
using System.Windows.Forms;

internal sealed class LiveStreamManager : IDisposable
{
 readonly Func<ReadOnlyMemory<byte>,CancellationToken,Task> send;
 CancellationTokenSource? cts;
 WasapiLoopbackCapture? audio;
 Process? encoder;
 public bool Running => cts is { IsCancellationRequested:false };
 public LiveStreamManager(Func<ReadOnlyMemory<byte>,CancellationToken,Task> sendPacket)=>send=sendPacket;

 public void Start(int screen,int fps,int width,int quality,bool withAudio,CancellationToken parent)
 {
  Stop();fps=Math.Clamp(fps,1,60);cts=CancellationTokenSource.CreateLinkedTokenSource(parent);var token=cts.Token;
  if(!StartH264(screen,fps,width,token))_=Task.Run(async()=>{var interval=TimeSpan.FromMilliseconds(1000d/fps);while(!token.IsCancellationRequested){var began=Stopwatch.GetTimestamp();try{var frame=Program.CaptureJpegData(screen,width,quality);await SendPacket(1,new{screen,mimeType="image/jpeg",frame.Width,frame.Height,at=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()},frame.Bytes,token);}catch{}var spent=Stopwatch.GetElapsedTime(began);var wait=interval-spent;if(wait>TimeSpan.Zero)try{await Task.Delay(wait,token);}catch{}}},token);
  if(withAudio)StartAudio(token);
 }
 bool StartH264(int screen,int fps,int width,CancellationToken token)
 {
  try{
   var ffmpeg=FindFfmpeg();if(ffmpeg is null)return false;var bounds=Screen.AllScreens[screen].Bounds;var height=Math.Max(2,(int)Math.Round(bounds.Height*(width/(double)bounds.Width))/2*2);
   var args=$"-hide_banner -loglevel error -f gdigrab -framerate {fps} -offset_x {bounds.X} -offset_y {bounds.Y} -video_size {bounds.Width}x{bounds.Height} -i desktop -vf scale={width}:{height} -an -c:v h264_nvenc -preset p1 -tune ull -rc cbr -b:v 5M -maxrate 5M -bufsize 1M -g {fps} -bf 0 -movflags frag_keyframe+empty_moov+default_base_moof -frag_duration 250000 -f mp4 pipe:1";
   encoder=Process.Start(new ProcessStartInfo(ffmpeg,args){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true});if(encoder is null)return false;
   _=Task.Run(async()=>{var buffer=new byte[128*1024];while(!token.IsCancellationRequested){var count=await encoder.StandardOutput.BaseStream.ReadAsync(buffer,token);if(count<=0)break;await SendPacket(3,new{screen,mimeType="video/mp4",codec="avc1.640028",width,height,at=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()},buffer.AsSpan(0,count).ToArray(),token);}},token);return true;
  }catch{return false;}
 }
 static string? FindFfmpeg(){var direct=Environment.GetEnvironmentVariable("GPT_US_FFMPEG");if(File.Exists(direct))return direct;var root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Microsoft","WinGet","Packages");return Directory.Exists(root)?Directory.EnumerateFiles(root,"ffmpeg.exe",SearchOption.AllDirectories).FirstOrDefault():null;}
 void StartAudio(CancellationToken token)
 {
  try{audio=new WasapiLoopbackCapture();var format=audio.WaveFormat;audio.DataAvailable+=async(_,e)=>{if(token.IsCancellationRequested||e.BytesRecorded<=0)return;var bytes=e.Buffer.AsMemory(0,e.BytesRecorded).ToArray();try{await SendPacket(2,new{sampleRate=format.SampleRate,channels=format.Channels,bits=format.BitsPerSample,encoding=format.Encoding.ToString(),at=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()},bytes,token);}catch{}};audio.StartRecording();}catch{audio?.Dispose();audio=null;}
 }
 async Task SendPacket(byte kind,object metadata,byte[] payload,CancellationToken token)
 {
  var header=Encoding.UTF8.GetBytes(JsonSerializer.Serialize(metadata));var packet=new byte[5+header.Length+payload.Length];packet[0]=kind;BinaryPrimitives.WriteInt32LittleEndian(packet.AsSpan(1,4),header.Length);header.CopyTo(packet,5);payload.CopyTo(packet,5+header.Length);await send(packet,token);
 }
 public void Stop(){try{cts?.Cancel();}catch{}try{encoder?.Kill(true);encoder?.Dispose();}catch{}encoder=null;try{audio?.StopRecording();audio?.Dispose();}catch{}audio=null;cts?.Dispose();cts=null;}
 public void Dispose()=>Stop();
}

