using System;
using System.IO;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace OrbitDesktop
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length > 0 && args[0] == "--self-test") return SelfTest(args);
            if ((args.Length == 1 || args.Length == 3) && args[0] == "--qa-interaction") return InteractionQa(args);
            if (args.Length == 1 && args[0] == "--qa-window") return QaWindow.Run();
            if (args.Length == 1 && args[0] == "--qa-window-no-backdrop") return QaWindow.Run(false);
            if (args.Length == 4 && args[0] == "--bridge-test") return BridgeTest(args);
            if (args.Length == 2 && args[0] == "--render-launch-preview")
            {
                var renderer = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
                using (var client = new BridgeClient(false)) new PetWindow(client, true).RenderLaunchFrames(args[1]);
                return 0;
            }
            if (args.Length == 2 && args[0] == "--render-preview")
            {
                var renderer = new Application();
                renderer.ShutdownMode = ShutdownMode.OnExplicitShutdown;
                using (var client = new BridgeClient(false)) new PetWindow(client, true).RenderPreview(args[1]);
                return 0;
            }

            bool first;
            using (var mutex = new Mutex(true, "Local\\OrbitCompanion.Desktop.v1", out first))
            {
                if (!first) return 0;

                Native.SetProcessDPIAware();
                var application = new Application();
                application.ShutdownMode = ShutdownMode.OnExplicitShutdown;

                bool preview = args.Length > 0 && args[0] == "--preview";
                using (var bridge = new BridgeClient(!preview))
                {
                    if (!preview)
                    {
                        try { bridge.ActivateInstall().GetAwaiter().GetResult(); }
                        catch { /* Retry when Orbit is available */ }
                    }

                    var pet = new PetWindow(bridge, preview);
                    application.MainWindow = pet;
                    application.ShutdownMode = ShutdownMode.OnMainWindowClose;
                    application.Run(pet);
                }

                mutex.ReleaseMutex();
            }

            return 0;
        }

        private static int SelfTest(string[] args)
        {
            string address;
            bool valid = BridgeClient.TryPairAddress("4311-12345678", out address) && address == "http://127.0.0.1:4311"
                && BridgeClient.TryPairAddress("4320-00000001", out address)
                && !BridgeClient.TryPairAddress("4311-1234567", out address)
                && !BridgeClient.TryPairAddress("http://evil.test", out address)
                && !BridgeClient.TryPairAddress("9999-12345678", out address)
                && ContextReader.Clean("\0 cat \0") == "cat"
                && ContextReader.Clean(new string('x', 20000)).Length == ContextReader.TextLimit
                && !ContextReader.RefreshRequired(false, true, TimeSpan.FromSeconds(3))
                && ContextReader.RefreshRequired(false, true, TimeSpan.FromSeconds(4))
                && ContextReader.RefreshRequired(true, true, TimeSpan.Zero)
                && ContextReader.RefreshRequired(false, false, TimeSpan.Zero)
                && ControlChecks()
                && HoverChecks()
                && VisibilityChecks()
                && HomePullChecks()
                && BootstrapChecks()
                && AttachmentChecks();

            if (args.Length > 1) File.WriteAllText(args[1], valid ? "PASS: fixed home, elastic release and return, latched detachment, immediate hover, exact cat silhouette, hidden-window recovery, protected installation, context heartbeat, focus, send guard, draft recovery, occlusion, and website controls" : "FAIL");
            return valid ? 0 : 1;
        }

        private static bool HoverChecks()
        {
            return AttachmentPolicy.HoverReady(true, true)
                && !AttachmentPolicy.HoverReady(false, true)
                && !AttachmentPolicy.HoverReady(true, false)
                && PetWindow.HitCat(new Point(0, 0), new Point(0, 0), 29, 0, 1)
                && !PetWindow.HitCat(new Point(20, 0), new Point(0, 0), 29, 0, 1)
                && !PetWindow.HitCat(new Point(-30, -24), new Point(0, 0), 64, 0, 1);
        }

        private static bool HomePullChecks()
        {
            var pull = new HomePull { Anchor = new Point(400, 22) };
            if (!pull.Parked || !pull.Hit(pull.Anchor) || pull.Hit(new Point(430, 22))) return false;
            pull.Begin(true);
            if (pull.Stretch(new Vector(0, 120)) || !pull.ReturnOnDrop(new Point(430, 100))) return false;
            if (!pull.Stretch(new Vector(0, 181)) || !pull.Detached || pull.ReturnOnDrop(new Point(430, 100))) return false;
            if (pull.Stretch(new Vector(0, 20)) || !pull.Detached) return false;
            var recoil = pull.Recoil.Length;
            pull.Tick();
            if (pull.Recoil.Length >= recoil || !pull.ReturnOnDrop(pull.Anchor)) return false;
            if (pull.Anchor != new Point(400, 22)) return false;
            pull.Park();
            if (!pull.Parked || pull.Detached || pull.Returning || pull.FromHome) return false;
            pull.Begin(false);
            return !pull.ReturnOnDrop(new Point(500, 300)) && !pull.Stretch(new Vector(20, 20));
        }

        private static bool VisibilityChecks()
        {
            return AttachmentPolicy.CanRestoreAttachment(true, true, true, false, 100, 100)
                && !AttachmentPolicy.CanRestoreAttachment(true, false, false, false, 100, 0)
                && !AttachmentPolicy.CanRestoreAttachment(true, true, true, false, 100, 200)
                && !AttachmentPolicy.CanRestoreAttachment(true, true, true, true, 100, 100)
                && !AttachmentPolicy.CanRestoreAttachment(true, true, false, false, 100, 100)
                && !AttachmentPolicy.CanRestoreAttachment(false, true, true, false, 100, 100);
        }

        private static bool BootstrapChecks()
        {
            var file = Path.Combine(Path.GetTempPath(), "orbit-install-check-" + Guid.NewGuid().ToString("N"));
            var protectedFile = file + ".bootstrap";
            var grant = new System.Collections.Generic.Dictionary<string, object> { { "baseUrl", "http://127.0.0.1:4316" }, { "ticket", new string('a', 43) } };
            try
            {
                var data = System.Text.Encoding.UTF8.GetBytes(new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(grant));
                using (var writer = new BinaryWriter(File.Create(file)))
                {
                    writer.Write(System.Text.Encoding.ASCII.GetBytes("MZ synthetic fixture"));
                    writer.Write(data);
                    writer.Write((uint)data.Length);
                    writer.Write(System.Text.Encoding.ASCII.GetBytes(InstallBootstrap.Marker));
                }
                if (InstallBootstrap.ReadExecutable(file) == null) return false;
                InstallBootstrap.Save(protectedFile, grant);
                if (System.Text.Encoding.UTF8.GetString(File.ReadAllBytes(protectedFile)).Contains(new string('a', 43))) return false;
                if (BridgeClient.Text(InstallBootstrap.Load(protectedFile), "ticket") != new string('a', 43)) return false;
                File.AppendAllText(file, "invalid footer");
                if (InstallBootstrap.ReadExecutable(file) != null) return false;
                return !InstallBootstrap.ValidAddress("http://example.com:4316")
                    && !InstallBootstrap.ValidAddress("http://127.0.0.1:4316/private")
                    && !InstallBootstrap.ValidAddress("http://127.0.0.1:4316?ticket=bad");
            }
            catch { return false; }
            finally
            {
                if (File.Exists(file)) File.Delete(file);
                if (File.Exists(protectedFile)) File.Delete(protectedFile);
            }
        }

        private static bool ControlChecks()
        {
            var state = new System.Collections.Generic.Dictionary<string, object> { { "paired", false }, { "command", "quit" } };
            if (BridgeClient.Control(state) != "quit") return false;
            state["command"] = "disconnect";
            if (BridgeClient.Control(state) != "disconnect") return false;
            state["command"] = "unknown";
            if (BridgeClient.Control(state) != null) return false;
            state["command"] = "quit";
            state["paired"] = true;
            if (BridgeClient.Control(state) != null) return false;

            var path = Path.Combine(Path.GetTempPath(), "orbit-control-check-" + Guid.NewGuid().ToString("N") + ".json");
            try
            {
                File.WriteAllText(path, "Synthetic isolated configuration");
                using (var client = new BridgeClient(false, path))
                {
                    client.Forget();
                    return !client.Configured && !File.Exists(path);
                }
            }
            finally { if (File.Exists(path)) File.Delete(path); }
        }

        private static bool AttachmentChecks()
        {
            var visibleDuringInteraction = !AttachmentPolicy.HideCovered(true, true, true, false, false)
                && !AttachmentPolicy.HideCovered(true, true, false, true, false)
                && !AttachmentPolicy.HideCovered(true, true, false, false, true);
            var occlusion = AttachmentPolicy.HideCovered(true, true, false, false, false)
                && !AttachmentPolicy.HideCovered(true, false, false, false, false)
                && !AttachmentPolicy.HideCovered(false, true, false, false, false);
            var send = AttachmentPolicy.CanSend(false, "A real message")
                && !AttachmentPolicy.CanSend(false, "  ")
                && !AttachmentPolicy.CanSend(true, "A real message");
            var recover = AttachmentPolicy.RestoreDraft("", "Unsent message") == "Unsent message"
                && AttachmentPolicy.RestoreDraft("New draft", "Unsent message") == "New draft";
            var focusedExpansion = AttachmentPolicy.ExpansionOnOpen(true, 0);
            var nextFocusedFrame = focusedExpansion + (1 - focusedExpansion) * 0.2;
            var inputFocus = focusedExpansion > 0.75 && nextFocusedFrame > 0.75
                && AttachmentPolicy.ExpansionOnOpen(false, 0.2) == 0.2;
            return visibleDuringInteraction && occlusion && send && recover && inputFocus;
        }

        private static int InteractionQa(string[] args)
        {
            var network = args.Length == 3;
            var config = network ? Path.GetFullPath(args[2]) : Path.Combine(Path.GetTempPath(), "orbit-unused-qa-config.json");
            if (String.Equals(config, Path.GetFullPath(BridgeClient.ConfigPath), StringComparison.OrdinalIgnoreCase)) return 2;

            using (var client = new BridgeClient(false, config))
            {
                try { if (network) client.Pair(args[1]).GetAwaiter().GetResult(); }
                catch (Exception issue) { MessageBox.Show(issue.Message, "Orbit QA pairing"); return 1; }

                return InteractionQaWindow.Run(client, network, config + ".qa.log");
            }
        }

        private static int BridgeTest(string[] args)
        {
            try
            {
                using (var client = new BridgeClient(false, args[3]))
                {
                    client.Pair(args[1]).GetAwaiter().GetResult();
                    var state = client.Request("/api/companion/state").GetAwaiter().GetResult();
                    if (!BridgeClient.Flag(state, "paired")) throw new Exception("State did not confirm pairing");

                    var captured = client.Request("/api/companion/context", new { source = "desktop", app = "fixture", windowTitle = "Native bridge fixture", text = "Current-window fixture", capturedAt = DateTime.UtcNow.ToString("o") }).GetAwaiter().GetResult();
                    if (!BridgeClient.Flag(captured, "stored")) throw new Exception("Context was not received");

                    var sent = client.Request("/api/companion/message", new { text = "Native bridge fixture message" }).GetAwaiter().GetResult();
                    if (!BridgeClient.Flag(sent, "ok")) throw new Exception("Message was not received");
                }

                using (var reloaded = new BridgeClient(true, args[3]))
                {
                    if (!reloaded.Configured || !BridgeClient.Flag(reloaded.Request("/api/companion/state").GetAwaiter().GetResult(), "paired")) throw new Exception("Protected pairing did not reload");
                }

                File.WriteAllText(args[2], "PASS: native pairing, authorization, context, message, and protected config reload");
                return 0;
            }
            catch (Exception error)
            {
                File.WriteAllText(args[2], "FAIL: " + error.GetType().Name + " " + error.Message);
                return 1;
            }
        }
    }
}
