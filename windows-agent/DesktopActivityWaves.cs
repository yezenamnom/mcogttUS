using System.Drawing.Drawing2D;
using System.Windows.Forms;

internal sealed class DesktopActivityWaves : IDisposable
{
 readonly List<WaveWindow> windows = new();
 readonly System.Windows.Forms.Timer timer = new() { Interval = 33 };
 DateTime untilUtc;
 public DesktopActivityWaves()
 {
  foreach(var screen in Screen.AllScreens){
   var window=new WaveWindow { Bounds=screen.Bounds };
   windows.Add(window);
  }
  timer.Tick+=(_,_)=>{
   var left=(untilUtc-DateTime.UtcNow).TotalMilliseconds;
   if(left<=0){timer.Stop();foreach(var window in windows)window.Hide();return;}
   foreach(var window in windows){window.Intensity=(float)Math.Min(1,left/360);window.Phase+=.11f;window.Invalidate();}
  };
 }
 public void Pulse()
 {
  untilUtc=DateTime.UtcNow.AddMilliseconds(1700);
  foreach(var window in windows){if(!window.Visible)window.Show();window.Intensity=1;window.Invalidate();}
  if(!timer.Enabled)timer.Start();
 }
 public void Dispose(){timer.Dispose();foreach(var window in windows)window.Dispose();}
 sealed class WaveWindow:Form
 {
  public float Phase{get;set;}
  public float Intensity{get;set;}=1;
  public WaveWindow()
  {
   FormBorderStyle=FormBorderStyle.None;ShowInTaskbar=false;TopMost=true;
   BackColor=Color.Magenta;TransparencyKey=Color.Magenta;
   DoubleBuffered=true;
  }
  protected override bool ShowWithoutActivation=>true;
  protected override CreateParams CreateParams{
   get{var p=base.CreateParams;p.ExStyle|=0x20|0x80|0x08000000;return p;}
  }
  protected override void WndProc(ref Message message){if(message.Msg==0x84){message.Result=(IntPtr)(-1);return;}base.WndProc(ref message);}
  protected override void OnPaint(PaintEventArgs e)
  {
   base.OnPaint(e);
   var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;
   var colors=new[]{Color.FromArgb(95,55,194,244),Color.FromArgb(80,91,132,247),Color.FromArgb(66,97,228,233)};
   for(var line=0;line<3;line++){
    using var pen=new Pen(Color.FromArgb((int)(colors[line].A*Intensity),colors[line]),2.5f);
    using var path=new GraphicsPath();
    var y=Height-23-line*10f;
    for(var x=0;x<=Width;x+=12){
     var point=new PointF(x,y+(float)Math.Sin(x/105f+Phase+line)*7);
     if(x==0)path.StartFigure();
     else path.AddLine(new PointF(x-12,y+(float)Math.Sin((x-12)/105f+Phase+line)*7),point);
    }
    g.DrawPath(pen,path);
   }
   using var edge=new Pen(Color.FromArgb((int)(60*Intensity),Color.CornflowerBlue),2);
   g.DrawRectangle(edge,1,1,Math.Max(1,Width-3),Math.Max(1,Height-3));
  }
 }
}
