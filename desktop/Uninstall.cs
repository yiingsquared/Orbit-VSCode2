using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
using Microsoft.Win32;

namespace OrbitInstaller
{
    internal static class Uninstall
    {
        [STAThread]
        private static void Main(string[] args)
        {
            var directory = Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Orbit"));
            var executable = System.Reflection.Assembly.GetExecutingAssembly().Location;

            if (args.Length == 0)
            {
                if (MessageBox.Show("Remove Orbit Companion from this Windows account? Your Orbit website chats and memory will stay saved.", "Uninstall Orbit", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;

                var helper = Path.Combine(Path.GetTempPath(), "Orbit-Uninstall-" + Guid.NewGuid().ToString("N") + ".exe");
                File.Copy(executable, helper);
                Process.Start(new ProcessStartInfo(helper, "--cleanup") { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden });
                return;
            }

            if (args.Length != 1 || args[0] != "--cleanup") return;

            try
            {
                foreach (var process in Process.GetProcessesByName("Orbit"))
                {
                    try
                    {
                        if (String.Equals(Path.GetFullPath(process.MainModule.FileName), Path.Combine(directory, "Orbit.exe"), StringComparison.OrdinalIgnoreCase))
                        {
                            process.CloseMainWindow();
                            process.WaitForExit(2000);
                        }
                    }
                    catch { }
                }

                var expected = Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Orbit"));
                if (!String.Equals(directory, expected, StringComparison.OrdinalIgnoreCase)) throw new IOException("Invalid uninstall folder");
                if (Directory.Exists(directory) && (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new IOException("The installation folder must not be a link");
                if (Directory.Exists(directory)) Directory.Delete(directory, true);

                var shortcutDirectory = Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Orbit"));
                var shortcut = Path.Combine(shortcutDirectory, "Orbit.lnk");
                if (File.Exists(shortcut)) File.Delete(shortcut);
                if (Directory.Exists(shortcutDirectory) && Directory.GetFileSystemEntries(shortcutDirectory).Length == 0) Directory.Delete(shortcutDirectory);
                Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\OrbitCompanion", false);
                MessageBox.Show("Orbit Companion was removed", "Orbit", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch
            {
                MessageBox.Show("Close the Orbit cat from its right-click menu, then run uninstall again", "Orbit", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }
    }
}
