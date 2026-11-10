using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace OrbitDesktop
{
    internal static class QaWindow
    {
        internal static int Run(bool useBackdrop = true)
        {
            Native.SetProcessDPIAware();
            var application = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
            var background = new Window {
                Title = "Orbit QA backdrop", WindowStyle = WindowStyle.None,
                ShowInTaskbar = false, ResizeMode = ResizeMode.NoResize,
                Left = SystemParameters.VirtualScreenLeft, Top = SystemParameters.VirtualScreenTop,
                Width = SystemParameters.VirtualScreenWidth, Height = SystemParameters.VirtualScreenHeight,
                Background = new SolidColorBrush(Color.FromRgb(242, 243, 246))
            };
            var window = new Window {
                Title = "Orbit safe test window", Width = 900, Height = 540,
                Left = SystemParameters.WorkArea.Left + Math.Max(30, (SystemParameters.WorkArea.Width - 900) / 2),
                Top = SystemParameters.WorkArea.Top + Math.Max(50, (SystemParameters.WorkArea.Height - 540) / 2),
                Background = Brushes.White, FontFamily = new FontFamily("Segoe UI"), FontSize = 14
            };
            var root = new DockPanel { Margin = new Thickness(28) };
            var footer = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 20, 0, 0) };
            var close = new Button { Content = "Close QA fixture", Padding = new Thickness(15, 8, 15, 8) };
            close.Click += delegate { application.Shutdown(); };
            footer.Children.Add(close);
            DockPanel.SetDock(footer, Dock.Bottom);
            root.Children.Add(footer);
            var tabs = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 26) };
            var current = new Button { Content = "Current tab", Padding = new Thickness(18, 9, 18, 9), Margin = new Thickness(0, 0, 10, 0) };
            var other = new Button { Content = "Other tab", Padding = new Thickness(18, 9, 18, 9) };
            tabs.Children.Add(current);
            tabs.Children.Add(other);
            DockPanel.SetDock(tabs, Dock.Top);
            root.Children.Add(tabs);
            var content = new StackPanel();
            var title = new TextBlock { Text = "A safe place to try the cat", FontSize = 28, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 18) };
            var description = new TextBlock {
                Text = "Drag the cat into this window, release to dock, then hover and type. This fixture contains only synthetic test text. Preview mode never reads window contents or sends network requests.",
                TextWrapping = TextWrapping.Wrap, Foreground = Brushes.Gray, LineHeight = 24, Margin = new Thickness(0, 0, 0, 24)
            };
            var page = new TextBox {
                Text = "Current tab fixture\n\nThis is synthetic content for Orbit desktop QA.\nNo private accounts, documents, credentials, or browser pages are used.",
                AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, Padding = new Thickness(16),
                MinHeight = 170, BorderBrush = Brushes.LightGray, Background = new SolidColorBrush(Color.FromRgb(250, 250, 252))
            };
            current.Click += delegate { page.Text = "Current tab fixture\n\nOnly this active fixture text should be read by a paired non-preview companion."; };
            other.Click += delegate { page.Text = "Other tab fixture\n\nThe previously selected fixture text is no longer displayed in this window."; };
            content.Children.Add(title);
            content.Children.Add(description);
            content.Children.Add(page);
            root.Children.Add(content);
            window.Content = root;
            window.Closed += delegate { application.Shutdown(); };
            if (useBackdrop)
            {
                background.Show();
                window.Owner = background;
            }
            application.Run(window);
            return 0;
        }
    }
}
