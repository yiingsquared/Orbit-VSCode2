using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Win32;

namespace OrbitInstaller
{
    internal static class Setup
    {
        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length == 2 && args[0] == "--extract-test")
            {
                try
                {
                    var target = Path.GetFullPath(args[1]);
                    Directory.CreateDirectory(target);
                    if (File.Exists(Path.Combine(target, "Orbit.exe")) || File.Exists(Path.Combine(target, "Uninstall.exe"))) return 2;

                    SetupForm.Extract("OrbitPayload", Path.Combine(target, "Orbit.exe"));
                    SetupForm.Extract("OrbitUninstaller", Path.Combine(target, "Uninstall.exe"));
                    return 0;
                }
                catch { return 1; }
            }

            Application.EnableVisualStyles();
            Application.Run(new SetupForm());
            return 0;
        }
    }

    internal sealed class SetupForm : Form
    {
        private readonly Label status = new Label();
        private readonly Button install = new Button();
        private readonly CheckBox launch = new CheckBox();
        private bool installed;

        internal SetupForm()
        {
            Text = "Install Orbit Companion";
            ClientSize = new Size(450, 290);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.White;
            Font = new Font("Segoe UI", 9);

            var title = new Label { Text = "A little closer to your work", AutoSize = false, Location = new Point(29, 26), Size = new Size(390, 40), Font = new Font("Segoe UI", 18, FontStyle.Bold) };
            var description = new Label { Text = "Install the floating Orbit cat for this Windows account.\nNo administrator access or automatic startup is required.", AutoSize = false, Location = new Point(31, 82), Size = new Size(385, 47), ForeColor = Color.Gray };
            launch.Text = "Launch Orbit after setup";
            launch.Checked = true;
            launch.AutoSize = true;
            launch.Location = new Point(32, 149);
            status.AutoSize = false;
            status.Location = new Point(31, 186);
            status.Size = new Size(385, 30);
            status.ForeColor = Color.Gray;
            install.Text = "Install Orbit";
            install.Location = new Point(31, 229);
            install.Size = new Size(385, 37);
            install.BackColor = Color.FromArgb(255, 61, 78);
            install.ForeColor = Color.White;
            install.FlatStyle = FlatStyle.Flat;
            install.FlatAppearance.BorderSize = 0;
            install.Click += Install;
            Controls.AddRange(new Control[] { title, description, launch, status, install });
        }

        private void Install(object sender, EventArgs args)
        {
            if (installed) { Close(); return; }
            install.Enabled = false;

            try
            {
                var directory = Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Orbit"));
                var expected = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Orbit");

                if (!String.Equals(directory, Path.GetFullPath(expected), StringComparison.OrdinalIgnoreCase)) throw new IOException("Invalid installation folder");
                if (Directory.Exists(directory) && (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new IOException("The installation folder must not be a link");

                Directory.CreateDirectory(directory);
                Extract("OrbitPayload", Path.Combine(directory, "Orbit.exe"));
                Extract("OrbitUninstaller", Path.Combine(directory, "Uninstall.exe"));
                var grant = OrbitDesktop.InstallBootstrap.ReadExecutable(Assembly.GetExecutingAssembly().Location);
                if (grant != null) OrbitDesktop.InstallBootstrap.Save(OrbitDesktop.InstallBootstrap.DefaultGrantPath, grant);
                CreateShortcut(directory);

                using (var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\OrbitCompanion"))
                {
                    key.SetValue("DisplayName", "Orbit Companion");
                    key.SetValue("DisplayVersion", "1.0.5");
                    key.SetValue("Publisher", "Orbit");
                    key.SetValue("InstallLocation", directory);
                    key.SetValue("DisplayIcon", Path.Combine(directory, "Orbit.exe"));
                    key.SetValue("UninstallString", "\"" + Path.Combine(directory, "Uninstall.exe") + "\"");
                    key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                }

                installed = true;
                status.Text = "Installed · Orbit connects automatically when launched";
                install.Text = "Done";
                launch.Enabled = false;

                if (launch.Checked) Process.Start(new ProcessStartInfo(Path.Combine(directory, "Orbit.exe")) { UseShellExecute = true });
            }
            catch (IOException)
            {
                status.Text = "Close Orbit before installing or updating, then try again";
            }
            catch (Exception error)
            {
                status.Text = "Setup could not finish: " + error.Message;
            }
            finally { install.Enabled = true; }
        }

        internal static void Extract(string resource, string target)
        {
            using (var input = Assembly.GetExecutingAssembly().GetManifestResourceStream(resource))
            using (var output = File.Create(target))
            {
                if (input == null) throw new IOException("The installer payload is missing");
                input.CopyTo(output);
            }
        }

        private static void CreateShortcut(string directory)
        {
            var shortcutDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Orbit");
            Directory.CreateDirectory(shortcutDirectory);
            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            var shell = Activator.CreateInstance(shellType);
            var shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { Path.Combine(shortcutDirectory, "Orbit.lnk") });
            var shortcutType = shortcut.GetType();
            shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { Path.Combine(directory, "Orbit.exe") });
            shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { directory });
            shortcutType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { "Orbit floating desktop companion" });
            shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
        }
    }
}
