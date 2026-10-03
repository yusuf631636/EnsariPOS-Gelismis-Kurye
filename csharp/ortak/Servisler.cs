using System;
using System.Collections.Generic;
using System.Data.SqlClient;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;

namespace Alfa
{
    // ------------------------------------------------------------------ SambaPOS SQL Server (sqlcmd yerine SqlClient)
    public static class Db
    {
        static string _cs;
        public static string Source = "";
        public static Func<string, List<object[]>> Mock;   // test: veritabanina dokunmadan
        public static void Reset() { _cs = null; }

        public static Dictionary<string, string> ParseConn(string raw)
        {
            var o = new Dictionary<string, string>();
            foreach (var part in (raw ?? "").Split(';'))
            {
                int eq = part.IndexOf('=');
                if (eq < 0) continue;
                string k = part.Substring(0, eq).Trim().ToLowerInvariant(), v = part.Substring(eq + 1).Trim();
                if (k == "data source" || k == "server") o["server"] = v;
                else if (k == "initial catalog" || k == "database") o["database"] = v;
                else if (k == "user id" || k == "uid") o["user"] = v;
                else if (k == "password" || k == "pwd") o["password"] = v;
            }
            return o;
        }
        public static Dictionary<string, string> DetectConnection(out string foundIn)
        {
            foreach (var f in new[] { @"C:\ProgramData\SambaPOS\SambaPOS5\SambaSettings.txt", @"C:\ProgramData\AlfaPOS\AlfaPOS5\AlfaSettings.txt" })
            {
                try
                {
                    if (!File.Exists(f)) continue;
                    var m = Regex.Match(File.ReadAllText(f), @"<ConnectionString>([^<]*)</ConnectionString>");
                    if (!m.Success || m.Groups[1].Value.Trim().Length == 0) continue;
                    var p = ParseConn(System.Net.WebUtility.HtmlDecode(m.Groups[1].Value));
                    if (!p.ContainsKey("server")) continue;
                    foundIn = f; return p;
                }
                catch { }
            }
            foundIn = null; return null;
        }
        static string Env(string k) { var v = Environment.GetEnvironmentVariable(k); return string.IsNullOrEmpty(v) ? null : v; }

        public static string ConnectionString
        {
            get
            {
                if (_cs != null) return _cs;
                var c = Cfg.Read();
                Dictionary<string, string> det = null; string foundIn;
                if (J.S(c, "server").Length == 0) { det = DetectConnection(out foundIn); if (det != null) Log.Write("SambaPOS bağlantısı otomatik bulundu (" + foundIn + ")"); }
                Func<string, string> dv = k => { string v; return det != null && det.TryGetValue(k, out v) && v.Length > 0 ? v : null; };
                Func<string, string> cv = k => { string v = J.S(c, k); return v.Length > 0 ? v : null; };
                string server = Env("SAMBAPOS_SQL_SERVER") ?? cv("server") ?? dv("server") ?? "localhost";
                string database = Env("SAMBAPOS_DB") ?? cv("database") ?? dv("database") ?? "SAMBAPOS5";
                string user = Env("SAMBAPOS_SQL_USER") ?? cv("user") ?? dv("user") ?? "";
                string password = Env("SAMBAPOS_SQL_PASSWORD") ?? cv("password") ?? dv("password") ?? "";
                var b = new SqlConnectionStringBuilder { DataSource = server, InitialCatalog = database, ConnectTimeout = 8, ApplicationName = "AlfaPOS", Pooling = true, TrustServerCertificate = true };
                if (user.Length > 0 && password.Length > 0) { b.UserID = user; b.Password = password; } else b.IntegratedSecurity = true;
                var opts = J.D(J.Get(c, "options"));
                b.Encrypt = opts != null && J.IsTrue(opts, "encrypt");
                Source = server + "/" + database;
                return _cs = b.ConnectionString;
            }
        }

        public static List<object[]> Query(string sql)
        {
            if (Mock != null) return Mock(sql);
            var rows = new List<object[]>();
            using (var con = new SqlConnection(ConnectionString))
            using (var cmd = new SqlCommand(sql, con))
            {
                cmd.CommandTimeout = 30;
                con.Open();
                using (var r = cmd.ExecuteReader())
                {
                    do
                    {
                        while (r.Read())
                        {
                            var row = new object[r.FieldCount];
                            r.GetValues(row);
                            for (int i = 0; i < row.Length; i++) if (row[i] is DBNull) row[i] = null;
                            rows.Add(row);
                        }
                    } while (r.NextResult());
                }
            }
            return rows;
        }
        // sqlcmd degerleri kirpilmis metin verirdi; NULL -> ""
        public static string S(object o) { return o == null ? "" : (o is bool ? ((bool)o ? "1" : "0") : Convert.ToString(o, CultureInfo.InvariantCulture).Trim()); }
        public static double N(object o) { if (o == null) return 0; try { return Convert.ToDouble(o, CultureInfo.InvariantCulture); } catch { return J.NumOr(S(o), 0); } }
        public static long I(object o) { return (long)N(o); }
        public static string Esc(object v) { return Convert.ToString(v, CultureInfo.InvariantCulture).Replace("'", "''"); }
        public static string Num(double d) { return J.NumStr(d); }
    }

