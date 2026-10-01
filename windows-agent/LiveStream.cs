using System.Buffers.Binary;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using NAudio.Wave;

internal sealed class LiveStreamManager : IDisposable
{
 readonly Func<ReadOnlyMemory<byte>,CancellationToken,Task> send;
 CancellationTokenSource? cts;
 WasapiLoopbackCapture? audio;
 public bool Running => cts is { IsCancellationRequested:false };
 public LiveStreamManager(Func<ReadOnlyMemory<byte>,CancellationToken,Task> sendPacket)=>send=sendPacket;

 public void Start(int screen,int fps,int width,int quality,bool withAudio,CancellationToken parent)
 {
  Stop();fps=Math.Clamp(fps,1,60);cts=CancellationTokenSource.CreateLinkedTokenSource(parent);var token=cts.Token;
  _=Task.Run(async()=>{var interval=TimeSpan.FromMilliseconds(1000d/fps);while(!token.IsCancellationRequested){var began=Stopwatch.GetTimestamp();try{var frame=Program.CaptureJpegData(screen,width,quality);await SendPacket(1,new{screen,mimeType="image/jpeg",frame.Width,frame.Height,at=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()},frame.Bytes,token);}catch{}var spent=Stopwatch.GetElapsedTime(began);var wait=interval-spent;if(wait>TimeSpan.Zero)try{await Task.Delay(wait,token);}catch{}}},token);
  if(withAudio)StartAudio(token);
 }
 void StartAudio(CancellationToken token)
 {
  try{audio=new WasapiLoopbackCapture();var format=audio.WaveFormat;audio.DataAvailable+=async(_,e)=>{if(token.IsCancellationRequested||e.BytesRecorded<=0)return;var bytes=e.Buffer.AsMemory(0,e.BytesRecorded).ToArray();try{await SendPacket(2,new{sampleRate=format.SampleRate,channels=format.Channels,bits=format.BitsPerSample,encoding=format.Encoding.ToString(),at=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()},bytes,token);}catch{}};audio.StartRecording();}catch{audio?.Dispose();audio=null;}
 }
 async Task SendPacket(byte kind,object metadata,byte[] payload,CancellationToken token)
 {
  var header=Encoding.UTF8.GetBytes(JsonSerializer.Serialize(metadata));var packet=new byte[5+header.Length+payload.Length];packet[0]=kind;BinaryPrimitives.WriteInt32LittleEndian(packet.AsSpan(1,4),header.Length);header.CopyTo(packet,5);payload.CopyTo(packet,5+header.Length);await send(packet,token);
 }
 public void Stop(){try{cts?.Cancel();}catch{}try{audio?.StopRecording();audio?.Dispose();}catch{}audio=null;cts?.Dispose();cts=null;}
 public void Dispose()=>Stop();
}

