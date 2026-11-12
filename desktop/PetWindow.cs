using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Automation;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;

namespace OrbitDesktop
{
    internal sealed class PetWindow : Window
    {
        internal static readonly Geometry CatBody = Geometry.Parse("M10,17 C7,11 7,5 11,5 C15,4 17,10 21,10 A54,54 0 0 1 44,10 C48,9 50,4 54,5 C58,5 58,12 55,18 C60,26 62,32 61,38 C60,50 49,55 32,55 C15,55 3,50 3,38 C2,31 5,24 10,17 Z");
        private readonly BridgeClient bridge;
        private readonly bool preview;
        private readonly IntPtr qaTarget;
        private readonly bool qaNetwork;
        internal Action<string> QaDiagnostic;
        internal Func<IntPtr> QaCoverWindow;
        private readonly Canvas canvas = new Canvas();
        private readonly PetSurface surface;
        private readonly TextBox input = new TextBox();
        private readonly DispatcherTimer frame = new DispatcherTimer();
        private readonly DispatcherTimer sync = new DispatcherTimer();
        private readonly Random random = new Random();
        private readonly HomePull home = new HomePull();
        private IntPtr handle;
        private IntPtr target;
        private IntPtr lastForeground;
        private Point position;
        private Point destination;
        private Point velocity;
        private Point dragOrigin;
        private Point dragPointer;
        private Point previousDragPointer;
        private Point catBeforeDrag;
        private Point tetherAnchor;
        private Point hiddenPosition;
        private uint hiddenTargetProcess;
        private double anchorRatio = 0.5;
        private double size = 52;
        private double expansion;
        private double eyeX;
        private double eyeY;
        private double squash = 1;
        private double blink;
        private int expression;
        private DateTime nextExpression;
        private DateTime hideInputAt = DateTime.MinValue;
        private DateTime interactionAt = DateTime.MinValue;
        private DateTime statusUntil = DateTime.MinValue;
        private DateTime heartUntil = DateTime.MinValue;
        private DateTime homeHeartUntil = DateTime.MinValue;
        private string status = "Drag me to a window";
        private string provider = "Orbit";
        private string lastReply;
        private string contextHash;
        private DateTime lastContextSent = DateTime.MinValue;
        private object lastCapturedContext;
        private bool dragging;
        private bool dragStarted;
        private bool wasDocked;
        private bool wasHome;
        private bool showHome = true;
        private bool docked;
        private bool inputOpen;
        private bool paused;
        private bool remotePaused;
        private bool connected;
        private bool hasUnreadReplies;
        private bool covered;
        private bool companionHidden;
        private int sentMessages;
        private int receivedReplies;
        private int occlusionTicks;
        private bool synchronizing;
        private bool capturing;
        private bool sending;
        private bool shuttingDown;
        private IntPtr highlighted;
        private Task<string> captureTask;

        internal PetWindow(BridgeClient client, bool previewMode, IntPtr syntheticTarget = default(IntPtr), bool syntheticNetwork = false)
        {
            bridge = client;
            preview = previewMode;
            qaTarget = syntheticTarget;
            qaNetwork = syntheticNetwork;
            Title = qaTarget != IntPtr.Zero ? "Orbit Companion Interaction QA" : previewMode ? "Orbit Companion Preview" : "Orbit Companion";
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            ShowInTaskbar = previewMode;
            ShowActivated = false;
            Topmost = true;
            Left = SystemParameters.VirtualScreenLeft;
            Top = SystemParameters.VirtualScreenTop;
            Width = SystemParameters.VirtualScreenWidth;
            Height = SystemParameters.VirtualScreenHeight;
            Content = canvas;

            surface = new PetSurface(this);
            surface.Width = Width;
            surface.Height = Height;
            canvas.Children.Add(surface);
            ConfigureInput();
            canvas.Children.Add(input);

            surface.MouseLeftButtonDown += BeginDrag;
            surface.MouseLeftButtonUp += EndDrag;
            surface.MouseMove += MovePointer;
            surface.LostMouseCapture += delegate
            {
                if (!dragging) return;

                dragging = false;
                if (!dragStarted)
                {
                    docked = wasDocked;
                    home.Parked = wasHome;
                    position = catBeforeDrag;
                    destination = position;
                    SetActivation(false);
                    return;
                }
                dragStarted = false;
                docked = false;
                target = IntPtr.Zero;
                highlighted = IntPtr.Zero;
                destination = position;
                ResetCaptureState();
                if (home.FromHome && !home.Detached) ReturnHome();
                SetActivation(false);
            };
            surface.MouseRightButtonUp += delegate { ShowMenu(); };
            SourceInitialized += InitializeNative;
            Loaded += delegate
            {
                home.Anchor = new Point(SystemParameters.PrimaryScreenWidth / 2 - SystemParameters.VirtualScreenLeft, 22 - SystemParameters.VirtualScreenTop);
                Native.RECT fixture;
                if (qaTarget != IntPtr.Zero && Native.GetWindowRect(qaTarget, out fixture)) home.Anchor = ScreenPoint(new Native.POINT { X = fixture.Left + 155, Y = fixture.Top + 25 });
                position = home.Anchor;
                destination = position;
                size = 28;
                nextExpression = DateTime.UtcNow.AddSeconds(5);
                frame.Start();
                if (!preview || qaNetwork) sync.Start();
                ShowStatus(preview ? "Orbit appearance check" : bridge.Configured ? "Drag me to a window" : "Open Orbit → Get Started and run the installer", 5);
                ReportQa("Ready");
            };
            Closing += delegate
            {
                shuttingDown = true;
                frame.Stop();
                sync.Stop();
            };

            frame.Interval = TimeSpan.FromMilliseconds(30);
            frame.Tick += Tick;
            sync.Interval = TimeSpan.FromMilliseconds(1500);
            sync.Tick += async delegate { await Synchronize(); };
        }

