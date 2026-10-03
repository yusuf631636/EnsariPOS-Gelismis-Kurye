// Gelişmiş Kurye Sistemi - C# SÜRÜM (30.09.2026, kullanici istegi: "tek tek tum projeleri C#'a cevirelim").
// server.js + sambapos.js + auth.js + db.js + ws.js + license.js + tunnel.js karsiligi. Ayni config.json, ayni SQLite
// veritabani (data/gelismis-kurye.db), ayni HTTP uclari ve sayfalar (public/).
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.ServiceProcess;
using System.Text.RegularExpressions;
using System.Threading;
using Alfa;

[assembly: System.Reflection.AssemblyTitle("Gelişmiş Kurye Sistemi Sunucusu")]
[assembly: System.Reflection.AssemblyProduct("AlfaPOS Gelişmiş Kurye Sistemi")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]

namespace GKurye
{
    public static class Program
    {
        public const string ServiceName = "GelismisKuryeSistemi";
        public static Dictionary<string, string> Opts = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public static string Opt(string k) { string v; return Opts.TryGetValue(k, out v) && v.Length > 0 ? v : null; }

        public static void Main(string[] args)
        {
            foreach (var a in args) { string s = a.TrimStart('/', '-'); int i = s.IndexOf(':'); if (i > 0) Opts[s.Substring(0, i)] = s.Substring(i + 1); else Opts[s] = ""; }
            if (Opts.ContainsKey("sqltest")) { SqlTest.Run(Opt("sqltest")); return; }
            if (!(Opts.ContainsKey("console") || Environment.UserInteractive)) { ServiceBase.Run(new Svc()); return; }
            try { App.Start(); } catch (Exception ex) { Console.WriteLine("BASLATILAMADI: " + ex); Environment.ExitCode = 1; return; }
            Console.WriteLine("Gelişmiş Kurye (konsol) http://127.0.0.1:" + App.Port + "  - Ctrl+C ile durdurun");
            Thread.Sleep(Timeout.Infinite);
        }
    }

    public class Svc : ServiceBase
    {
        public Svc() { ServiceName = Program.ServiceName; CanStop = true; CanShutdown = true; }
        protected override void OnStart(string[] args) { App.Start(); }
        protected override void OnStop() { App.Stop(); }
        protected override void OnShutdown() { App.Stop(); }
    }

    public static class App
    {
        public const string Version = "1.0.0";
        const string AppName = "Gelişmiş Kurye Sistemi";
        public static string Root;
        public static int Port = 4090;
        static LocalHost _host;

        public static void Start()
        {
            Web.Init();
            Root = Path.GetFullPath(Program.Opt("root") ?? AppDomain.CurrentDomain.BaseDirectory).TrimEnd('\\');
            Log.Init(Program.Opt("logs") ?? Path.Combine(Root, "logs"));
            Cfg.PathFile = Path.Combine(Root, "config.json");
            var c = Cfg.Read();
            int p;
            Port = int.TryParse(Program.Opt("port"), out p) ? p : (int)J.NumOr(J.Get(c, "port"), 4090);
            Store.Open(Root);
            string key = J.S(c, "gkActivationKey").Trim(); if (key.Length == 0) key = J.S(c, "activationKey").Trim();
            // Gelismis Kurye'nin bulut sozlesmesi: nabizda urun adi yok, sifre dogrulamada "gkKey" alani
            License.HeartbeatWithProduct = false;
            License.EmptyKeyError = "config.json içinde gkActivationKey eksik. Admin panelden Gelişmiş Kurye anahtarınızı alıp config.json'a ekleyin.";
            License.EmptyKeyVerifyError = "config.json içinde gkActivationKey eksik.";
            License.VerifyPayload = (id, pw) => J.Obj("gkKey", License.Key, "identifier", id, "password", pw);
            License.Init("gelismis_kurye", key, J.S(c, "cloudServerUrl"), false);
            string bind = J.S(c, "bindHost");
            _host = new LocalHost(Port, Handle, bind.Length > 0 ? bind : null) { Upgrade = WsUpgrade };
            _host.Start();
            Log.Write(AppName + " (C#) " + UpdaterVersion() + ": http://127.0.0.1:" + Port + "  (kurye: /courier, restoran: /restoran)  klasör: " + Root);
            if (!Program.Opts.ContainsKey("notunnel")) Tunnel.Start(Handle, License.CloudUrl, "/gk-tunnel", License.Key);
            Updater.Root = Root; Updater.Channel = "gk-cs-update"; Updater.DefaultVersion = Version;
            Updater.Never = new[] { "config.json", "data/gelismis-kurye.db" };
            if (!Program.Opts.ContainsKey("noupdate")) Updater.Start(Program.Opts.ContainsKey("updatenow"));
            ThreadPool.QueueUserWorkItem(delegate { try { Db.Query("SELECT 1"); Log.Write("SQL bağlantısı hazır: " + Db.Source); } catch (Exception ex) { Log.Write("UYARI - SQL'e bağlanılamadı: " + ex.Message); } });
        }
        static string UpdaterVersion() { try { string v = File.ReadAllText(Path.Combine(Root, "surum.txt")).Trim(); if (v.Length > 0) return v; } catch { } return Version; }
        public static void Stop() { try { Tunnel.Stop(); _host.Stop(); } catch { } Log.Write(AppName + " durduruldu."); }

