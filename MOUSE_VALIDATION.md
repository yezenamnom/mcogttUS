# Mouse implementation and validation

Desktop movement now uses checked SendInput calls and virtual-desktop coordinates.
Targets outside connected monitors are rejected. Movement checks the final cursor
position with a one-pixel tolerance. MouseUpdateHz defaults to 240 and is clamped
to 30–240. This is an input scheduling target, not a guaranteed display frame rate.
Timer resolution is requested for each move and restored in finally.

INPUT includes the mouse union member so its native layout also matches keyboard
input. Desktop paths release their held button in finally. ZIP and directory
copy commands now enforce file-write permission. Horizontal wheel input is exposed.

Browser mouse_action uses CDP with explicit button masks and double-click counts.
It reports dispatch rather than verified UI success. CDP does not move the physical
Windows cursor. Browser/desktop coordinate synchronization remains outstanding.

Verified on 2026-10-01:
- Debug build: no errors or warnings.
- Self-contained Windows x64 publish succeeded.
- Five mocked CDP sequence/error tests passed.
- New Windows agent connected to Railway; cursor read works.
- Actual mouse movement reached (900,499) for target (900,500).
- The 240-target build reached (1105,479) for target (1105,480).
- Physical left click opened the agent Activity tab, confirmed by screenshot.
- Physical right click opened the Bridge URL edit context menu, confirmed by screenshot.

Additional live verification:
- Combined desktop move/click: 44 movement updates, 233.514 ms total
  (180 ms requested movement plus click and verification). Activity tab opened.
- Combined drag: 90 updates, 459.5796 ms total; agent window visibly moved.
- Installed Comet extension updated in place to 0.9.0 with a backup retained.
- Live CDP click closed and reopened GitHub Code; Download ZIP appeared.
- Six tests passed, including a real local MCP/WebSocket routing integration test.

Fast workflow: use desktop_mouse_action (physical screen coordinates) or
control_mouse with desktop backend for one move-and-click call, including browser
chrome and Explorer. Use browser backend for CSS viewport coordinates through CDP.
No screenshot is required between moving and clicking; capture after a meaningful
action when its UI result needs verification. screenshotAfter on desktop_mouse_action
returns an image directly to MCP and does not upload it to a screenshot sharing host.

Remaining acceptance work: Explorer ZIP extraction, file copy/paste by GUI, actual
display refresh-rate measurement. 240 is the input scheduling target; total command
time includes click, verification and network latency. DOM/CDP coordinates must not
be used as physical screen coordinates without an explicit mapping.
Running test build: windows-agent/bin/integrated-090/ChatGPTDesktopBridge.exe.
