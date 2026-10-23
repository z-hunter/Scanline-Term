using System;
using System.Runtime.InteropServices;
using System.Text;

public static class HookProbeNative
{
    public const uint InputKeyboard = 1;
    public const uint KeyUp = 0x0002;
    public const uint ScanCode = 0x0008;
    public const uint ExtendedKey = 0x0001;
    public const uint Unicode = 0x0004;
    public const uint InputLanguageChangeRequest = 0x0050;

    [StructLayout(LayoutKind.Sequential)]
    public struct KeyboardInput
    {
        public ushort VirtualKey, ScanCode;
        public uint Flags, Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit, Size = 32)]
    public struct InputUnion
    {
        [FieldOffset(0)] public KeyboardInput Keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Input
    {
        public uint Type;
        public InputUnion Union;
    }

    public static Input MakeVirtualKeyInput(ushort virtualKey, bool up, UIntPtr marker)
    {
        var input = new Input { Type = InputKeyboard };
        input.Union.Keyboard = new KeyboardInput {
            VirtualKey = virtualKey, Flags = up ? KeyUp : 0, ExtraInfo = marker
        };
        return input;
    }

    public static Input MakeScanCodeInput(ushort scanCode, bool up, UIntPtr marker)
    {
        var input = new Input { Type = InputKeyboard };
        input.Union.Keyboard = new KeyboardInput {
            ScanCode = scanCode, Flags = ScanCode | (up ? KeyUp : 0), ExtraInfo = marker
        };
        return input;
    }

    public static Input MakeUnicodeInput(char value, bool up, UIntPtr marker)
    {
        var input = new Input { Type = InputKeyboard };
        input.Union.Keyboard = new KeyboardInput {
            ScanCode = value, Flags = Unicode | (up ? KeyUp : 0), ExtraInfo = marker
        };
        return input;
    }

    public static KeyboardInput ReadKeyboard(Input input) { return input.Union.Keyboard; }
    public static bool MatchesVirtualKey(Input input, ushort virtualKey, bool up, UIntPtr marker)
    {
        var key = input.Union.Keyboard;
        return input.Type == InputKeyboard && key.VirtualKey == virtualKey && key.ScanCode == 0 &&
            key.Flags == (up ? KeyUp : 0) && key.ExtraInfo == marker;
    }
    public static bool MatchesScanCode(Input input, ushort scanCode, bool up, UIntPtr marker)
    {
        var key = input.Union.Keyboard;
        return input.Type == InputKeyboard && key.VirtualKey == 0 && key.ScanCode == scanCode &&
            key.Flags == (ScanCode | (up ? KeyUp : 0)) && key.ExtraInfo == marker;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct GuiThreadInfo
    {
        public uint Size, Flags;
        public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        public Rect CaretRect;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct WinPoint { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct WinMessage
    {
        public IntPtr Window;
        public uint Message;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public WinPoint Point;
        public uint Private;
    }

    public sealed class FocusReport
    {
        public bool Success;
        public uint CallerThreadId, ForegroundThreadId, TargetThreadId;
        public IntPtr ForegroundBefore, ForegroundAfter, Target;
        public bool AttachedForeground, AttachedTarget;
        public int AttachForegroundError, AttachTargetError;
        public bool ShowWindowWasVisible, SetForegroundAccepted;
        public int FocusError, Attempts;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint count, Input[] inputs, int inputSize);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PeekMessageW(ref WinMessage message, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextW")]
    public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetGUIThreadInfo(uint threadId, ref GuiThreadInfo info);
    [DllImport("user32.dll")]
    public static extern bool IsChild(IntPtr parent, IntPtr child);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "PostMessageW", SetLastError = true)]
    public static extern bool PostMessage(IntPtr hwnd, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetClassNameW")]
    public static extern int GetClassName(IntPtr hwnd, StringBuilder className, int maxCount);
    [DllImport("user32.dll")]
    public static extern short GetKeyState(int virtualKey);
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int virtualKey);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetKeyboardLayout(uint threadId);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetKeyboardLayoutList(int count, [Out] IntPtr[] layouts);

    public static IntPtr[] GetInstalledKeyboardLayouts()
    {
        var layouts = new IntPtr[64];
        var count = GetKeyboardLayoutList(layouts.Length, layouts);
        if (count < 0 || count > layouts.Length) throw new InvalidOperationException("GetKeyboardLayoutList returned an invalid count");
        Array.Resize(ref layouts, count);
        return layouts;
    }
    public static bool PostInputLanguageChangeRequest(IntPtr hwnd, ulong hkl)
    {
        return PostMessage(hwnd, InputLanguageChangeRequest, UIntPtr.Zero, new IntPtr(unchecked((long)hkl)));
    }
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessageTimeoutW(IntPtr hwnd, uint message, UIntPtr wParam,
        IntPtr lParam, uint flags, uint timeout, out IntPtr result);

    // GetCurrentThreadId is exported by kernel32; using user32 silently breaks the focus-thread checks.
    [DllImport("kernel32.dll", ExactSpelling = true)]
    public static extern uint GetCurrentThreadId();

    public static FocusReport FocusOwnedWindow(IntPtr target)
    {
        var report = new FocusReport { Target = target, CallerThreadId = GetCurrentThreadId() };
        // AttachThreadInput fails for a thread without a message queue, so create it non-blockingly.
        var message = new WinMessage();
        PeekMessageW(ref message, IntPtr.Zero, 0, 0, 0);
        report.ForegroundBefore = GetForegroundWindow();
        var deadline = System.Diagnostics.Stopwatch.StartNew();
        do
        {
            report.Attempts++;
            var foreground = GetForegroundWindow();
            uint foregroundPid, targetPid;
            report.ForegroundThreadId = GetWindowThreadProcessId(foreground, out foregroundPid);
            report.TargetThreadId = GetWindowThreadProcessId(target, out targetPid);
            var attachedForeground = false;
            var attachedTarget = false;
            try
            {
                if (report.ForegroundThreadId != 0 && report.ForegroundThreadId != report.CallerThreadId)
                {
                    attachedForeground = AttachThreadInput(report.CallerThreadId, report.ForegroundThreadId, true);
                    if (!attachedForeground) report.AttachForegroundError = Marshal.GetLastWin32Error();
                }
                if (report.TargetThreadId != 0 && report.TargetThreadId != report.CallerThreadId && report.TargetThreadId != report.ForegroundThreadId)
                {
                    attachedTarget = AttachThreadInput(report.CallerThreadId, report.TargetThreadId, true);
                    if (!attachedTarget) report.AttachTargetError = Marshal.GetLastWin32Error();
                }
                report.AttachedForeground |= attachedForeground;
                report.AttachedTarget |= attachedTarget;
                report.ShowWindowWasVisible = ShowWindow(target, 9 /* SW_RESTORE */);
                report.SetForegroundAccepted = SetForegroundWindow(target);
            }
            finally
            {
                if (attachedTarget) AttachThreadInput(report.CallerThreadId, report.TargetThreadId, false);
                if (attachedForeground) AttachThreadInput(report.CallerThreadId, report.ForegroundThreadId, false);
            }
            // Let activation settle after detaching before considering the window safely focused.
            System.Threading.Thread.Sleep(80);
            report.ForegroundAfter = GetForegroundWindow();
            if (report.ForegroundAfter == target) { report.Success = true; break; }
            report.FocusError = Marshal.GetLastWin32Error();
            System.Threading.Thread.Sleep(80);
        }
        while (!report.Success && deadline.ElapsedMilliseconds < 2000);
        return report;
    }
    [DllImport("kernel32.dll", ExactSpelling = true)]
    public static extern IntPtr GetModuleHandleW([MarshalAs(UnmanagedType.LPWStr)] string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, ExactSpelling = true)]
    public static extern IntPtr GetProcAddress(IntPtr module, string name);

    public static string[] CheckBindings()
    {
        var failures = new System.Collections.Generic.List<string>();
        if (IntPtr.Size != 8) failures.Add("Requires 64-bit PowerShell");
        if (Marshal.SizeOf(typeof(KeyboardInput)) != 24) failures.Add("KEYBDINPUT must be 24 bytes on x64");
        if (Marshal.SizeOf(typeof(Input)) != 40) failures.Add("INPUT must be 40 bytes on x64");
        if (Marshal.SizeOf(typeof(GuiThreadInfo)) != 72) failures.Add("GUITHREADINFO must be 72 bytes on x64");
        if (Marshal.SizeOf(typeof(WinMessage)) != 48) failures.Add("MSG must be 48 bytes on x64");
        if (Marshal.OffsetOf(typeof(Input), "Union").ToInt32() != 8) failures.Add("INPUT union must begin at byte 8 on x64");
        if (Marshal.OffsetOf(typeof(KeyboardInput), "ScanCode").ToInt32() != 2 || Marshal.OffsetOf(typeof(KeyboardInput), "Flags").ToInt32() != 4 || Marshal.OffsetOf(typeof(KeyboardInput), "ExtraInfo").ToInt32() != 16) failures.Add("KEYBDINPUT field offsets do not match Win32");

        var user32 = GetModuleHandleW("user32.dll");
        var kernel32 = GetModuleHandleW("kernel32.dll");
        if (user32 == IntPtr.Zero || kernel32 == IntPtr.Zero) failures.Add("Could not locate user32/kernel32");
        else
        {
            foreach (var name in new[] { "SendInput", "SetForegroundWindow", "AttachThreadInput", "ShowWindow", "PeekMessageW", "GetForegroundWindow", "GetWindowTextW", "GetWindowThreadProcessId", "GetGUIThreadInfo", "IsChild", "GetAncestor", "GetClassNameW", "GetKeyState", "GetAsyncKeyState", "GetKeyboardLayout", "SendMessageTimeoutW" })
                if (GetProcAddress(user32, name) == IntPtr.Zero) failures.Add("Missing user32 export: " + name);
            if (GetProcAddress(kernel32, "GetCurrentThreadId") == IntPtr.Zero) failures.Add("Missing kernel32 export: GetCurrentThreadId");
        }

        if (FlagValues(InputKeyboard, KeyUp, ScanCode, ExtendedKey, Unicode) != "1,2,8,1,4")
            failures.Add("SendInput flag constants do not match Win32");
        if (new Input { Type = InputKeyboard, Union = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = 0x14, Flags = 0 } } }.Union.Keyboard.VirtualKey != 0x14)
            failures.Add("INPUT union did not preserve virtual-key data");
        var marker = new UIntPtr(0x535445524D434150UL);
        var down = MakeVirtualKeyInput(0x41, false, marker);
        var up = MakeVirtualKeyInput(0xFC, true, marker);
        var scanDown = MakeScanCodeInput(0x1E, false, marker);
        var scanUp = MakeScanCodeInput(0x1E, true, marker);
        if (!MatchesVirtualKey(down, 0x41, false, marker) || !MatchesVirtualKey(up, 0xFC, true, marker) ||
            !MatchesScanCode(scanDown, 0x1E, false, marker) || !MatchesScanCode(scanUp, 0x1E, true, marker))
            failures.Add("C#-constructed INPUT round-trip lost type, VK/scan code, flags, or marker");
        return failures.ToArray();
    }

    private static string FlagValues(uint input, uint keyUp, uint scan, uint extended, uint unicode)
    {
        return string.Join(",", input, keyUp, scan, extended, unicode);
    }

    public static uint SendVirtualKey(ushort virtualKey, bool up, UIntPtr marker)
    {
        var input = MakeVirtualKeyInput(virtualKey, up, marker);
        return SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Input)));
    }

    public static uint SendScanCode(ushort scanCode, bool up, UIntPtr marker)
    {
        var input = MakeScanCodeInput(scanCode, up, marker);
        return SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Input)));
    }
}
