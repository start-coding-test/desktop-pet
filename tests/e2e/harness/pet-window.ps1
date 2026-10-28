# tests/e2e/harness/pet-window.ps1 —— 从桌面侧操作宠物窗：读矩形/移窗/读点击穿透位/摆光标。
#
# 为什么需要「外部搬窗」而不是在页面里调 Tauri API：宠物窗的 capability（src-tauri/capabilities/pet.json）
# 里没有 core:window:allow-set-position，页面调 plugin:window|set_position 会被拒
# （"window.set_position not allowed. Permissions associated with this command: core:window:allow-set-position"）。
# 而 verify-pet-drag 要的正是「窗口真的动了」：外部 SetWindowPos 产生真 WM_MOVE →
# Tauri 的 tauri://move → 页面 getCurrentWindow().onMoved，与鼠标拖拽撞到的是同一条链路。
#
# 用法（由 tests/e2e/harness/pet-window.mjs 调；输出一律单行 JSON，纯 ASCII）：
#   pwsh -NoProfile -File pet-window.ps1 -Action info
#   pwsh -NoProfile -File pet-window.ps1 -Action move -Dx 10 -Steps 4 -DelayMs 40
#   pwsh -NoProfile -File pet-window.ps1 -Action cursor -X 1600 -Y 800
#   pwsh -NoProfile -File pet-window.ps1 -Action wait-transparent -ExpectTransparent 0 -TimeoutMs 4000
#
# 两个老坑（tools/win-zorder.ps1 里踩过，这里照抄规避）：
#   1. DllImport 默认 CharSet.Ansi，而 *W 函数写的是 UTF-16 —— 必须显式 CharSet.Unicode，
#      否则 GetWindowText 只拿到第一个字符，枚举「成功」却一个窗口都匹配不上。
#   2. 交给 EnumWindows 的委托必须有静态根，没有时它「返回 true 却一次都不回调」。
param(
  [ValidateSet("info", "rect", "move", "serve", "cursor", "wait-transparent")]
  [string]$Action = "info",
  [string]$Title = "DesktopPet",
  [int]$Dx = 0,
  [int]$Dy = 0,
  [int]$Steps = 1,
  [int]$DelayMs = 0,
  [int]$X = 0,
  [int]$Y = 0,
  # 1 = 期望「穿透开启」（WS_EX_TRANSPARENT 置位），0 = 期望「交互打开」
  [int]$ExpectTransparent = 1,
  [int]$TimeoutMs = 4000
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PetWindow {
  public delegate bool EnumProc(IntPtr h, IntPtr lp);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLengthW(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr h, int idx);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  // 静态根：委托一旦被 GC，EnumWindows 会「返回 true 却一次都不回调」
  static EnumProc rooted = OnWin;
  static IntPtr found = IntPtr.Zero;
  static string wantTitle = "";

  static bool OnWin(IntPtr h, IntPtr lp) {
    if (!IsWindowVisible(h)) return true;
    if (GetClassNameW(h, new StringBuilder(64), 64) < 0) return true;
    var cls = new StringBuilder(64);
    GetClassNameW(h, cls, 64);
    if (cls.ToString() != "Tauri Window") return true;
    int n = GetWindowTextLengthW(h);
    if (n <= 0) return true;
    var sb = new StringBuilder(n + 2);
    GetWindowTextW(h, sb, sb.Capacity);
    if (sb.ToString() != wantTitle) return true;
    found = h;
    return false; // 找到就停
  }

  public static IntPtr Find(string title) {
    found = IntPtr.Zero;
    wantTitle = title;
    EnumWindows(rooted, IntPtr.Zero);
    return found;
  }

  public static string RectJson(IntPtr h) {
    RECT r;
    if (!GetWindowRect(h, out r)) return "null";
    return "{\"left\":" + r.Left + ",\"top\":" + r.Top + ",\"width\":" + (r.Right - r.Left) + ",\"height\":" + (r.Bottom - r.Top) + "}";
  }

  public static string CursorJson() {
    POINT p;
    if (!GetCursorPos(out p)) return "null";
    return "{\"x\":" + p.X + ",\"y\":" + p.Y + "}";
  }

  public static int ExStyle(IntPtr h) { return GetWindowLongW(h, -20); }

  // 0x20 = WS_EX_TRANSPARENT：点击穿透开着时该位为 1（宿主 set_click_through 的可见结果）
  public static bool Transparent(IntPtr h) { return (ExStyle(h) & 0x20) != 0; }

  public static string InfoJson(IntPtr h) {
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    return "{\"ok\":true,\"hwnd\":" + h.ToInt64() + ",\"pid\":" + pid +
      ",\"class\":\"Tauri Window\",\"rect\":" + RectJson(h) +
      ",\"exStyle\":" + ExStyle(h) + ",\"transparent\":" + (Transparent(h) ? "true" : "false") +
      ",\"cursor\":" + CursorJson() + "}";
  }

  // SWP_NOSIZE(0x1) | SWP_NOZORDER(0x4) | SWP_NOACTIVATE(0x10)：只搬位置，不改尺寸/层级/焦点
  // 包一层：SetCursorPos 是 private DllImport，PowerShell 只能调 public 成员
  public static bool MoveCursorTo(int x, int y) { return SetCursorPos(x, y); }

  public static bool MoveBy(IntPtr h, int dx, int dy) {
    RECT r;
    if (!GetWindowRect(h, out r)) return false;
    return SetWindowPos(h, IntPtr.Zero, r.Left + dx, r.Top + dy, 0, 0, 0x1 | 0x4 | 0x10);
  }

  public static string WaitTransparentJson(IntPtr h, bool expect, int timeoutMs) {
    var sw = System.Diagnostics.Stopwatch.StartNew();
    while (true) {
      if (Transparent(h) == expect) {
        return "{\"ok\":true,\"matched\":true,\"elapsedMs\":" + sw.ElapsedMilliseconds +
          ",\"transparent\":" + (expect ? "true" : "false") + ",\"exStyle\":" + ExStyle(h) + "}";
      }
      if (sw.ElapsedMilliseconds >= timeoutMs) {
        return "{\"ok\":true,\"matched\":false,\"elapsedMs\":" + sw.ElapsedMilliseconds +
          ",\"transparent\":" + (Transparent(h) ? "true" : "false") + ",\"exStyle\":" + ExStyle(h) + "}";
      }
      System.Threading.Thread.Sleep(25);
    }
  }
}
"@

[PetWindow]::SetProcessDPIAware() | Out-Null

$h = [PetWindow]::Find($Title)
if ($h -eq [IntPtr]::Zero) {
  [Console]::Out.WriteLine('{"ok":false,"error":"pet-window-not-found","className":"Tauri Window","title":"' + $Title + '"}')
  exit 3
}

switch ($Action) {
  "info" { [Console]::Out.WriteLine([PetWindow]::InfoJson($h)) }
  "rect" { [Console]::Out.WriteLine('{"ok":true,"rect":' + [PetWindow]::RectJson($h) + '}') }
  "move" {
    $from = [PetWindow]::RectJson($h)
    for ($i = 1; $i -le $Steps; $i++) {
      if (-not [PetWindow]::MoveBy($h, $Dx, $Dy)) {
        [Console]::Out.WriteLine('{"ok":false,"error":"setwindowpos-failed"}')
        exit 4
      }
      if ($DelayMs -gt 0 -and $i -lt $Steps) { Start-Sleep -Milliseconds $DelayMs }
    }
    [Console]::Out.WriteLine('{"ok":true,"steps":' + $Steps + ',"from":' + $from + ',"to":' + [PetWindow]::RectJson($h) + '}')
  }
  # 常驻搬窗进程（verify-pet-drag 的「拖动态持续位移」用）：pwsh 单次启动 ~390ms，而拖动期
  # 静默兜底只有 250ms —— 每次起新进程搬一下会来不及；这里一次启动后靠 stdin/stdout 往返
  # （毫秒级）连搬。命令：`move <dx> <dy> <steps> <delayMs>`，`quit` 退出。
  "serve" {
    [Console]::Out.WriteLine('{"ok":true,"serve":true}')
    [Console]::Out.Flush()
    while ($true) {
      $line = [Console]::In.ReadLine()
      if ($null -eq $line) { break }
      $line = $line.Trim()
      if ($line -eq "") { continue }
      if ($line -eq "quit") { [Console]::Out.WriteLine('{"ok":true,"bye":true}'); break }
      $p = $line.Split(" ")
      if ($p.Count -ne 5 -or $p[0] -ne "move") {
        [Console]::Out.WriteLine('{"ok":false,"error":"bad-serving-command"}')
        continue
      }
      $mDx = [int]$p[1]
      $mDy = [int]$p[2]
      $mSteps = [int]$p[3]
      $mDelay = [int]$p[4]
      $failed = $false
      for ($i = 1; $i -le $mSteps; $i++) {
        if (-not [PetWindow]::MoveBy($h, $mDx, $mDy)) {
          [Console]::Out.WriteLine('{"ok":false,"error":"setwindowpos-failed"}')
          $failed = $true
          break
        }
        if ($mDelay -gt 0 -and $i -lt $mSteps) { Start-Sleep -Milliseconds $mDelay }
      }
      if (-not $failed) {
        [Console]::Out.WriteLine('{"ok":true,"steps":' + $mSteps + ',"to":' + [PetWindow]::RectJson($h) + '}')
      }
    }
  }
  "cursor" {
    [void][PetWindow]::MoveCursorTo($X, $Y)
    [Console]::Out.WriteLine('{"ok":true,"cursor":' + [PetWindow]::CursorJson() + '}')
  }
  "wait-transparent" {
    [Console]::Out.WriteLine([PetWindow]::WaitTransparentJson($h, ($ExpectTransparent -ne 0), $TimeoutMs))
  }
}
