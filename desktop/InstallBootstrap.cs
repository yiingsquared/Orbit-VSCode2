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
            return Uri.TryCreate(address, UriKind.Absolute, out parsed) && parsed.Scheme == "http"
                && parsed.Host == "127.0.0.1" && parsed.Port >= 4310 && parsed.Port <= 4320
                && (parsed.AbsolutePath == "/" || parsed.AbsolutePath == "") && String.IsNullOrEmpty(parsed.Query)
                && String.IsNullOrEmpty(parsed.Fragment) && String.IsNullOrEmpty(parsed.UserInfo);
        }

        private static bool ValidGrant(Dictionary<string, object> grant)
        {
            return ValidAddress(BridgeText(grant, "baseUrl")) && Regex.IsMatch(BridgeText(grant, "ticket") ?? "", @"^[A-Za-z0-9_-]{43}$");
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
            var temporary = filename + ".tmp";
            File.WriteAllBytes(temporary, encrypted);
            if (File.Exists(filename)) File.Replace(temporary, filename, null);
            else File.Move(temporary, filename);
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
    }
}
