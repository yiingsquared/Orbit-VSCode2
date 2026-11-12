using System;
using System.IO;
using Microsoft.Win32;

namespace OrbitDesktop
{
    internal static class ProtocolRegistration
    {
        private const string KeyPath = @"Software\Classes\orbit-companion";

        internal static string Command(string executable)
        {
            if (String.IsNullOrWhiteSpace(executable) || executable.IndexOf('"') >= 0) throw new ArgumentException("Invalid Orbit executable");
            return "\"" + Path.GetFullPath(executable) + "\" \"%1\"";
        }

        internal static bool Owned(string command, string registeredPath, string executable)
        {
            return String.Equals(command, Command(executable), StringComparison.OrdinalIgnoreCase)
                && String.Equals(registeredPath, Path.GetFullPath(executable), StringComparison.OrdinalIgnoreCase);
        }

        // Current Windows account only

        internal static void Register(string executable)
        {
            var fullPath = Path.GetFullPath(executable);
            using (var key = Registry.CurrentUser.CreateSubKey(KeyPath))
            {
                key.SetValue("", "URL:Orbit Companion");
                key.SetValue("URL Protocol", "");
                key.SetValue("OrbitInstallPath", fullPath);
                using (var icon = key.CreateSubKey("DefaultIcon")) icon.SetValue("", "\"" + fullPath + "\",0");
                using (var command = key.CreateSubKey(@"shell\open\command")) command.SetValue("", Command(fullPath));
            }
        }

        internal static void Unregister(string executable)
        {
            bool owned;
            using (var key = Registry.CurrentUser.OpenSubKey(KeyPath))
            using (var command = key == null ? null : key.OpenSubKey(@"shell\open\command"))
            {
                owned = key != null && command != null && Owned(command.GetValue("") as string, key.GetValue("OrbitInstallPath") as string, executable);
            }
            if (owned) Registry.CurrentUser.DeleteSubKeyTree(KeyPath, false);
        }
    }
}
