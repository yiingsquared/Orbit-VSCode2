using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace OrbitDesktop
{
    internal static class InstallBootstrap
    {
        internal const string Marker = "ORBIT_INSTALL_V1";
        internal static readonly string DefaultGrantPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Orbit", "companion.json.bootstrap");

        internal static bool ValidAddress(string address)
        {
            Uri parsed;
            return Regex.IsMatch(address ?? "", @"\Ahttp://127\.0\.0\.1:(431[0-9]|4320)/?\z")
                && Uri.TryCreate(address, UriKind.Absolute, out parsed) && parsed.Scheme == "http"
                && parsed.Host == "127.0.0.1" && parsed.Port >= 4310 && parsed.Port <= 4320
                && (parsed.AbsolutePath == "/" || parsed.AbsolutePath == "") && String.IsNullOrEmpty(parsed.Query)
                && String.IsNullOrEmpty(parsed.Fragment) && String.IsNullOrEmpty(parsed.UserInfo);
        }

        // Local protocol boundary

        internal static bool TryParseLaunch(string value, out Dictionary<string, object> grant)
        {
            grant = null;
            Uri launch;
            if (String.IsNullOrEmpty(value) || value.Length > 2048 || !Uri.TryCreate(value, UriKind.Absolute, out launch)
                || launch.Scheme != "orbit-companion" || launch.Host != "launch" || launch.Port != -1
                || !String.IsNullOrEmpty(launch.UserInfo) || !String.IsNullOrEmpty(launch.Fragment)
                || (launch.AbsolutePath != "" && launch.AbsolutePath != "/")) return false;

            var fields = new Dictionary<string, object>(StringComparer.Ordinal);
            try
            {
                foreach (var pair in launch.Query.TrimStart('?').Split('&'))
                {
                    var separator = pair.IndexOf('=');
                    if (separator < 1) return false;
                    var name = pair.Substring(0, separator);
                    if ((name != "baseUrl" && name != "ticket") || fields.ContainsKey(name)) return false;
                    fields.Add(name, Uri.UnescapeDataString(pair.Substring(separator + 1)));
                }
            }
            catch { return false; }
            if (fields.Count != 2 || !ValidGrant(fields)) return false;
            grant = fields;
            return true;
        }

        private static bool ValidGrant(Dictionary<string, object> grant)
        {
            return ValidAddress(BridgeText(grant, "baseUrl")) && Regex.IsMatch(BridgeText(grant, "ticket") ?? "", @"\A[A-Za-z0-9_-]{43}\z");
        }

        private static string BridgeText(Dictionary<string, object> data, string key)
        {
            object value;
            return data != null && data.TryGetValue(key, out value) && value is string ? (string)value : null;
        }

        // One-use grant appended by Orbit

        internal static Dictionary<string, object> ReadExecutable(string filename)
        {
            try
            {
                using (var file = File.OpenRead(filename))
                using (var reader = new BinaryReader(file))
                {
                    var marker = Encoding.ASCII.GetBytes(Marker);
                    if (file.Length < marker.Length + 4) return null;
                    file.Position = file.Length - marker.Length;
                    if (Encoding.ASCII.GetString(reader.ReadBytes(marker.Length)) != Marker) return null;
                    file.Position = file.Length - marker.Length - 4;
                    var length = reader.ReadUInt32();
                    if (length == 0 || length > 2048 || length > file.Length - marker.Length - 4) return null;
                    file.Position -= 4 + length;
                    var grant = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(reader.ReadBytes((int)length)));
                    return ValidGrant(grant) ? grant : null;
                }
            }
            catch { return null; }
        }

        // Windows account protection

        internal static void Save(string filename, Dictionary<string, object> grant)
        {
            if (!ValidGrant(grant)) throw new InvalidOperationException("Invalid Orbit installation grant");
            var data = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(grant));
            var encrypted = ProtectedData.Protect(data, null, DataProtectionScope.CurrentUser);
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(filename)));
            WithFileLock(filename, delegate
            {
                var temporary = filename + "." + Guid.NewGuid().ToString("N") + ".tmp";
                try
                {
                    File.WriteAllBytes(temporary, encrypted);
                    if (File.Exists(filename)) File.Replace(temporary, filename, null);
                    else File.Move(temporary, filename);
                }
                finally { if (File.Exists(temporary)) File.Delete(temporary); }
            });
        }

        internal static Dictionary<string, object> Load(string filename)
        {
            try
            {
                var encrypted = File.ReadAllBytes(filename);
                if (encrypted.Length > 8192) return null;
                var data = ProtectedData.Unprotect(encrypted, null, DataProtectionScope.CurrentUser);
                var grant = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(data));
                return ValidGrant(grant) ? grant : null;
            }
            catch { return null; }
        }

        internal static void Remove(string filename, Dictionary<string, object> consumed = null)
        {
            WithFileLock(filename, delegate
            {
                var latest = Load(filename);
                if (consumed != null && (latest == null || BridgeText(latest, "baseUrl") != BridgeText(consumed, "baseUrl")
                    || BridgeText(latest, "ticket") != BridgeText(consumed, "ticket"))) return;
                if (File.Exists(filename)) File.Delete(filename);
            });
        }

        private static void WithFileLock(string filename, Action action)
        {
            string name;
            using (var hash = SHA256.Create()) name = Convert.ToBase64String(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(filename).ToUpperInvariant()))).Replace('/', '_').Replace('+', '-');
            using (var mutex = new System.Threading.Mutex(false, "Local\\OrbitCompanion.Bootstrap." + name))
            {
                bool held = false;
                try
                {
                    try { held = mutex.WaitOne(TimeSpan.FromSeconds(5)); }
                    catch (System.Threading.AbandonedMutexException) { held = true; }
                    if (!held) throw new IOException("Orbit activation is busy");
                    action();
                }
                finally { if (held) mutex.ReleaseMutex(); }
            }
        }
    }
}