    // ------------------------------------------------------------------ Bulut lisansi (license.js karsiligi, urun adiyla)
    public static class License
    {
        public static string CloudUrl = "https://app.ornek-alanadi.com";
        public static string Key = "";
        public static string Product = "";
        public static bool EmptyKeyIsLocalMode;   // Ultra: anahtar yoksa yerel test modu (Node'daki gibi)
        // Urunler arasi kucuk farklar (Gelismis Kurye'nin eski bulut sozlesmesi icin)
        public static bool HeartbeatWithProduct = true;
        public static string EmptyKeyError = "Aktivasyon anahtarı yapılandırılmamış.";
        public static string EmptyKeyVerifyError = "Aktivasyon anahtarı yapılandırılmamış.";
        public static Func<string, string, object> VerifyPayload;   // (identifier, password) -> govde
        static bool _ok; static string _error = "Lisans henüz doğrulanmadı."; static bool _everOk;
        static Timer _check, _beat;
        public static bool IsLicensed { get { return _ok; } }
        public static string Error { get { return _error; } }

        public static void Init(string product, string key, string cloudUrl, bool emptyKeyIsLocalMode)
        {
            Product = product; Key = (key ?? "").Trim(); EmptyKeyIsLocalMode = emptyKeyIsLocalMode;
            CloudUrl = string.IsNullOrEmpty(cloudUrl) ? "https://app.ornek-alanadi.com" : cloudUrl.TrimEnd('/');
            CheckOnce();
            _check = new Timer(_ => CheckOnce(), null, 30 * 60 * 1000, 30 * 60 * 1000);
            _beat = new Timer(_ => Heartbeat(), null, 0, 60 * 1000);
        }
        public static void CheckOnce()
        {
            if (Key.Length == 0)
            {
                if (EmptyKeyIsLocalMode) { _ok = true; _everOk = true; _error = null; }
                else { _ok = false; _error = EmptyKeyError; }
                return;
            }
            try
            {
                var r = Web.Get(CloudUrl + "/api/agent/license-check?key=" + Uri.EscapeDataString(Key) + "&product=" + Product, 10000);
                Dictionary<string, object> j;
                try { j = J.D(J.Parse(r.Text)); } catch { j = null; }
                if (j == null) throw new Exception("Lisans sunucusundan geçersiz yanıt.");
                if (J.Truthy(J.Get(j, "ok"))) { _ok = true; _error = null; _everOk = true; }
                else { _ok = false; _error = J.S(j, "error").Length > 0 ? J.S(j, "error") : "Lisans doğrulanamadı."; }
            }
            catch { if (!_everOk) { _ok = false; _error = "Lisans sunucusuna erişilemedi. İnternet bağlantınızı kontrol edin."; } }
        }
        static void Heartbeat()
        {
            if (Key.Length == 0) return;
            try { Web.PostJson(CloudUrl + "/api/agent/heartbeat", HeartbeatWithProduct ? J.Obj("activationKey", Key, "product", Product) : J.Obj("activationKey", Key), 10000); } catch { }
        }
        public static Dictionary<string, object> VerifyPassword(string identifier, string password)
        {
            if (Key.Length == 0) return EmptyKeyIsLocalMode ? J.Obj("ok", true) : J.Obj("ok", false, "error", EmptyKeyVerifyError);
            try
            {
                object payload = VerifyPayload != null ? VerifyPayload(identifier, password) : J.Obj("key", Key, "product", Product, "identifier", identifier, "password", password);
                var j = J.D(J.Parse(Web.PostJson(CloudUrl + "/api/agent/verify-password", payload, 10000).Text));
                if (j == null) throw new Exception();
                return j;
            }
            catch { return J.Obj("ok", false, "error", "Lisans sunucusuna erişilemedi. İnternet bağlantınızı kontrol edin."); }
        }
    }

    // ------------------------------------------------------------------ Otomatik guncelleme (C# kanali: <bulut>/<kanal>/version.json + f/<sha256>.bin)
    public static class Updater
    {
        public static string Root, Channel, DefaultVersion = "0.0.0";
        public static string[] Never = { "config.json" };
        static readonly Regex SafePath = new Regex(@"^(?:[a-zA-Z0-9_-]+/){0,3}[a-zA-Z0-9_.-]+\.(?:html|css|json|webmanifest|js|png|ico|txt|exe|dll)$");
        static int _running; static Timer _t;

