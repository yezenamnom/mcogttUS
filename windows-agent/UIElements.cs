using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Automation;

internal static partial class Program
{
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();

    static object ReadUIElements(JsonElement args)
    {
        var handle = Has(args,"hwnd") ? new IntPtr(args.GetProperty("hwnd").GetInt64()) : Has(args, "pid") ? Process.GetProcessById(I(args, "pid")).MainWindowHandle : SelectedWindow!=IntPtr.Zero ? TargetWindow() : GetForegroundWindow();
        if (handle == IntPtr.Zero) throw new InvalidOperationException("No target window");
        var root = AutomationElement.FromHandle(handle);
        var walker = TreeWalker.ControlViewWalker;
        var queue = new Queue<AutomationElement>(); queue.Enqueue(root);
        var elements = new List<object>();
        var limit = Math.Clamp(I(args, "limit", 150), 1, 500);
        var clock = Stopwatch.StartNew();
        while (queue.Count > 0 && elements.Count < limit && clock.ElapsedMilliseconds < 3000)
        {
            var element = queue.Dequeue();
            try
            {
                var current = element.Current;
                var rect = current.BoundingRectangle;
                elements.Add(new { name = current.Name, automationId = current.AutomationId,
                    role = current.ControlType.ProgrammaticName, enabled = current.IsEnabled,
                    offscreen = current.IsOffscreen, focused = current.HasKeyboardFocus,
                    bounds = rect.IsEmpty ? null : new { x = rect.X, y = rect.Y, width = rect.Width, height = rect.Height } });
                var child = walker.GetFirstChild(element);
                while (child != null && queue.Count + elements.Count < limit && clock.ElapsedMilliseconds < 3000)
                { queue.Enqueue(child); child = walker.GetNextSibling(child); }
            }
            catch (ElementNotAvailableException) { }
        }
        return new { observedAt = DateTimeOffset.UtcNow, handle = handle.ToInt64(),
            elements, truncated = queue.Count > 0 || elements.Count >= limit, source = "Windows UI Automation" };
    }
}