        static readonly List<object> _wsClients = new List<object>();
        static bool WsUpgrade(HttpListenerContext ctx) { return WsServer.Accept(ctx, _wsClients); }
        static void Broadcast(Dictionary<string, object> ev) { WsServer.Broadcast(_wsClients, J.Str(ev)); }

        // ---- oturum (auth.js - Ultra ile ayni)
        const long SessionTtl = 180L * 24 * 60 * 60 * 1000;
        static readonly Dictionary<string, string> CookieNames = new Dictionary<string, string> { { "admin", "gks_admin_session" }, { "courier", "gks_courier_session" } };
        class Lk { public int Count; public long Until; }
        static readonly ConcurrentDictionary<string, Lk> _attempts = new ConcurrentDictionary<string, Lk>();
        static long LockedMs(string ip) { Lk s; return _attempts.TryGetValue(ip, out s) && s.Until > J.NowMs() ? s.Until - J.NowMs() : 0; }
        static void Fail(string ip) { var s = _attempts.GetOrAdd(ip, _ => new Lk()); lock (s) { s.Count++; if (s.Count >= 5) { s.Until = J.NowMs() + 5 * 60 * 1000; s.Count = 0; } } }
        static void Success(string ip) { Lk s; _attempts.TryRemove(ip, out s); }
        static string ClientIp(Req req) { string xf = req.Header("x-forwarded-for"); return (string.IsNullOrEmpty(xf) ? req.RemoteIp : xf).Split(',')[0].Trim(); }
        static bool IsHttps(Req req) { return req.Header("x-forwarded-proto") == "https"; }
        static void SetSessionCookie(Req req, Res res, string token, string role)
        {
            string v = CookieNames[role] + "=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + (SessionTtl / 1000);
            res.SetHeader("Set-Cookie", IsHttps(req) ? v + "; Secure" : v);
        }
        static void ClearSessionCookie(Req req, Res res)
        {
            res.Headers.RemoveAll(h => h.Key.Equals("Set-Cookie", StringComparison.OrdinalIgnoreCase));
            foreach (var n in CookieNames.Values) res.AddHeader("Set-Cookie", n + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + (IsHttps(req) ? "; Secure" : ""));
        }
        static string NewSession(string role, object courierId, object courierName)
        {
            string token = Crypto.RandomHex(24);
            Store.SaveSession(token, role, courierId, courierName, J.NowMs() + SessionTtl);
            return token;
        }
        static Dictionary<string, object> CurrentSession(Req req, string role)
        {
            foreach (var r in role != null ? new[] { role } : new[] { "admin", "courier" })
            {
                string token = req.Cookie(CookieNames[r]);
                if (string.IsNullOrEmpty(token)) continue;
                var rec = Store.LoadSession(token);
                if (rec == null) continue;
                if (J.Num(rec, "expires") < J.NowMs()) { Store.DeleteSession(token); continue; }
                long exp = J.NowMs() + SessionTtl;
                Store.TouchSession(token, exp);
                rec["expires"] = exp;
                return rec;
            }
            return null;
        }
        static void DestroySession(Req req) { foreach (var r in new[] { "admin", "courier" }) { string t = req.Cookie(CookieNames[r]); if (!string.IsNullOrEmpty(t)) Store.DeleteSession(t); } }

