using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Windows.Automation;

namespace OrbitDesktop
{
    internal static class ContextReader
    {
        internal const int TextLimit = 16000;

        internal static bool RefreshRequired(bool force, bool sameText, TimeSpan elapsed)
        {
            return force || !sameText || elapsed.TotalSeconds >= 4;
        }

        internal static string Read(IntPtr target)
        {
            if (target == IntPtr.Zero || Native.IsOurs(target) || !Native.IsWindowVisible(target) || Native.IsIconic(target)) return "";

            try
            {
                var root = AutomationElement.FromHandle(target);
                if (root == null) return "";

                if (Native.IsBrowser(target))
                {
                    var document = root.FindFirst(TreeScope.Descendants, new AndCondition(
                        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document),
                        new PropertyCondition(AutomationElement.IsOffscreenProperty, false)));

                    if (document == null) return "";
                    root = document;
                }

                object pattern;

                if (!root.Current.IsPassword && root.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
                {
                    return Clean(((TextPattern)pattern).DocumentRange.GetText(TextLimit));
                }

                var text = new StringBuilder();
                var seen = new HashSet<string>();
                var timer = Stopwatch.StartNew();
                int count = 0;

                Walk(root, text, seen, timer, ref count, 0);
                return Clean(text.ToString());
            }
            catch { return ""; }
        }

        private static void Walk(AutomationElement node, StringBuilder text, HashSet<string> seen, Stopwatch timer, ref int count, int depth)
        {
            if (node == null || count++ > 500 || depth > 14 || timer.ElapsedMilliseconds > 500 || text.Length >= TextLimit) return;

            try
            {
                var current = node.Current;

                if (current.IsOffscreen || current.IsPassword) return;

                object pattern;
                string value = current.Name;

                if (node.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) value = ((ValuePattern)pattern).Current.Value;
                else if (node.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) value = ((TextPattern)pattern).DocumentRange.GetText(TextLimit - text.Length);

                if (!String.IsNullOrWhiteSpace(value) && seen.Add(value))
                {
                    if (text.Length > 0) text.AppendLine();
                    text.Append(value.Substring(0, Math.Min(value.Length, TextLimit - text.Length)));
                }

                var child = TreeWalker.ControlViewWalker.GetFirstChild(node);

                while (child != null && text.Length < TextLimit && timer.ElapsedMilliseconds <= 500)
                {
                    Walk(child, text, seen, timer, ref count, depth + 1);
                    child = TreeWalker.ControlViewWalker.GetNextSibling(child);
                }
            }
            catch { }
        }

        internal static string Clean(string value)
        {
            if (String.IsNullOrWhiteSpace(value)) return "";

            value = value.Replace("\0", "").Trim();
            return value.Substring(0, Math.Min(value.Length, TextLimit));
        }
    }
}