        private void ConfigureInput()
        {
            input.Width = 258;
            input.Height = 27;
            input.FontFamily = new FontFamily("Segoe UI");
            input.FontSize = 12;
            input.Foreground = Brushes.White;
            input.Background = Brushes.Transparent;
            input.BorderThickness = new Thickness(0);
            input.Padding = new Thickness(5, 4, 5, 1);
            input.CaretBrush = Brushes.White;
            input.MaxLength = 30000;
            input.Visibility = Visibility.Collapsed;
            input.ToolTip = "Ask anything · Enter to send · Escape to close";
            input.KeyDown += async delegate(object sender, KeyEventArgs args)
            {
                if (args.Key == Key.Escape) { args.Handled = true; CloseInput(); }
                if (args.Key == Key.Enter && (Keyboard.Modifiers & ModifierKeys.Shift) == 0)
                {
                    args.Handled = true;
                    await SendMessage();
                }
            };
            input.GotKeyboardFocus += delegate { interactionAt = DateTime.UtcNow; };
            input.TextChanged += delegate { ReportQa("Draft changed"); };
            input.PreviewMouseLeftButtonDown += delegate
            {
                SetActivation(true);
                Activate();
                Native.SetForegroundWindow(handle);
                interactionAt = DateTime.UtcNow;
            };
            input.MouseEnter += delegate { hideInputAt = DateTime.UtcNow.AddSeconds(3); };
            AutomationProperties.SetName(input, "Ask Orbit from this window");
        }

        private void InitializeNative(object sender, EventArgs args)
        {
            var source = (HwndSource)PresentationSource.FromVisual(this);
            handle = source.Handle;
            source.AddHook(WindowHook);
            SetActivation(false);
        }

        private IntPtr WindowHook(IntPtr window, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (message == Native.WM_NCHITTEST)
            {
                Native.POINT pointer;
                Native.GetCursorPos(out pointer);
                var point = ScreenPoint(pointer);

                if (!Interactive(point)) { handled = true; return new IntPtr(-1); }
            }

            if (message == Native.WM_MOUSEACTIVATE && !inputOpen) { handled = true; return new IntPtr(3); }
            return IntPtr.Zero;
        }

        private void SetActivation(bool active)
        {
            if (handle == IntPtr.Zero) return;

            var style = Native.GetWindowLong(handle, Native.GWL_EXSTYLE);
            style = preview ? style & ~Native.WS_EX_TOOLWINDOW : style | Native.WS_EX_TOOLWINDOW;
            style = active ? style & ~Native.WS_EX_NOACTIVATE : style | Native.WS_EX_NOACTIVATE;
            Native.SetWindowLong(handle, Native.GWL_EXSTYLE, style);
        }

        private Point ScreenPoint(Native.POINT point) { return PointFromScreen(new Point(point.X, point.Y)); }

        private bool Interactive(Point point)
        {
            if (showHome && home.Hit(point)) return true;
            if (covered && !dragging && !input.IsKeyboardFocused) return false;
            var bar = new Rect(InputBarLeft(), position.Y - 22, 312, 44);
            return dragging || (!home.Parked && expansion < 0.65 && HitCat(point, position, size, expansion, squash)) || (inputOpen && bar.Contains(point));
        }

        // Same silhouette as the visible cat

        internal static bool HitCat(Point point, Point center, double catSize, double open, double stretch)
        {
            var width = catSize * (1 + open * 1.2);
            var height = catSize * 0.86 * stretch * (1 - open * 0.5);
            if (width <= 0 || height <= 0) return false;
            return CatBody.FillContains(new Point((point.X - center.X + width / 2) * 64 / width, (point.Y - center.Y + height / 2) * 56 / height));
        }

        private double InputBarLeft()
        {
            return Math.Max(4, Math.Min(Width - 315, position.X - 155.5));
        }

        private void BeginDrag(object sender, MouseButtonEventArgs args)
        {
            Native.POINT cursor;
            Native.GetCursorPos(out cursor);
            var fromHome = showHome && home.Hit(ScreenPoint(cursor));
            if (args.ClickCount == 2 && !fromHome)
            {
                var foreground = Native.GetForegroundWindow();
                if (qaTarget != IntPtr.Zero) foreground = qaTarget;
                if (Native.IsOurs(foreground)) foreground = lastForeground;
                if (qaTarget != IntPtr.Zero) Attach(qaTarget);
                else if (!Native.IsOurs(foreground)) Attach(foreground);
                return;
            }

            dragPointer = ScreenPoint(cursor);
            previousDragPointer = dragPointer;
            catBeforeDrag = position;
            wasHome = home.Parked;
            home.Begin(fromHome);
            dragOrigin = fromHome ? home.Anchor : position;
            tetherAnchor = dragOrigin;
            wasDocked = docked;
            dragging = true;
            dragStarted = false;
            inputOpen = false;
            expansion = 0;
            input.Visibility = Visibility.Collapsed;
            SetActivation(false);
            surface.CaptureMouse();
            ReportQa("Mouse down");
            interactionAt = DateTime.UtcNow;
            args.Handled = true;
        }

        private void MovePointer(object sender, MouseEventArgs args)
        {
            if (!dragging) return;

            Native.POINT cursor;
            Native.GetCursorPos(out cursor);
            var pointer = ScreenPoint(cursor);
            var delta = pointer - dragPointer;

            if (delta.Length > 4) dragStarted = true;

            if (dragStarted)
            {
                if (home.Parked || home.Returning || target != IntPtr.Zero) ResetCaptureState();
                home.Parked = false;
                home.Returning = false;
                docked = false;
                target = IntPtr.Zero;
                position = dragOrigin + delta;
                destination = position;
                home.Bend = Math.Max(-12, Math.Min(12, (pointer.X - previousDragPointer.X) * 0.35));
                previousDragPointer = pointer;
                if ((home.FromHome || wasDocked) && home.Stretch(position - tetherAnchor) && home.FromHome)
                    homeHeartUntil = DateTime.UtcNow.AddSeconds(1.7);
                highlighted = (home.FromHome && !home.Detached) || home.Hit(position) ? IntPtr.Zero : DropTarget(cursor);
                squash = Math.Max(0.78, Math.Min(1.24, 1 + delta.Length / 750));
            }
        }

        private void EndDrag(object sender, MouseButtonEventArgs args)
        {
            if (!dragging) return;

            dragging = false;
            surface.ReleaseMouseCapture();
            highlighted = IntPtr.Zero;

            if (dragStarted)
            {
                Native.POINT cursor;
                Native.GetCursorPos(out cursor);
                var candidate = DropTarget(cursor);

                if (home.ReturnOnDrop(position)) ReturnHome();
                else if (candidate != IntPtr.Zero) Attach(candidate);
                else { target = IntPtr.Zero; docked = false; ShowStatus("Drop me onto a window to attach", 3); }
            }
            else
            {
                docked = wasDocked;
                home.Parked = wasHome;
                position = catBeforeDrag;
                destination = position;
                if (!home.FromHome && !home.Parked) OpenInput(true);
            }

            squash = 0.65;
            args.Handled = true;
            ReportQa("Mouse up");
        }