        static Dictionary<string, object> Err(string m) { return J.Obj("error", m); }
        static string[] DayRangeUtc(string day)
        {
            var start = DateTime.ParseExact(day, "yyyy-MM-dd", J.Inv, System.Globalization.DateTimeStyles.AssumeLocal).ToUniversalTime();
            return new[] { start.ToString("yyyy-MM-dd HH:mm:ss", J.Inv), start.AddHours(24).ToString("yyyy-MM-dd HH:mm:ss", J.Inv) };
        }
        static string DayParam(Req req) { string d = req.Q("date") ?? ""; return Regex.IsMatch(d, @"^\d{4}-\d{2}-\d{2}$") ? d : DateTime.UtcNow.ToString("yyyy-MM-dd", J.Inv); }
        static bool OwnsOrder(Dictionary<string, object> s, Dictionary<string, object> o) { return J.S(s, "role") == "admin" || (J.S(s, "role") == "courier" && J.S(o, "courierName") == J.S(s, "courierName")); }
        static readonly Dictionary<string, string> Types = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
            { ".html", "text/html; charset=utf-8" }, { ".css", "text/css; charset=utf-8" }, { ".js", "text/javascript; charset=utf-8" }, { ".json", "application/json; charset=utf-8" },
            { ".webmanifest", "application/manifest+json; charset=utf-8" }, { ".png", "image/png" }, { ".ico", "image/x-icon" } };
        static void ServeStatic(Res res, string pathname)
        {
            var map = new Dictionary<string, string> { { "/courier", "/courier/index.html" }, { "/restoran", "/restoran/index.html" }, { "/", "/courier/index.html" } };
            string mapped; string rel = map.TryGetValue(pathname, out mapped) ? mapped : pathname;
            string pub = Path.Combine(Root, "public");
            string file;
            try { file = Path.GetFullPath(Path.Combine(pub, Uri.UnescapeDataString(rel).TrimStart('/').Replace('/', '\\'))); } catch { res.Json(404, Err("Bulunamadı")); return; }
            if (!file.StartsWith(pub + "\\", StringComparison.OrdinalIgnoreCase) || !File.Exists(file)) { res.Json(404, Err("Bulunamadı")); return; }
            string t; if (!Types.TryGetValue(Path.GetExtension(file), out t)) t = "application/octet-stream";
            res.Send(200, t, File.ReadAllBytes(file), "no-store");
        }

        public static void Handle(Req req, Res res)
        {
            try { Route(req, res); }
            catch (Exception ex) { Log.Write("HATA " + req.Method + " " + req.Path + ": " + ex.Message); res.Headers.Clear(); res.Body.SetLength(0); res.Json(500, Err(ex.Message)); }
        }

