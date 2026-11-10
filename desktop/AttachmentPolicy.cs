using System;

namespace OrbitDesktop
{
    internal static class AttachmentPolicy
    {
        internal static bool HoverReady(bool overCat, bool eligible)
        {
            return overCat && eligible;
        }

        internal static bool CanRestoreAttachment(bool wasDocked, bool exists, bool visible, bool minimized, uint savedProcess, uint currentProcess)
        {
            return wasDocked && exists && visible && !minimized && savedProcess != 0 && savedProcess == currentProcess;
        }

        internal static bool HideCovered(bool docked, bool covered, bool dragging, bool focused, bool captured)
        {
            return docked && covered && !dragging && !focused && !captured;
        }

        internal static bool CanSend(bool sending, string text)
        {
            return !sending && !String.IsNullOrWhiteSpace(text);
        }

        internal static double ExpansionOnOpen(bool focus, double current)
        {
            return focus ? 1 : current;
        }

        internal static string RestoreDraft(string current, string attempted)
        {
            return String.IsNullOrEmpty(current) ? attempted : current;
        }
    }
}
