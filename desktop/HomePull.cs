using System;
using System.Windows;

namespace OrbitDesktop
{
    internal sealed class HomePull
    {
        internal const double DetachDistance = 180;
        internal Point Anchor;
        internal bool Parked = true;
        internal bool FromHome;
        internal bool Detached;
        internal bool Returning;
        internal Vector Recoil;
        internal double Bend;

        internal bool Hit(Point point)
        {
            var offset = point - Anchor;
            return offset.X * offset.X / 225 + offset.Y * offset.Y / 169 <= 1;
        }

        internal void Begin(bool fromHome)
        {
            FromHome = fromHome;
            Detached = false;
            Returning = false;
            Bend = 0;
        }

        internal bool Stretch(Vector offset)
        {
            if (Detached || offset.Length <= DetachDistance) return false;
            Detached = true;
            if (FromHome) Recoil = offset * 0.38;
            return true;
        }

        internal bool ReturnOnDrop(Point point)
        {
            return (FromHome && !Detached) || (point - Anchor).Length <= 34;
        }

        internal void Park()
        {
            Parked = true;
            Returning = false;
            Detached = false;
            FromHome = false;
        }

        internal void Tick()
        {
            Recoil *= 0.64;
            Bend *= 0.82;
        }
    }
}