        static void Route(Req req, Res res)
        {
            string path = req.Path, m = req.Method;
            bool GET = m == "GET", POST = m == "POST";
            string ip = ClientIp(req);
            Match mt;
            if (path.StartsWith("/api/") && path != "/api/config" && !License.IsLicensed) { res.Json(403, Err(License.Error ?? "Bu kurulumun lisansı aktif değil. AlfaPOS ile iletişime geçin.")); return; }

            if (path == "/api/courier/login" && POST)
            {
                long wait = LockedMs(ip);
                if (wait > 0) { res.Json(429, Err("Çok fazla hatalı deneme. " + (long)Math.Ceiling(wait / 1000.0) + " saniye sonra tekrar deneyin.")); return; }
                var courier = Samba.CourierByPin(J.S(req.JsonBody(), "pin"));
                if (courier == null) { Fail(ip); res.Json(401, Err("PIN hatalı.")); return; }
                Success(ip);
                SetSessionCookie(req, res, NewSession("courier", courier["id"], courier["name"]), "courier");
                res.Json(200, J.Obj("ok", true, "courierName", courier["name"]));
                return;
            }
            if (path == "/api/admin/login-step1" && POST)
            {
                long wait = LockedMs(ip);
                if (wait > 0) { res.Json(429, Err("Çok fazla hatalı deneme. " + (long)Math.Ceiling(wait / 1000.0) + " saniye sonra tekrar deneyin.")); return; }
                var b = req.JsonBody();
                string identifier = J.S(b, "identifier").Trim(), password = J.S(b, "password");
                if (identifier.Length == 0 || password.Length == 0) { res.Json(400, Err("E-posta/telefon ve şifrenizi girin.")); return; }
                var v = License.VerifyPassword(identifier, password);
                if (!J.Truthy(J.Get(v, "ok"))) { Fail(ip); res.Json(401, Err(J.S(v, "error").Length > 0 ? J.S(v, "error") : "E-posta/telefon veya şifre hatalı.")); return; }
                Success(ip);
                SetSessionCookie(req, res, NewSession("admin-pending", null, null), "admin");
                res.Json(200, J.Obj("ok", true));
                return;
            }
            if (path == "/api/admin/login-step2" && POST)
            {
                long wait = LockedMs(ip);
                if (wait > 0) { res.Json(429, Err("Çok fazla hatalı deneme. " + (long)Math.Ceiling(wait / 1000.0) + " saniye sonra tekrar deneyin.")); return; }
                var pending = CurrentSession(req, null);
                if (pending == null || J.S(pending, "role") != "admin-pending") { res.Json(401, Err("Önce e-posta ve şifrenizle giriş yapın.")); return; }
                if (!Samba.AdminValidByPin(J.S(req.JsonBody(), "pin"))) { Fail(ip); res.Json(401, Err("PIN hatalı.")); return; }
                Success(ip);
                SetSessionCookie(req, res, NewSession("admin", null, null), "admin");
                res.Json(200, J.Obj("ok", true));
                return;
            }
            if (path == "/api/logout" && POST) { DestroySession(req); ClearSessionCookie(req, res); res.Json(200, J.Obj("ok", true)); return; }
            if (path == "/api/config") { res.Json(200, J.Obj("appName", AppName)); return; }

            if (path.StartsWith("/api/"))
            {
                var adminS = CurrentSession(req, "admin");
                var courierS = CurrentSession(req, "courier");
                if (adminS == null && courierS == null) { res.Json(401, Err("Oturum gerekli.")); return; }
                var session = adminS ?? courierS;
                bool isAdmin = J.S(session, "role") == "admin";

                if (path == "/api/me" && GET) { res.Json(200, J.Obj("role", session["role"], "courierName", J.Get(session, "courierName"))); return; }
                if (path == "/api/courier/unassigned" && GET) { res.Json(200, J.Obj("orders", Samba.UnassignedPackages())); return; }
                if ((mt = Regex.Match(path, @"^/api/courier/orders/(\d+)/claim$")).Success && POST)
                {
                    if (courierS == null) { res.Json(403, Err("Yetkiniz yok.")); return; }
                    try { Samba.ClaimPackage(mt.Groups[1].Value, J.S(courierS, "courierName")); }
                    catch (Exception e) { res.Json(409, Err(e.Message)); return; }
                    long tid = long.Parse(mt.Groups[1].Value);
                    Store.LogEvent(tid, courierS["courierName"], "paket-alindi", null, null);
                    Broadcast(J.Obj("kind", "paket-alindi", "ticketId", tid, "courierName", courierS["courierName"]));
                    res.Json(200, J.Obj("ok", true));
                    return;
                }
                if (path == "/api/courier/orders" && GET)
                {
                    var all = Samba.ActiveCourierOrders();
                    res.Json(200, J.Obj("orders", adminS != null ? all : all.Where(o => J.S(o, "courierName") == J.S(courierS, "courierName")).ToList(), "appName", AppName));
                    return;
                }
                if (path == "/api/payment-types" && GET) { res.Json(200, J.Obj("types", Samba.PaymentTypes())); return; }
                if (path == "/api/courier/my-deliveries" && GET)
                {
                    if (courierS == null) { res.Json(403, Err("Yetkiniz yok.")); return; }
                    string day = DayParam(req); var rg = DayRangeUtc(day);
                    var list = Store.CourierDeliveries(J.S(courierS, "courierName"), rg[0], rg[1]);
                    res.Json(200, J.Obj("date", day, "count", list.Count, "total", J.NumVal(list.Sum(d => J.NumOr(d["amount"], 0))), "deliveries", list));
                    return;
                }
                if ((mt = Regex.Match(path, @"^/api/courier/orders/(\d+)/content$")).Success && GET)
                {
                    string id = mt.Groups[1].Value;
                    var active = Samba.ActiveCourierOrders().FirstOrDefault(o => J.S(o, "id") == id);
                    if (active != null) { if (!OwnsOrder(session, active)) { res.Json(403, Err("Bu siparişe erişiminiz yok.")); return; } }
                    else if (Samba.UnassignedPackages().FirstOrDefault(o => J.S(o, "id") == id) == null) { res.Json(403, Err("Bu siparişe erişiminiz yok.")); return; }
                    res.Json(200, J.Obj("items", Samba.OrderContent(id)));
                    return;
                }
                if ((mt = Regex.Match(path, @"^/api/courier/orders/(\d+)/delivered$")).Success && POST)
                {
                    string id = mt.Groups[1].Value;
                    var order = Samba.ActiveCourierOrders().FirstOrDefault(o => J.S(o, "id") == id);
                    if (order == null || !OwnsOrder(session, order)) { res.Json(403, Err("Bu siparişe erişiminiz yok.")); return; }
                    var b = req.JsonBody();
                    Dictionary<string, object> result;
                    try { result = Samba.MarkDelivered(id, J.Get(b, "paymentTypeId"), J.Truthy(J.Get(b, "noPayment")), J.Get(session, "courierId"), null); }
                    catch (Exception e) { res.Json(409, Err(e.Message)); return; }
                    bool closed = J.IsTrue(result, "closed");
                    Store.LogEvent(order["id"], order["courierName"], closed ? "teslim-edildi" : "teslim-odeme-bekliyor", null, result["amountCollected"]);
                    Broadcast(J.Obj("kind", closed ? "teslim-edildi" : "teslim-odeme-bekliyor", "ticketId", order["id"], "number", order["number"], "courierName", order["courierName"], "amountCollected", result["amountCollected"]));
                    var o2 = J.Obj("ok", true); J.Assign(o2, result);
                    res.Json(200, o2);
                    return;
                }
                if (path == "/api/admin/couriers" && GET) { if (!isAdmin) { res.Json(403, Err("Yetkiniz yok.")); return; } res.Json(200, J.Obj("couriers", Samba.Couriers())); return; }
                if (path == "/api/courier/location" && POST)
                {
                    if (courierS == null) { res.Json(403, Err("Yetkiniz yok.")); return; }
                    var b = req.JsonBody();
                    double lat = J.Num(b, "lat"), lng = J.Num(b, "lng"), acc = J.Num(b, "accuracy");
                    object accuracy = (J.Finite(acc) && acc != 0) ? J.NumVal(acc) : null;
                    if (!J.Finite(lat) || !J.Finite(lng) || J.Get(b, "lat") == null || J.Get(b, "lng") == null) { res.Json(400, Err("Geçersiz konum.")); return; }
                    Store.SetCourierLocation(J.S(courierS, "courierName"), lat, lng, accuracy);
                    Broadcast(J.Obj("kind", "konum", "courierName", courierS["courierName"], "lat", J.NumVal(lat), "lng", J.NumVal(lng), "accuracy", accuracy));
                    res.Json(200, J.Obj("ok", true));
                    return;
                }
                if (path == "/api/admin/locations" && GET) { if (!isAdmin) { res.Json(403, Err("Yetkiniz yok.")); return; } res.Json(200, J.Obj("locations", Store.AllCourierLocations())); return; }
                if (path == "/api/admin/recent-events" && GET) { if (!isAdmin) { res.Json(403, Err("Yetkiniz yok.")); return; } res.Json(200, J.Obj("events", Store.RecentEvents(50))); return; }
                if (path == "/api/admin/report" && GET)
                {
                    if (!isAdmin) { res.Json(403, Err("Yetkiniz yok.")); return; }
                    string day = DayParam(req); var rg = DayRangeUtc(day);
                    var delivered = Store.DeliverySummary(rg[0], rg[1]);
                    var activeBy = new Dictionary<string, int[]>();
                    foreach (var o in Samba.ActiveCourierOrders())
                    {
                        string cn = J.S(o, "courierName");
                        if (!activeBy.ContainsKey(cn)) activeBy[cn] = new int[2];
                        if (J.S(o, "packageStatus") == "Yolda") activeBy[cn][1]++; else activeBy[cn][0]++;
                    }
                    var names = new HashSet<string>(delivered.Select(d => J.S(d["courier_name"])).Concat(activeBy.Keys));
                    var byCourier = names.OrderBy(n => n, StringComparer.Ordinal).Select(n =>
                    {
                        var d = delivered.FirstOrDefault(r => J.S(r["courier_name"]) == n);
                        int[] a; if (!activeBy.TryGetValue(n, out a)) a = new int[2];
                        return (object)J.Obj("courierName", n, "pending", a[0], "enroute", a[1], "deliveredCount", d != null ? d["count"] : 0L, "deliveredTotal", d != null ? d["total"] : 0L);
                    }).ToList();
                    res.Json(200, J.Obj("date", day, "byCourier", byCourier));
                    return;
                }
                if (path == "/api/admin/debug/roles" && GET) { if (!isAdmin) { res.Json(403, Err("Yetkiniz yok.")); return; } res.Json(200, J.Obj("rows", Samba.DebugRolesAndUsers())); return; }
                res.Json(404, Err("Bulunamadı"));
                return;
            }
            ServeStatic(res, path);
        }
    }
}
