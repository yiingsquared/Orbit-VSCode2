using System;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;

namespace OrbitDesktop
{
    internal static class InteractionQaWindow
    {
        internal static int Run(BridgeClient bridge, bool network, string logPath)
        {
            Native.SetProcessDPIAware();
            var application = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
            Action<string> log = delegate(string value)
            {
                try { File.AppendAllText(logPath, DateTime.UtcNow.ToString("o") + " " + value + Environment.NewLine); }
                catch { }
            };
            log("QA started");
            application.DispatcherUnhandledException += delegate(object sender, DispatcherUnhandledExceptionEventArgs args) { log("Unhandled " + args.Exception.ToString()); };
            application.Exit += delegate(object sender, ExitEventArgs args) { log("Application exit " + args.ApplicationExitCode); };
            AppDomain.CurrentDomain.ProcessExit += delegate { log("Process exit"); };

            var host = new Window {
                Title = "Orbit synthetic interaction host", Width = 880, Height = 520,
                Left = Math.Max(40, SystemParameters.WorkArea.Left + 80),
                Top = Math.Max(80, SystemParameters.WorkArea.Top + 110),
                Background = Brushes.White, FontFamily = new FontFamily("Segoe UI"), FontSize = 13
            };
            var layout = new StackPanel { Margin = new Thickness(28) };
            var status = new TextBlock { Text = "Waiting for the QA cat", TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 22, 0, 16), Foreground = Brushes.Gray, FontSize = 12 };
            layout.Children.Add(new TextBlock { Text = "Synthetic native interaction test", FontSize = 25, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 18) });
            layout.Children.Add(new TextBlock {
                Text = network ? "This isolated QA cat sends through the real localhost bridge. Only fixed synthetic context is sent; no private windows or saved pairing configuration are read."
                    : "This isolated QA cat coexists with the installed cat. No pairing configuration, private windows, UI Automation, or network requests are used.",
                TextWrapping = TextWrapping.Wrap, Foreground = Brushes.Gray, LineHeight = 23
            });
            layout.Children.Add(status);
            var actions = new WrapPanel { Margin = new Thickness(0, 8, 0, 22) };
            var focus = new Button { Content = "Open cat input", Padding = new Thickness(14, 8, 14, 8), Margin = new Thickness(0, 0, 10, 0) };
            var coverButton = new Button { Content = "Cover host top edge", Padding = new Thickness(14, 8, 14, 8), Margin = new Thickness(0, 0, 10, 0) };
            var close = new Button { Content = "Exit interaction QA", Padding = new Thickness(14, 8, 14, 8) };
            actions.Children.Add(focus);
            actions.Children.Add(coverButton);
            actions.Children.Add(close);
            layout.Children.Add(actions);
            layout.Children.Add(new TextBox { Text = "Synthetic QA current-window content only", IsReadOnly = true, MinHeight = 140, Padding = new Thickness(16), Background = new SolidColorBrush(Color.FromRgb(248, 248, 251)), BorderBrush = Brushes.LightGray });
            host.Content = layout;
            host.Show();
            var pet = new PetWindow(bridge, true, new WindowInteropHelper(host).Handle, network);
            Window cover = null;
            pet.QaDiagnostic = delegate(string value) { status.Text = value; log(value); };
            pet.QaCoverWindow = delegate { return cover != null && cover.IsVisible ? new WindowInteropHelper(cover).Handle : IntPtr.Zero; };
            focus.Click += delegate { pet.FocusForQa(); };
            coverButton.Click += delegate
            {
                if (cover != null) { cover.Activate(); return; }

                cover = new Window { Title = "Orbit synthetic cover", Owner = host, Width = 660, Height = 200, Left = host.Left + 110, Top = host.Top - 55, Background = Brushes.LightGray };
                cover.Content = new TextBlock { Text = "Synthetic covering window\n\nThe attached cat should be hidden while this window covers its attachment point.", Margin = new Thickness(24), TextWrapping = TextWrapping.Wrap, FontSize = 14 };
                cover.Closed += delegate { cover = null; };
                cover.Show();
            };
            close.Click += delegate { log("Exit button"); application.Shutdown(); };
            host.Closed += delegate { log("Host closed"); application.Shutdown(); };
            pet.Closed += delegate { log("Pet closed"); application.Shutdown(); };
            pet.Show();
            application.Dispatcher.BeginInvoke(DispatcherPriority.ContextIdle, new Action(delegate
            {
                log("Startup input opening");
                pet.FocusForQa();
                log("Startup input focused");
            }));
            application.Run();
            return 0;
        }
    }
}