        public static string LocalVersion()
        {
            try { string v = File.ReadAllText(Path.Combine(Root, "surum.txt")).Trim(); if (v.Length > 0) return v; } catch { }
            return DefaultVersion;
        }
        static int[] Ver(string v) { return (v ?? "0").Split('.').Select(n => { int x; return int.TryParse(n, out x) ? x : 0; }).ToArray(); }
        public static bool IsNewer(string remote, string local)
        {
            var r = Ver(remote); var l = Ver(local);
            for (int i = 0; i < Math.Max(r.Length, l.Length); i++) { int rv = i < r.Length ? r[i] : 0, lv = i < l.Length ? l[i] : 0; if (rv != lv) return rv > lv; }
            return false;
        }
        static void L(string m) { Log.Write("[guncelleme] " + m); }

        public static void Start(bool now)
        {
            try { foreach (var f in Directory.GetFiles(Root, "*.old", SearchOption.AllDirectories)) File.Delete(f); } catch { }
            _t = new Timer(_ => RunCheck(), null, now ? 1000 : 5 * 60 * 1000, 60 * 60 * 1000);
        }

        public static void RunCheck()
        {
            if (Interlocked.Exchange(ref _running, 1) == 1) return;
            string staging = null;
            try
            {
                string bas = License.CloudUrl + "/" + Channel;
                Dictionary<string, object> man;
                try { var r = Web.Get(bas + "/version.json?t=" + J.NowMs(), 30000); if (!r.Ok) throw new Exception("HTTP " + r.Status); man = J.D(J.Parse(r.Text)); }
                catch (Exception ex) { L("surum bilgisi alinamadi, atlaniyor: " + ex.Message); return; }
                if (man == null) return;
                string remote = J.S(man, "version");
                var files = J.LL(J.Get(man, "files")).Select(J.D).Where(f => f != null && SafePath.IsMatch(J.S(f, "path")) && !J.S(f, "path").Contains("..")
                    && !Never.Contains(J.S(f, "path")) && Regex.IsMatch(J.S(f, "sha256"), "^[a-f0-9]{64}$")).ToList();
                string local = LocalVersion();
                if (remote.Length == 0 || files.Count == 0) { L("manifesto bos/gecersiz, atlaniyor."); return; }
                if (!IsNewer(remote, local)) return;
                L("yeni surum: " + local + " -> " + remote + ", " + files.Count + " dosya indiriliyor...");
                staging = Path.Combine(Path.GetTempPath(), "alfa-update-" + Crypto.RandomHex(6));
                foreach (var f in files)
                {
                    var r = Web.Get(bas + "/f/" + J.S(f, "sha256") + ".bin", 60000);
                    if (!r.Ok) throw new Exception("HTTP " + r.Status + " (" + J.S(f, "path") + ")");
                    if (Crypto.Sha256Hex(r.Body) != J.S(f, "sha256")) throw new Exception(J.S(f, "path") + " parmak izi uyusmuyor - indirme bozuk, iptal.");
                    string dest = Path.Combine(staging, J.S(f, "path").Replace('/', '\\'));
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    File.WriteAllBytes(dest, r.Body);
                }
                string backup = Path.Combine(Root, "update-backup", local);
                string exeName = Path.GetFileName(System.Reflection.Assembly.GetEntryAssembly().Location);
                bool restart = false;
                foreach (var f in files)
                {
                    string rel = J.S(f, "path").Replace('/', '\\');
                    string live = Path.Combine(Root, rel), src = Path.Combine(staging, rel);
                    if (File.Exists(live)) { string b = Path.Combine(backup, rel); Directory.CreateDirectory(Path.GetDirectoryName(b)); File.Copy(live, b, true); }
                    Directory.CreateDirectory(Path.GetDirectoryName(live));
                    if (rel.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || rel.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
                    {
                        // calisan program/kutuphane: yeniden adlandir (Windows izin verir), yenisini koy
                        if (File.Exists(live)) { string old = live + ".old"; if (File.Exists(old)) File.Delete(old); File.Move(live, old); }
                        File.Copy(src, live, true);
                        restart = true;
                    }
                    else File.Copy(src, live, true);
                }
                Files.Write(Path.Combine(Root, "surum.txt"), remote);
                L("guncelleme basarili: " + local + " -> " + remote + (restart ? ". Servis yeniden baslatiliyor..." : "."));
                if (restart) new Thread(() => { Thread.Sleep(800); Environment.Exit(3); }) { IsBackground = true }.Start();
            }
            catch (Exception ex) { L("guncelleme basarisiz, MEVCUT SURUM DEGISTIRILMEDI: " + ex.Message); }
            finally
            {
                if (staging != null) { try { Directory.Delete(staging, true); } catch { } }
                Interlocked.Exchange(ref _running, 0);
            }
        }
    }
}