        private IntPtr DropTarget(Native.POINT pointer)
        {
            if (qaTarget == IntPtr.Zero) return Native.WindowUnder(pointer);

            Native.RECT rect;
            return Native.GetWindowRect(qaTarget, out rect) && Native.Contains(rect, pointer) ? qaTarget : IntPtr.Zero;
        }

        private void Attach(IntPtr window)
        {
            Native.RECT rect;
            if (window == IntPtr.Zero || (qaTarget != IntPtr.Zero && window != qaTarget)
                || (Native.IsOurs(window) && window != qaTarget) || !Native.GetWindowRect(window, out rect)) return;

            var left = ScreenPoint(new Native.POINT { X = rect.Left, Y = rect.Top });
            var right = ScreenPoint(new Native.POINT { X = rect.Right, Y = rect.Top });
            target = window;
            home.Parked = false;
            home.Returning = false;
            ResetCaptureState();
            docked = true;
            anchorRatio = Math.Max(0.08, Math.Min(0.92, (position.X - left.X) / Math.Max(1, right.X - left.X)));
            Native.SetForegroundWindow(window);
            UpdateAnchor();
            velocity = new Point(0, -11);
            heartUntil = DateTime.UtcNow.AddSeconds(1.7);
            ShowStatus("Attached · hover to type", 3);
            ReportQa("Attached");
        }

        private void ReturnHome()
        {
            target = IntPtr.Zero;
            docked = false;
            home.Parked = false;
            home.Returning = true;
            destination = home.Anchor;
            velocity = new Point(0, 0);
            ResetCaptureState();
            ReportQa("Returning to fixed home");
        }

        private void UpdateAnchor()
        {
            Native.RECT rect;
            if (!docked || !Native.GetWindowRect(target, out rect)) return;

            var left = ScreenPoint(new Native.POINT { X = rect.Left, Y = rect.Top });
            var right = ScreenPoint(new Native.POINT { X = rect.Right, Y = rect.Top });
            var x = left.X + (right.X - left.X) * anchorRatio;
            var y = left.Y - 9;

            destination = new Point(Math.Max(40, Math.Min(Width - 40, x)), Math.Max(22, Math.Min(Height - 35, y)));
        }

        private void Tick(object sender, EventArgs args)
        {
            if (companionHidden) return;
            Native.POINT pointer;
            Native.GetCursorPos(out pointer);
            var cursor = ScreenPoint(pointer);
            var now = DateTime.UtcNow;
            home.Tick();
            var foreground = Native.GetForegroundWindow();

            if (foreground != IntPtr.Zero && !Native.IsOurs(foreground)) lastForeground = foreground;
            if (foreground == qaTarget && qaTarget != IntPtr.Zero) lastForeground = qaTarget;

            if (docked && !dragging)
            {
                if (!Native.IsWindow(target) || !Native.IsWindowVisible(target) || Native.IsIconic(target))
                {
                    docked = false;
                    target = IntPtr.Zero;
                    destination = position;
                }
                else UpdateAnchor();
            }

            if (!dragging)
            {
                if (home.Parked) destination = home.Anchor;
                if (home.Returning) destination = home.Anchor;
                velocity = new Point((velocity.X + (destination.X - position.X) * 0.18) * 0.62, (velocity.Y + (destination.Y - position.Y) * 0.18) * 0.62);
                position = new Point(position.X + velocity.X, position.Y + velocity.Y);
                if (home.Returning && (position - home.Anchor).Length < 1 && Math.Abs(velocity.X) + Math.Abs(velocity.Y) < 1)
                {
                    home.Park();
                    position = home.Anchor;
                    destination = position;
                    velocity = new Point(0, 0);
                }
            }

            if (++occlusionTicks % 4 == 0) UpdateCovered();

            var desiredSize = home.Parked ? 28 : docked ? 29 : home.Returning ? 32 : dragging && home.FromHome && !home.Detached ? 44 : 52;
            size += (desiredSize - size) * 0.22;
            expansion += ((inputOpen ? 1 : 0) - expansion) * 0.2;
            squash += (1 - squash) * 0.22;
            eyeX += (Math.Max(-4, Math.Min(4, (cursor.X - position.X) / 80)) - eyeX) * 0.12;
            eyeY += (Math.Max(-3, Math.Min(3, (cursor.Y - position.Y) / 90)) - eyeY) * 0.12;

            if (now >= nextExpression)
            {
                expression = random.Next(0, 4);
                blink = 1;
                nextExpression = now.AddSeconds(5);
            }

            blink *= 0.68;

            var overCat = !home.Parked && expansion < 0.65 && HitCat(cursor, position, size, expansion, squash);
            if (AttachmentPolicy.HoverReady(overCat, docked && !dragging && !inputOpen && !covered)) OpenInput(false);

            if (!dragging && inputOpen && Interactive(cursor)) hideInputAt = now.AddSeconds(1.6);

            if (inputOpen && (!input.IsKeyboardFocused || String.IsNullOrWhiteSpace(input.Text)) && now > hideInputAt && !dragging) CloseInput();

            input.Visibility = inputOpen && expansion > 0.75 && !covered ? Visibility.Visible : Visibility.Collapsed;
            input.Opacity = Math.Max(0, Math.Min(1, (expansion - 0.6) * 2.5));
            Canvas.SetLeft(input, InputBarLeft() + 26);
            Canvas.SetTop(input, position.Y - 13);
            surface.InvalidateVisual();
        }

        private void OpenInput(bool focus)
        {
            if (dragging) return;

            inputOpen = true;
            expansion = AttachmentPolicy.ExpansionOnOpen(focus, expansion);
            hideInputAt = DateTime.UtcNow.AddSeconds(2);
            interactionAt = DateTime.UtcNow;

            if (focus)
            {
                SetActivation(true);
                Activate();
                Native.SetForegroundWindow(handle);
                input.Visibility = Visibility.Visible;
                input.Focus();
                Keyboard.Focus(input);
            }

            ReportQa(focus ? "Input focused" : "Input opened");
        }

        private void CloseInput()
        {
            inputOpen = false;
            input.Visibility = Visibility.Collapsed;
            Keyboard.ClearFocus();
            SetActivation(false);

            if (Native.GetForegroundWindow() == handle && target != IntPtr.Zero) Native.SetForegroundWindow(target);
            ReportQa("Input closed");
        }

