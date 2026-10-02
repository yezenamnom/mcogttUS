using System.Drawing;
using System.Runtime.InteropServices;

internal static partial class Program
{
 [StructLayout(LayoutKind.Sequential)] struct CaptureCursorInfo { public int size,flags; public IntPtr handle; public POINT position; }
 [StructLayout(LayoutKind.Sequential)] struct CaptureIconInfo { public bool icon; public uint hotspotX,hotspotY; public IntPtr mask,color; }
 [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CaptureCursorInfo info);
 [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon,out CaptureIconInfo info);
 [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr dc,int x,int y,IntPtr icon,int width,int height,uint step,IntPtr brush,uint flags);
 [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr handle);
 static void DrawCaptureCursor(Graphics graphics,Rectangle bounds)
 {
  var cursor=new CaptureCursorInfo {size=Marshal.SizeOf<CaptureCursorInfo>()};
  if(!GetCursorInfo(ref cursor)||(cursor.flags&1)==0||!bounds.Contains(cursor.position.X,cursor.position.Y))return;
  using(var outline=new Pen(Color.Black,4))graphics.DrawEllipse(outline,cursor.position.X-bounds.Left-12,cursor.position.Y-bounds.Top-12,24,24);
  using(var outline=new Pen(Color.Cyan,2))graphics.DrawEllipse(outline,cursor.position.X-bounds.Left-12,cursor.position.Y-bounds.Top-12,24,24);
  if(!GetIconInfo(cursor.handle,out var icon))return;
  try {
   var dc=graphics.GetHdc();
   try {DrawIconEx(dc,cursor.position.X-bounds.Left-(int)icon.hotspotX,cursor.position.Y-bounds.Top-(int)icon.hotspotY,cursor.handle,0,0,0,IntPtr.Zero,3);}
   finally {graphics.ReleaseHdc(dc);}
  }finally {if(icon.mask!=IntPtr.Zero)DeleteObject(icon.mask);if(icon.color!=IntPtr.Zero)DeleteObject(icon.color);}
 }
}
