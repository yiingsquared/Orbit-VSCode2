using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows;

namespace OrbitDesktop
{
    internal static class Native
    {
        internal const int GWL_EXSTYLE = -20;
        internal const int WS_EX_TOOLWINDOW = 0x80;
        internal const int WS_EX_NOACTIVATE = 0x08000000;
        internal const int WM_NCHITTEST = 0x0084;
        internal const int WM_MOUSEACTIVATE = 0x0021;

        [StructLayout(LayoutKind.Sequential)]
        internal struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        internal struct POINT { public int X, Y; }

        internal delegate bool EnumWindowProc(IntPtr handle, IntPtr parameter);

        [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] internal static extern bool GetWindowRect(IntPtr handle, out RECT rect);
        [DllImport("user32.dll")] internal static extern bool GetCursorPos(out POINT point);
        [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr handle);
        [DllImport("user32.dll")] internal static extern bool IsIconic(IntPtr handle);
        [DllImport("user32.dll")] internal static extern bool IsWindow(IntPtr handle);
        [DllImport("user32.dll")] internal static extern bool EnumWindows(EnumWindowProc callback, IntPtr parameter);
        [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetWindowText(IntPtr handle, StringBuilder text, int maximum);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetClassName(IntPtr handle, StringBuilder text, int maximum);
        [DllImport("user32.dll")] internal static extern int GetWindowLong(IntPtr handle, int index);
        [DllImport("user32.dll")] internal static extern int SetWindowLong(IntPtr handle, int index, int value);
        [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(IntPtr handle);
        [DllImport("user32.dll")] internal static extern bool SetProcessDPIAware();

        internal static string Title(IntPtr handle)
        {
            var value = new StringBuilder(512);
            GetWindowText(handle, value, value.Capacity);
            return value.ToString();
        }

        internal static string ProcessName(IntPtr handle)
        {
            uint id;
            GetWindowThreadProcessId(handle, out id);

            try { return Process.GetProcessById((int)id).ProcessName; }
            catch { return "Unknown app"; }
        }

        internal static bool IsOurs(IntPtr handle)
        {
            uint id;
            GetWindowThreadProcessId(handle, out id);
            return id == Process.GetCurrentProcess().Id;
        }

        internal static bool IsBrowser(IntPtr handle)
        {
            var name = ProcessName(handle).ToLowerInvariant();
            return name == "chrome" || name == "msedge" || name == "firefox" || name == "brave" || name == "opera" || name == "vivaldi";
        }

        internal static bool CoveredAt(IntPtr host, POINT contact)
        {
            bool covered = false;

            EnumWindows(delegate(IntPtr window, IntPtr ignored)
            {
                if (window == host) return false;
                if (IsOurs(window) || !IsWindowVisible(window) || IsIconic(window)) return true;

                RECT rect;
                if (!GetWindowRect(window, out rect)) return true;

                if (Contains(rect, contact)) { covered = true; return false; }
                return true;
            }, IntPtr.Zero);

            return covered;
        }

        internal static bool Contains(RECT rect, POINT point)
        {
            return point.X >= rect.Left && point.X < rect.Right && point.Y >= rect.Top && point.Y < rect.Bottom;
        }

        internal static IntPtr WindowUnder(POINT point)
        {
            IntPtr result = IntPtr.Zero;

            EnumWindows(delegate(IntPtr handle, IntPtr unused)
            {
                if (!IsWindowVisible(handle) || IsIconic(handle) || IsOurs(handle)) return true;

                RECT rect;
                if (!GetWindowRect(handle, out rect) || rect.Right - rect.Left < 120 || rect.Bottom - rect.Top < 80) return true;
                if (point.X < rect.Left || point.X > rect.Right || point.Y < rect.Top || point.Y > rect.Bottom) return true;

                var className = new StringBuilder(80);
                GetClassName(handle, className, className.Capacity);

                if (className.ToString() == "Progman" || className.ToString() == "WorkerW" || className.ToString() == "Shell_TrayWnd") return true;
                if (String.IsNullOrWhiteSpace(Title(handle))) return true;

                result = handle;
                return false;
            }, IntPtr.Zero);

            return result;
        }
    }
}