        private async Task SendMessage()
        {
            if (!AttachmentPolicy.CanSend(sending, input.Text)) return;
            if (preview && !qaNetwork)
            {
                input.Text = "";
                CloseInput();
                squash = 0.55;
                ShowStatus("Preview only · no window capture or network requests", 4);
                return;
            }
            if (!bridge.Configured) { ShowStatus("Open Orbit → Get Started and run the installer", 5); return; }

            sending = true;
            var text = input.Text.Trim();
            input.Text = "";
            CloseInput();
            ShowStatus("Sending to " + provider + "…", 4);

            try
            {
                ReportQa("Enter submitted");
                await bridge.Request("/api/companion/state");
                bool current;

                if (qaNetwork)
                {
                    lastCapturedContext = new { source = "desktop", windowTitle = "Orbit interaction QA host", app = "orbit-qa", text = "Synthetic QA current-window content only", capturedAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) };
                    current = true;
                }
                else
                {
                    current = await TryBrowserContext();
                    if (!current) current = await CaptureCurrent(true);
                    if (paused || remotePaused || !CaptureAllowed(Native.GetForegroundWindow())) current = false;
                }

                await bridge.Request("/api/companion/message", new { text = text, context = current ? lastCapturedContext : null, useCurrentContext = current });
                heartUntil = DateTime.UtcNow.AddSeconds(1.2);
                squash = 0.55;
                ShowStatus("Sent · continue in Orbit", 4);
                sentMessages += 1;
                ReportQa("Message queued");
            }
            catch (Exception error)
            {
                input.Text = AttachmentPolicy.RestoreDraft(input.Text, text);
                var authentication = error as BridgeRequestException;
                ShowStatus(authentication != null && authentication.Status == 401 ? "Open Orbit → Get Started and run the installer to reconnect" : error.Message, 9);
                ReportQa("Send failed: " + error.Message);
            }
            finally { sending = false; }
        }

        private async Task Synchronize()
        {
            if (synchronizing || shuttingDown) return;
            synchronizing = true;

            try
            {
                if (await bridge.ActivateInstall())
                {
                    ResetCaptureState();
                    SetCompanionHidden(false);
                }
                if (!bridge.Configured) return;
                var state = await bridge.Request("/api/companion/state");
                var command = BridgeClient.Control(state);
                if (command != null)
                {
                    connected = false;
                    hasUnreadReplies = false;
                    ResetCaptureState();
                    CloseInput();
                    bridge.ApplyControl(state);
                    ReportQa("Website command: " + command);
                    if (command == "quit") Close();
                    else ShowStatus("Disconnected · right-click to pair with Orbit", 5);
                    return;
                }
                connected = true;
                SetCompanionHidden(BridgeClient.Flag(state, "hidden"));
                hasUnreadReplies = BridgeClient.Flag(state, "hasUnreadReplies");
                provider = BridgeClient.Text(state, "provider") ?? "Orbit";
                var nextPause = BridgeClient.Flag(state, "paused");
                if (remotePaused != nextPause) ResetCaptureState();
                remotePaused = nextPause;
                object replyObject;

                if (state.TryGetValue("latestReply", out replyObject) && replyObject is Dictionary<string, object>)
                {
                    var reply = (Dictionary<string, object>)replyObject;
                    var signature = BridgeClient.Text(reply, "messageId") + BridgeClient.Text(reply, "text") + BridgeClient.Text(reply, "error");

                    if (signature != lastReply)
                    {
                        lastReply = signature;
                        var message = BridgeClient.Text(reply, "error") ?? BridgeClient.Text(reply, "text");

                        if (!String.IsNullOrWhiteSpace(message)) ShowStatus(message, 7);
                        receivedReplies += 1;
                        ReportQa("Reply received");
                    }
                }

                if (qaTarget != IntPtr.Zero) return;

                var foreground = Native.GetForegroundWindow();
                object contextObject;
                bool browserContext = Native.ProcessName(foreground).Equals("chrome", StringComparison.OrdinalIgnoreCase)
                    && state.TryGetValue("context", out contextObject) && contextObject is Dictionary<string, object>
                    && BridgeClient.Text((Dictionary<string, object>)contextObject, "source") == "browser"
                    && String.Equals(BridgeClient.Text((Dictionary<string, object>)contextObject, "app"), "chrome", StringComparison.OrdinalIgnoreCase);

                if (!browserContext) await CaptureCurrent();
            }
            catch (Exception error)
            {
                connected = false;
                var authentication = error as BridgeRequestException;
                if (authentication != null && authentication.Status == 401) ShowStatus("Open Orbit → Get Started and run the installer to reconnect", 5);
            }
            finally { synchronizing = false; }
        }

        // Temporary visibility with a fixed restore point

        private void SetCompanionHidden(bool hide)
        {
            if (companionHidden == hide) return;

            if (hide)
            {
                hiddenPosition = position;
                Native.GetWindowThreadProcessId(target, out hiddenTargetProcess);
                dragging = false;
                dragStarted = false;
                highlighted = IntPtr.Zero;
                surface.ReleaseMouseCapture();
                CloseInput();
                velocity = new Point(0, 0);
                companionHidden = true;
                Hide();
                ReportQa("Hidden from website");
                return;
            }

            uint currentProcess;
            Native.GetWindowThreadProcessId(target, out currentProcess);
            if (!AttachmentPolicy.CanRestoreAttachment(docked, Native.IsWindow(target), Native.IsWindowVisible(target), Native.IsIconic(target), hiddenTargetProcess, currentProcess))
            {
                docked = false;
                target = IntPtr.Zero;
                ResetCaptureState();
            }

            position = hiddenPosition;
            destination = home.Returning ? home.Anchor : hiddenPosition;
            velocity = new Point(0, 0);
            covered = false;
            companionHidden = false;
            SetActivation(false);
            Show();
            surface.InvalidateVisual();
            ReportQa("Restored from website");
        }

        private bool CaptureAllowed(IntPtr foreground)
        {
            return target != IntPtr.Zero && Native.IsWindow(target) && !Native.IsIconic(target)
                && (foreground == target || (foreground == handle && lastForeground == target && inputOpen));
        }

