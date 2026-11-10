using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace OrbitDesktop
{
    internal sealed class BridgeRequestException : InvalidOperationException
    {
        internal readonly int Status;
        internal BridgeRequestException(int status, string message) : base(message) { Status = status; }
    }

    internal sealed class BridgeClient : IDisposable
    {
        private readonly HttpClient http;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer();
        private readonly string configPath;
        private string token;
        internal string BaseUrl { get; private set; }
        internal bool Configured { get { return !String.IsNullOrEmpty(token); } }

        internal static readonly string ConfigPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Orbit", "companion.json");

        internal BridgeClient(bool loadConfiguration = true, string configurationPath = null)
        {
            configPath = configurationPath ?? ConfigPath;
            http = new HttpClient(new HttpClientHandler { UseProxy = false });
            http.Timeout = TimeSpan.FromSeconds(8);
            if (loadConfiguration) Load();
        }

        internal static bool TryPairAddress(string code, out string address)
        {
            address = null;
            var match = Regex.Match((code ?? "").Trim(), @"^(431[0-9]|4320)-[0-9]{8}$");

            if (!match.Success) return false;

            address = "http://127.0.0.1:" + match.Groups[1].Value;
            return true;
        }

        private static bool ValidAddress(string address)
        {
            return InstallBootstrap.ValidAddress(address);
        }

        private void Load()
        {
            try
            {
                var config = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(configPath));
                var address = Text(config, "baseUrl");
                var encrypted = Text(config, "tokenProtected");

                if (!ValidAddress(address) || String.IsNullOrEmpty(encrypted)) return;

                token = Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(encrypted), null, DataProtectionScope.CurrentUser));
                BaseUrl = address.TrimEnd('/');
            }
            catch { token = null; }
        }

        private void Save()
        {
            var directory = Path.GetDirectoryName(configPath);
            Directory.CreateDirectory(directory);

            var protectedToken = Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(token), null, DataProtectionScope.CurrentUser));
            var data = new Dictionary<string, object> { { "baseUrl", BaseUrl }, { "tokenProtected", protectedToken } };
            var temporary = configPath + ".tmp";

            File.WriteAllText(temporary, json.Serialize(data), Encoding.UTF8);

            if (File.Exists(configPath)) File.Replace(temporary, configPath, null);
            else File.Move(temporary, configPath);
        }

        internal async Task Pair(string code)
        {
            string address;
            if (!TryPairAddress(code, out address)) throw new InvalidOperationException("Enter the pairing code shown in Orbit, for example 4310-12345678");

            var body = json.Serialize(new { code = code.Trim(), kind = "desktop", name = "Orbit for Windows" });
            using (var response = await http.PostAsync(address + "/api/companion/pair", new StringContent(body, Encoding.UTF8, "application/json")))
            {
                var data = json.Deserialize<Dictionary<string, object>>(await response.Content.ReadAsStringAsync());

                if (!response.IsSuccessStatusCode) throw new InvalidOperationException(Text(data, "message") ?? "Pairing failed. Generate a new code in Orbit");

                var nextToken = Text(data, "token");
                var returnedAddress = Text(data, "baseUrl");

                if (String.IsNullOrWhiteSpace(nextToken) || nextToken.Length > 512 || !ValidAddress(returnedAddress)
                    || !String.Equals(address, returnedAddress.TrimEnd('/'), StringComparison.Ordinal)) throw new InvalidOperationException("The local server returned an invalid pairing response");

                token = nextToken;
                BaseUrl = returnedAddress.TrimEnd('/');
                Save();
            }
        }

        // Automatic installation handoff

        internal async Task<bool> ActivateInstall()
        {
            var grantPath = configPath + ".bootstrap";
            var grant = InstallBootstrap.Load(grantPath);
            if (grant == null) return false;
            var address = Text(grant, "baseUrl").TrimEnd('/');

            using (var response = await http.PostAsync(address + "/api/companion/activate", new StringContent(json.Serialize(new { ticket = Text(grant, "ticket"), name = "Orbit for Windows" }), Encoding.UTF8, "application/json")))
            {
                var data = json.Deserialize<Dictionary<string, object>>(await response.Content.ReadAsStringAsync());
                if (!response.IsSuccessStatusCode)
                {
                    if ((int)response.StatusCode == 401) File.Delete(grantPath);
                    throw new BridgeRequestException((int)response.StatusCode, Text(data, "message") ?? "Run the installer downloaded from Orbit again");
                }
                var nextToken = Text(data, "token");
                var returnedAddress = Text(data, "baseUrl");
                if (!Regex.IsMatch(nextToken ?? "", @"^[A-Za-z0-9_-]{43}$") || !ValidAddress(returnedAddress)
                    || !String.Equals(address, returnedAddress.TrimEnd('/'), StringComparison.Ordinal)) throw new InvalidOperationException("Invalid Orbit activation response");
                token = nextToken;
                BaseUrl = address;
                Save();
                File.Delete(grantPath);
                return true;
            }
        }

        internal void ApplyControl(Dictionary<string, object> state)
        {
            var command = Control(state);
            if (command == null) return;
            object reconnect;
            if (command == "quit" && state.TryGetValue("reconnect", out reconnect) && reconnect is Dictionary<string, object>)
                InstallBootstrap.Save(configPath + ".bootstrap", (Dictionary<string, object>)reconnect);
            Forget();
        }

        internal async Task<Dictionary<string, object>> Request(string route, object payload = null)
        {
            if (!Configured) throw new InvalidOperationException("Pair Orbit from Get Started first");

            using (var request = new HttpRequestMessage(payload == null ? HttpMethod.Get : HttpMethod.Post, BaseUrl + route))
            {
                request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);

                if (payload != null) request.Content = new StringContent(json.Serialize(payload), Encoding.UTF8, "application/json");

                using (var response = await http.SendAsync(request))
                {
                    var text = await response.Content.ReadAsStringAsync();
                    var data = json.Deserialize<Dictionary<string, object>>(text);

                    if (!response.IsSuccessStatusCode) throw new BridgeRequestException((int)response.StatusCode, Text(data, "message") ?? "Orbit could not receive this request");
                    return data;
                }
            }
        }

        // Local disconnect cleanup

        internal void Forget()
        {
            token = null;
            try { if (File.Exists(configPath)) File.Delete(configPath); }
            catch { }
        }

        internal static string Control(Dictionary<string, object> state)
        {
            var command = Text(state, "command");
            return !Flag(state, "paired") && (command == "quit" || command == "disconnect") ? command : null;
        }

        internal static string Text(Dictionary<string, object> data, string key)
        {
            object value;
            return data != null && data.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : null;
        }

        internal static bool Flag(Dictionary<string, object> data, string key)
        {
            object value;
            return data != null && data.TryGetValue(key, out value) && value is bool && (bool)value;
        }

        public void Dispose() { http.Dispose(); }
    }
}