        private async Task<bool> TryBrowserContext()
        {
            if (preview || paused || remotePaused || !bridge.Configured || !CaptureAllowed(Native.GetForegroundWindow())
                || !Native.ProcessName(target).Equals("chrome", StringComparison.OrdinalIgnoreCase)) return false;

            try
            {
                var state = await bridge.Request("/api/companion/state");
                if (BridgeClient.Flag(state, "paused") || !CaptureAllowed(Native.GetForegroundWindow())) return false;

                object value;
                if (!state.TryGetValue("context", out value) || !(value is Dictionary<string, object>)) return false;

                var context = (Dictionary<string, object>)value;
                var title = Native.Title(target);
                var expected = BridgeClient.Text(context, "title") ?? BridgeClient.Text(context, "windowTitle");
                DateTime captured;

                if (BridgeClient.Text(context, "source") != "browser"
                    || !String.Equals(BridgeClient.Text(context, "app"), "chrome", StringComparison.OrdinalIgnoreCase)
                    || String.IsNullOrWhiteSpace(expected)
                    || !(title.Equals(expected, StringComparison.Ordinal) || title.StartsWith(expected + " - ", StringComparison.Ordinal) || title.StartsWith(expected + " — ", StringComparison.Ordinal))
                    || !DateTime.TryParse(BridgeClient.Text(context, "capturedAt"), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out captured)
                    || (DateTime.UtcNow - captured.ToUniversalTime()).TotalSeconds > 5) return false;

                lastCapturedContext = context;
                return true;
            }
            catch { return false; }
        }

        private async Task<bool> CaptureCurrent(bool force = false)
        {
            if (preview || paused || remotePaused || !bridge.Configured || !CaptureAllowed(Native.GetForegroundWindow())) return false;

            if (force)
            {
                for (int attempt = 0; capturing && attempt < 10; attempt++) await Task.Delay(100);
            }

            if (capturing || (captureTask != null && !captureTask.IsCompleted) || !CaptureAllowed(Native.GetForegroundWindow())) return false;

            capturing = true;
            var currentTarget = target;

            try
            {
                captureTask = Task.Run(delegate
                {
                    if (currentTarget != target || !CaptureAllowed(Native.GetForegroundWindow())) return "";
                    return ContextReader.Read(currentTarget);
                });
                var finished = await Task.WhenAny(captureTask, Task.Delay(900));

                if (finished != captureTask || currentTarget != target || paused || remotePaused || !CaptureAllowed(Native.GetForegroundWindow())) return false;

                var text = await captureTask;
                if (String.IsNullOrWhiteSpace(text)) return false;

                var title = Native.Title(target);
                string signature;

                using (var hash = SHA256.Create()) signature = Convert.ToBase64String(hash.ComputeHash(Encoding.UTF8.GetBytes(title + "\n" + text)));
                if (!ContextReader.RefreshRequired(force, signature == contextHash, DateTime.UtcNow - lastContextSent)) return lastCapturedContext != null;

                var context = new {
                    source = "desktop", windowTitle = title, app = Native.ProcessName(target), text = text,
                    capturedAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
                };
                var result = await bridge.Request("/api/companion/context", context);

                if (BridgeClient.Flag(result, "stored"))
                {
                    contextHash = signature;
                    lastContextSent = DateTime.UtcNow;
                    lastCapturedContext = context;
                    return currentTarget == target && CaptureAllowed(Native.GetForegroundWindow());
                }

                return false;
            }
            catch { return false; }
            finally { capturing = false; }
        }

        private void ResetCaptureState()
        {
            contextHash = null;
            lastContextSent = DateTime.MinValue;
            lastCapturedContext = null;
        }

        private void UpdateCovered()
        {
            var next = false;

            if (docked && target != IntPtr.Zero && !dragging && !input.IsKeyboardFocused && !surface.IsMouseCaptured)
            {
                Native.RECT host;

                if (Native.GetWindowRect(target, out host))
                {
                    var anchor = PointToScreen(position);
                    var point = new Native.POINT { X = (int)anchor.X, Y = host.Top + 2 };

                    if (qaTarget != IntPtr.Zero)
                    {
                        var cover = QaCoverWindow == null ? IntPtr.Zero : QaCoverWindow();
                        Native.RECT bounds;
                        next = cover != IntPtr.Zero && Native.IsWindowVisible(cover) && Native.GetWindowRect(cover, out bounds) && Native.Contains(bounds, point);
                    }
                    else next = Native.CoveredAt(target, point);
                }
            }

            next = AttachmentPolicy.HideCovered(docked, next, dragging, input.IsKeyboardFocused, surface.IsMouseCaptured);

            if (covered != next)
            {
                covered = next;
                ReportQa(covered ? "Covered by another window" : "Visible");
            }
        }

        internal void FocusForQa()
        {
            if (qaTarget != IntPtr.Zero) OpenInput(true);
        }

        private void ReportQa(string action)
        {
            if (qaTarget == IntPtr.Zero || QaDiagnostic == null) return;
            QaDiagnostic(action + " | docked=" + docked + " | dragging=" + dragging + " | focused=" + input.IsKeyboardFocused + " | draft=" + input.Text.Length + " | queued=" + sentMessages + " | replies=" + receivedReplies);
        }

        private void ShowStatus(string text, double seconds)
        {
            status = text.Length > 180 ? text.Substring(0, 177) + "…" : text;
            statusUntil = DateTime.UtcNow.AddSeconds(seconds);
        }

        private void ShowMenu()
        {
            var menu = new ContextMenu();
            var state = new MenuItem { Header = connected ? "Connected to Orbit" : "Orbit is offline", IsEnabled = false };
            var pause = new MenuItem { Header = paused ? "Resume desktop context" : "Pause desktop context" };
            var open = new MenuItem { Header = "Open Orbit" };
            var quit = new MenuItem { Header = "Quit Orbit" };

            pause.Click += delegate { paused = !paused; ResetCaptureState(); ShowStatus(paused ? "Context sharing paused" : "Current-window context enabled", 4); };
            open.Click += delegate { if (bridge.Configured) System.Diagnostics.Process.Start(bridge.BaseUrl); };
            quit.Click += delegate { Close(); };
            menu.Items.Add(state);
            menu.Items.Add(pause);
            menu.Items.Add(open);
            menu.Items.Add(new Separator());
            menu.Items.Add(quit);
            menu.IsOpen = true;
        }

        // Offline animation preview

        private static Point PreviewLerp(Point from, Point to, double amount)
        {
            amount = Math.Max(0, Math.Min(1, amount));
            amount = amount * amount * (3 - 2 * amount);
            return from + (to - from) * amount;
        }

        internal void RenderLaunchFrames(string directory)
        {
            System.IO.Directory.CreateDirectory(directory);
            Width = 680;
            Height = 440;
            canvas.Width = surface.Width = 680;
            canvas.Height = surface.Height = 440;
            home.Anchor = new Point(340, 22);
            home.Begin(true);
            showHome = true;
            statusUntil = DateTime.MinValue;
            connected = true;
            var brokeAt = -1.0;

            for (var index = 0; index < 132; index++)
            {
                var time = index / 24.0;
                home.Tick();
                home.Parked = time < 0.8;
                dragging = time >= 0.8 && time < 3.55;
                dragStarted = dragging;
                docked = time >= 3.55;
                wasDocked = false;
                tetherAnchor = home.Anchor;
                home.Bend = Math.Sin(time * 6) * 5;
                if (time < 0.8) position = home.Anchor;
                else if (time < 1.65) position = PreviewLerp(home.Anchor, new Point(340, 126), (time - 0.8) / 0.85);
                else if (time < 2.1) position = PreviewLerp(new Point(340, 126), new Point(260, 123), (time - 1.65) / 0.45);
                else if (time < 2.55) position = PreviewLerp(new Point(260, 123), new Point(420, 139), (time - 2.1) / 0.45);
                else if (time < 2.95) position = PreviewLerp(new Point(420, 139), new Point(340, 222), (time - 2.55) / 0.4);
                else if (time < 3.55) position = PreviewLerp(new Point(340, 222), new Point(470, 261), (time - 2.95) / 0.6);
                else position = new Point(470, 261);

                if (dragging && home.Stretch(position - home.Anchor)) brokeAt = time;
                homeHeartUntil = brokeAt >= 0 && time - brokeAt < 1.7 ? DateTime.UtcNow.AddSeconds(1.7 - (time - brokeAt)) : DateTime.MinValue;
                size = home.Parked ? 28 : docked ? 29 : home.Detached ? 52 : 44;
                squash = dragging && !home.Detached ? 1.14 : 1;
                expansion = time < 4.2 ? 0 : Math.Min(1, (time - 4.2) / 0.4);
                inputOpen = expansion > 0;
                input.Visibility = expansion > 0.75 ? Visibility.Visible : Visibility.Collapsed;
                input.Opacity = 1;
                input.Text = "Ask anything";
                Canvas.SetLeft(input, InputBarLeft() + 26);
                Canvas.SetTop(input, position.Y - 13);
                surface.InvalidateVisual();
                canvas.Measure(new Size(680, 440));
                canvas.Arrange(new Rect(0, 0, 680, 440));
                canvas.UpdateLayout();
                var cat = new System.Windows.Media.Imaging.RenderTargetBitmap(680, 440, 96, 96, PixelFormats.Pbgra32);
                cat.Render(canvas);

                var composed = new DrawingVisual();
                using (var drawing = composed.RenderOpen())
                {
                    drawing.DrawRectangle(new SolidColorBrush(Color.FromRgb(237, 239, 243)), null, new Rect(0, 0, 680, 440));
                    drawing.DrawRoundedRectangle(Brushes.White, new Pen(new SolidColorBrush(Color.FromRgb(214, 217, 224)), 1), new Rect(122, 270, 536, 154), 13, 13);
                    drawing.DrawLine(new Pen(new SolidColorBrush(Color.FromRgb(235, 237, 241)), 1), new Point(122, 303), new Point(658, 303));
                    for (var row = 0; row < 5; row++) drawing.DrawRoundedRectangle(new SolidColorBrush(Color.FromRgb(224, 227, 233)), null, new Rect(145, 323 + row * 17, 150 + (row % 3) * 80, 4), 2, 2);
                    drawing.DrawImage(cat, new Rect(0, 0, 680, 440));
                    if (time >= 0.55 && time < 4.4)
                    {
                        var pointer = time < 0.8 ? PreviewLerp(home.Anchor + new Vector(60, 70), home.Anchor + new Vector(8, 7), (time - 0.55) / 0.25) : position + new Vector(10, 7);
                        drawing.PushTransform(new TranslateTransform(pointer.X, pointer.Y));
                        drawing.PushTransform(new ScaleTransform(0.72, 0.72));
                        drawing.DrawGeometry(Brushes.White, new Pen(new SolidColorBrush(Color.FromRgb(55, 56, 64)), 1.5), Geometry.Parse("M0,0 L0,23 L6,17 L11,28 L16,25 L10,15 L20,15 Z"));
                        drawing.Pop();
                        drawing.Pop();
                    }
                }

                var frameImage = new System.Windows.Media.Imaging.RenderTargetBitmap(680, 440, 96, 96, PixelFormats.Pbgra32);
                frameImage.Render(composed);
                var encoder = new System.Windows.Media.Imaging.PngBitmapEncoder();
                encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(frameImage));
                using (var file = System.IO.File.Create(System.IO.Path.Combine(directory, "frame-" + index.ToString("D3") + ".png"))) encoder.Save(file);
            }
        }

        internal void RenderPreview(string filename)
        {
            showHome = false;
            home.Parked = false;
            Width = 360;
            Height = 110;
            canvas.Width = 360;
            canvas.Height = 110;
            surface.Width = 360;
            surface.Height = 110;
            position = new Point(180, 52);
            statusUntil = DateTime.MinValue;
            connected = true;
            var composed = new DrawingVisual();

            using (var context = composed.RenderOpen())
            {
                for (int state = 0; state < 3; state++)
                {
                    hasUnreadReplies = state == 1;
                    docked = state > 0;
                    size = state == 0 ? 52 : 29;
                    expansion = state == 2 ? 1 : 0;
                    inputOpen = state == 2;
                    input.Visibility = state == 2 ? Visibility.Visible : Visibility.Collapsed;
                    input.Opacity = 1;
                    input.Text = state == 2 ? "Ask anything" : "";
                    Canvas.SetLeft(input, InputBarLeft() + 26);
                    Canvas.SetTop(input, position.Y - 13);
                    surface.InvalidateVisual();
                    canvas.Measure(new Size(360, 110));
                    canvas.Arrange(new Rect(0, 0, 360, 110));
                    canvas.UpdateLayout();
                    var bitmap = new System.Windows.Media.Imaging.RenderTargetBitmap(360, 110, 96, 96, PixelFormats.Pbgra32);
                    bitmap.Render(canvas);
                    context.DrawImage(bitmap, new Rect(0, state * 110, 360, 110));
                }
            }

            var output = new System.Windows.Media.Imaging.RenderTargetBitmap(360, 330, 96, 96, PixelFormats.Pbgra32);
            output.Render(composed);
            var encoder = new System.Windows.Media.Imaging.PngBitmapEncoder();
            encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(output));

            using (var file = System.IO.File.Create(filename)) encoder.Save(file);
        }

        private sealed class PetSurface : FrameworkElement
        {
            private readonly PetWindow pet;
            private readonly Brush red = new SolidColorBrush(Color.FromRgb(255, 61, 78));
            private readonly Brush charcoal = new SolidColorBrush(Color.FromRgb(29, 28, 35));
            private readonly Brush unread = new SolidColorBrush(Color.FromRgb(52, 199, 89));

            internal PetSurface(PetWindow window) { pet = window; }

            protected override void OnRender(DrawingContext drawing)
            {
                if (pet.showHome) DrawHomePlate(drawing);
                if (pet.covered && !pet.dragging && !pet.input.IsKeyboardFocused)
                {
                    if (pet.showHome) DrawHomeFace(drawing);
                    return;
                }
                if (pet.dragging && pet.highlighted != IntPtr.Zero)
                {
                    Native.RECT rect;

                    if (Native.GetWindowRect(pet.highlighted, out rect))
                    {
                        var a = pet.ScreenPoint(new Native.POINT { X = rect.Left, Y = rect.Top });
                        var b = pet.ScreenPoint(new Native.POINT { X = rect.Right, Y = rect.Bottom });
                        drawing.DrawRoundedRectangle(null, new Pen(new SolidColorBrush(Color.FromArgb(210, 255, 255, 255)), 2.5), new Rect(a, b), 13, 13);
                    }
                }

                if (pet.showHome && pet.home.Recoil.Length > 1)
                    DrawTether(drawing, pet.home.Anchor, pet.home.Anchor + pet.home.Recoil, 4, 0);

                if (pet.home.Returning)
                    DrawTether(drawing, pet.home.Anchor, pet.position, pet.size * 0.32, pet.home.Bend);
                else if (pet.dragging && pet.dragStarted && (pet.home.FromHome || pet.wasDocked) && !pet.home.Detached)
                {
                    if (!pet.home.FromHome) DrawNotch(drawing, pet.tetherAnchor, 74, 0);
                    DrawTether(drawing, pet.tetherAnchor, pet.position, pet.size * 0.32, pet.home.Bend);
                }

                if (pet.showHome) DrawHomeFace(drawing);

                if (!pet.home.Parked && (pet.docked || pet.expansion > 0.02)) DrawNotch(drawing, pet.position, 76 + pet.expansion * 235, pet.expansion);

                if (!pet.home.Parked && pet.expansion < 0.65)
                {
                    drawing.PushOpacity(pet.home.Returning ? Math.Min(1, (pet.position - pet.home.Anchor).Length / 30) : 1);
                    DrawCat(drawing);
                    drawing.Pop();
                }

                if (pet.hasUnreadReplies && !pet.home.Parked && !pet.home.Returning && !pet.inputOpen && !pet.dragging)
                {
                    drawing.DrawEllipse(unread, new Pen(charcoal, 1), new Point(pet.position.X + pet.size * 0.42, pet.position.Y - pet.size * 0.36), 3, 3);
                }

                if (pet.expansion > 0.05 && pet.expansion < 0.75)
                {
                    var width = 32 + pet.expansion * 130;
                    drawing.DrawRoundedRectangle(red, null, new Rect(pet.position.X - width / 2, pet.position.Y - 7, width, 14), 9, 9);
                }

                if (!pet.home.Parked && DateTime.UtcNow < pet.heartUntil)
                {
                    var seconds = (pet.heartUntil - DateTime.UtcNow).TotalSeconds;

                    for (int index = 0; index < 3; index++)
                    {
                        var text = new FormattedText("♥", CultureInfo.InvariantCulture, FlowDirection.LeftToRight, new Typeface("Segoe UI Symbol"), 9 + index, red, VisualTreeHelper.GetDpi(this).PixelsPerDip);
                        drawing.DrawText(text, new Point(pet.position.X - 15 + index * 12, pet.position.Y - 31 - (1.7 - seconds) * 7 - (index % 2) * 6));
                    }
                }

                if (DateTime.UtcNow < pet.statusUntil && !pet.inputOpen && !pet.dragging) DrawStatus(drawing);
            }

            // Fixed screen-top source

            private void DrawHomePlate(DrawingContext drawing)
            {
                var center = pet.home.Anchor;
                var top = center.Y - 22;
                var shape = new StreamGeometry();
                using (var line = shape.Open())
                {
                    line.BeginFigure(new Point(center.X - 66, top), true, true);
                    line.BezierTo(new Point(center.X - 48, top), new Point(center.X - 50, top + 34), new Point(center.X - 32, top + 34), true, false);
                    line.LineTo(new Point(center.X + 32, top + 34), true, false);
                    line.BezierTo(new Point(center.X + 50, top + 34), new Point(center.X + 48, top), new Point(center.X + 66, top), true, false);
                }
                drawing.DrawGeometry(charcoal, null, shape);
            }

            private void DrawHomeFace(DrawingContext drawing)
            {
                var center = pet.home.Anchor + pet.home.Recoil * 0.035;
                var pulling = pet.home.Returning || pet.dragging && pet.dragStarted && pet.home.FromHome && !pet.home.Detached;
                var happy = DateTime.UtcNow < pet.homeHeartUntil;
                drawing.DrawEllipse(new SolidColorBrush(Color.FromRgb(49, 45, 55)), null, center, 13, 11);

                foreach (var side in new[] { -1, 1 })
                {
                    var eye = new Point(center.X + side * 3.6 + pet.eyeX * 0.3, center.Y + pet.eyeY * 0.3);
                    if (happy || pulling)
                    {
                        var smile = new StreamGeometry();
                        using (var line = smile.Open())
                        {
                            line.BeginFigure(new Point(eye.X - 2.7, eye.Y + 1), false, false);
                            line.QuadraticBezierTo(new Point(eye.X, eye.Y - (pulling ? 5 : 4)), new Point(eye.X + 2.7, eye.Y + 1), true, false);
                        }
                        drawing.DrawGeometry(null, new Pen(Brushes.White, 1.7), smile);
                    }
                    else drawing.DrawRoundedRectangle(Brushes.White, null, new Rect(eye.X - 1.4, eye.Y - 2, 2.8, Math.Max(1.2, 4.5 * (1 - pet.blink))), 1.4, 1.4);
                }

                if (happy)
                {
                    var progress = 1.7 - (pet.homeHeartUntil - DateTime.UtcNow).TotalSeconds;
                    for (var index = 0; index < 3; index++)
                    {
                        var heart = new FormattedText("♥", CultureInfo.InvariantCulture, FlowDirection.LeftToRight, new Typeface("Segoe UI Symbol"), 8, red, VisualTreeHelper.GetDpi(this).PixelsPerDip);
                        drawing.DrawText(heart, new Point(center.X - 13 + index * 9, center.Y - 16 - progress * 4 - (index % 2) * 3));
                    }
                }
                if (pet.home.Parked && pet.hasUnreadReplies) drawing.DrawEllipse(unread, null, new Point(center.X + 10, center.Y - 9), 2.5, 2.5);
            }

            // Pinched neck and elastic recoil

            private void DrawTether(DrawingContext drawing, Point anchor, Point tip, double radius, double bend)
            {
                var offset = tip - anchor;
                if (offset.Length < 1) return;
                var normal = new Vector(-offset.Y, offset.X);
                normal.Normalize();
                var middle = anchor + offset * 0.52 + normal * bend;
                var neckWidth = Math.Max(1.5, 6 * (1 - offset.Length / 230));
                var shape = new StreamGeometry();
                using (var line = shape.Open())
                {
                    line.BeginFigure(anchor + normal * 8, true, true);
                    line.BezierTo(anchor + offset * 0.25 + normal * 5, middle - offset * 0.18 + normal * neckWidth, middle + normal * neckWidth, true, false);
                    line.BezierTo(middle + offset * 0.2 + normal * neckWidth, tip - offset * 0.08 + normal * radius, tip + normal * radius, true, false);
                    line.LineTo(tip - normal * radius, true, false);
                    line.BezierTo(tip - offset * 0.08 - normal * radius, middle + offset * 0.2 - normal * neckWidth, middle - normal * neckWidth, true, false);
                    line.BezierTo(middle - offset * 0.18 - normal * neckWidth, anchor + offset * 0.25 - normal * 5, anchor - normal * 8, true, false);
                }
                var gradient = new LinearGradientBrush {
                    MappingMode = BrushMappingMode.Absolute, StartPoint = anchor, EndPoint = tip,
                    GradientStops = new GradientStopCollection { new GradientStop(Color.FromRgb(49, 45, 55), 0), new GradientStop(Color.FromRgb(110, 42, 57), 0.42), new GradientStop(Color.FromRgb(255, 61, 78), 1) }
                };
                drawing.DrawGeometry(gradient, null, shape);
            }

            private void DrawNotch(DrawingContext drawing, Point center, double width, double open)
            {
                var left = Math.Max(4, Math.Min(pet.Width - width - 4, center.X - width / 2));
                var top = center.Y - 21;
                var geometry = new StreamGeometry();

                using (var shape = geometry.Open())
                {
                    shape.BeginFigure(new Point(left, top + 31), true, true);
                    shape.BezierTo(new Point(left + 10, top + 31), new Point(left + 10, top), new Point(left + 20, top), true, false);
                    shape.LineTo(new Point(left + width - 20, top), true, false);
                    shape.BezierTo(new Point(left + width - 10, top), new Point(left + width - 10, top + 31), new Point(left + width, top + 31), true, false);
                }

                drawing.DrawGeometry(charcoal, null, geometry);
                if (open > 0.6) drawing.DrawRoundedRectangle(new SolidColorBrush(Color.FromRgb(43, 41, 50)), null, new Rect(left + 21, top + 7, width - 42, 24), 9, 9);
            }

            private void DrawCat(DrawingContext drawing)
            {
                var width = pet.size * (1 + pet.expansion * 1.2);
                var height = pet.size * 0.86 * pet.squash * (1 - pet.expansion * 0.5);
                var top = pet.position.Y - height / 2;
                var left = pet.position.X - width / 2;
                drawing.PushTransform(new TranslateTransform(left, top));
                drawing.PushTransform(new ScaleTransform(width / 64, height / 56));

                drawing.DrawGeometry(red, null, CatBody);

                var eyeHeight = Math.Max(2, 12 * (1 - pet.blink));
                var happy = pet.expression == 2 || DateTime.UtcNow < pet.heartUntil;

                foreach (var side in new[] { -1, 1 })
                {
                    var x = 32 + side * 6 + pet.eyeX;
                    var y = 32 + pet.eyeY;

                    if (happy)
                    {
                        var smile = new StreamGeometry();
                        using (var line = smile.Open())
                        {
                            line.BeginFigure(new Point(x - 3, y + 1), false, false);
                            line.QuadraticBezierTo(new Point(x, y - 4), new Point(x + 3, y + 1), true, false);
                        }
                        drawing.DrawGeometry(null, new Pen(Brushes.White, 2.5), smile);
                    }
                    else drawing.DrawRoundedRectangle(Brushes.White, null, new Rect(x - 2.25, y - eyeHeight / 2, 4.5, eyeHeight * (pet.expression == 3 && side > 0 ? 0.6 : 1)), 2.25, 2.25);
                }

                drawing.Pop();
                drawing.Pop();
            }

            private void DrawStatus(DrawingContext drawing)
            {
                var message = new FormattedText(pet.status, CultureInfo.InvariantCulture, FlowDirection.LeftToRight, new Typeface("Segoe UI"), 11, Brushes.White, VisualTreeHelper.GetDpi(this).PixelsPerDip);
                message.MaxTextWidth = 220;
                message.MaxTextHeight = 74;
                message.Trimming = TextTrimming.CharacterEllipsis;
                var width = Math.Max(120, Math.Min(244, message.Width + 24));
                var height = Math.Min(98, message.Height + 20);
                var x = Math.Max(8, Math.Min(pet.Width - width - 8, pet.position.X - width / 2));
                var y = pet.position.Y + 38;
                if (y + height > pet.Height - 8) y = pet.position.Y - height - 38;

                drawing.DrawRoundedRectangle(charcoal, null, new Rect(x, y, width, height), 11, 11);
                drawing.DrawText(message, new Point(x + 12, y + 10));
            }
        }
    }
}
