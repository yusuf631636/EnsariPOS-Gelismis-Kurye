// AlfaPOS ortak C# kutuphanesi (9-CSharp-Projeler) - JSON (JSON.stringify ile ayni cikti), log, dosya,
// config.json, kripto ve HTTP istemcisi. QR Menü C# surumunde test edilmis parcalar; tum C# projeleri kullanir.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;


namespace Alfa
{
    // ------------------------------------------------------------------ Log
    public static class Log
    {
        static readonly object _lock = new object();
        static string _path;

        public static void Init(string dir)
        {
            try { Directory.CreateDirectory(dir); _path = Path.Combine(dir, "server.log"); } catch { _path = null; }
        }

        public static void Write(string msg)
        {
            string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + msg;
            if (Environment.UserInteractive) { try { Console.WriteLine(line); } catch { } }
            if (_path == null) return;
            lock (_lock)
            {
                try
                {
                    var fi = new FileInfo(_path);
                    if (fi.Exists && fi.Length > 4 * 1024 * 1024)
                    {
                        string old = _path + ".1";
                        if (File.Exists(old)) File.Delete(old);
                        File.Move(_path, old);
                    }
                    File.AppendAllText(_path, line + Environment.NewLine, Encoding.UTF8);
                }
                catch { }
            }
        }
    }

    // ------------------------------------------------------------------ JSON (JavaScript nesne modeline yakin yardimcilar)
    public static class J
    {
        static JavaScriptSerializer NewSer() { return new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 100 }; }
        public static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
        public static readonly CultureInfo Tr = new CultureInfo("tr-TR");

        public static object Parse(string text) { return NewSer().DeserializeObject(text); }
        public static Dictionary<string, object> ParseObj(string text)
        {
            try { return D(Parse(text)) ?? new Dictionary<string, object>(); } catch { return new Dictionary<string, object>(); }
        }
        // JSON.stringify ile ayni cikti (JavaScriptSerializer ' < > & karakterlerini \u00xx yapiyordu -
        // SambaPOS'a giden JSON'lar Node surumuyle bayt bayt ayni olsun diye kendi yazicimiz)
        public static string Str(object v) { var sb = new StringBuilder(); WriteJs(sb, v); return sb.ToString(); }
        static void WriteJs(StringBuilder sb, object v)
        {
            if (v == null) { sb.Append("null"); return; }
            var s = v as string;
            if (s != null) { Quote(sb, s); return; }
            if (v is bool) { sb.Append((bool)v ? "true" : "false"); return; }
            if (v is char) { Quote(sb, v.ToString()); return; }
            if (IsNum(v))
            {
                double d = ToDouble(v);
                if (double.IsNaN(d) || double.IsInfinity(d)) { sb.Append("null"); return; }
                if (v is decimal) { sb.Append(((decimal)v).ToString(Inv).Contains(".") ? ((decimal)v).ToString(Inv).TrimEnd('0').TrimEnd('.') : ((decimal)v).ToString(Inv)); return; }
                sb.Append(NumStr(d));
                return;
            }
            var dict = v as IDictionary<string, object>;
            if (dict != null)
            {
                sb.Append('{'); bool first = true;
                foreach (var kv in dict) { if (!first) sb.Append(','); first = false; Quote(sb, kv.Key); sb.Append(':'); WriteJs(sb, kv.Value); }
                sb.Append('}'); return;
            }
            var idict = v as IDictionary;
            if (idict != null)
            {
                sb.Append('{'); bool first = true;
                foreach (DictionaryEntry kv in idict) { if (!first) sb.Append(','); first = false; Quote(sb, Convert.ToString(kv.Key, Inv)); sb.Append(':'); WriteJs(sb, kv.Value); }
                sb.Append('}'); return;
            }
            var en = v as IEnumerable;
            if (en != null)
            {
                sb.Append('['); bool first = true;
                foreach (var x in en) { if (!first) sb.Append(','); first = false; WriteJs(sb, x); }
                sb.Append(']'); return;
            }
            Quote(sb, Convert.ToString(v, Inv));
        }
        static void Quote(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        // JSON.stringify(v, null, 2) ile ayni bicim
        public static string Pretty(object v) { var sb = new StringBuilder(); WritePretty(sb, v, 0, 2); return sb.ToString(); }
        public static string Pretty1(object v) { var sb = new StringBuilder(); WritePretty(sb, v, 0, 1); return sb.ToString(); }
        static void WritePretty(StringBuilder sb, object v, int depth, int step)
        {
            string pad = new string(' ', depth * step), pad2 = new string(' ', (depth + 1) * step);
            var dict = v as IDictionary<string, object>;
            if (dict != null)
            {
                if (dict.Count == 0) { sb.Append("{}"); return; }
                sb.Append("{\n"); int i = 0;
                foreach (var kv in dict)
                {
                    sb.Append(pad2).Append(Str(kv.Key)).Append(": ");
                    WritePretty(sb, kv.Value, depth + 1, step);
                    if (++i < dict.Count) sb.Append(',');
                    sb.Append('\n');
                }
                sb.Append(pad).Append('}'); return;
            }
            if (v is IEnumerable && !(v is string))
            {
                var items = ((IEnumerable)v).Cast<object>().ToList();
                if (items.Count == 0) { sb.Append("[]"); return; }
                sb.Append("[\n");
                for (int i = 0; i < items.Count; i++) { sb.Append(pad2); WritePretty(sb, items[i], depth + 1, step); if (i < items.Count - 1) sb.Append(','); sb.Append('\n'); }
                sb.Append(pad).Append(']'); return;
            }
            sb.Append(Str(v));
        }

        public static Dictionary<string, object> D(object o) { return o as Dictionary<string, object>; }
        public static Dictionary<string, object> DD(object o) { return (o as Dictionary<string, object>) ?? new Dictionary<string, object>(); }
        public static List<object> L(object o)
        {
            if (o == null || o is string || o is IDictionary) return null;
            var e = o as IEnumerable;
            return e == null ? null : e.Cast<object>().ToList();
        }
        public static List<object> LL(object o) { return L(o) ?? new List<object>(); }
        public static bool IsArray(object o) { return L(o) != null; }

        public static object Get(Dictionary<string, object> d, string k) { object v; return d != null && d.TryGetValue(k, out v) ? v : null; }
        public static bool Has(Dictionary<string, object> d, string k) { return d != null && d.ContainsKey(k); }
        // String(v) - null/undefined -> ""
        public static string S(object v)
        {
            if (v == null) return "";
            if (v is bool) return (bool)v ? "true" : "false";
            if (v is string) return (string)v;
            if (IsNum(v)) return NumStr(ToDouble(v));
            if (v is IDictionary) return "[object Object]";
            var l = L(v); if (l != null) return string.Join(",", l.Select(S));
            return Convert.ToString(v, Inv);
        }
        public static string S(Dictionary<string, object> d, string k) { return S(Get(d, k)); }
        public static bool IsNum(object v) { return v is int || v is long || v is double || v is decimal || v is float || v is short || v is byte; }
        public static double ToDouble(object v) { return Convert.ToDouble(v, Inv); }
        // Number(v) - JS kurallari (bos string -> 0, gecersiz -> NaN)
        public static double Num(object v)
        {
            if (v == null) return double.NaN;
            if (v is bool) return (bool)v ? 1 : 0;
            if (IsNum(v)) return ToDouble(v);
            var s = v as string;
            if (s != null)
            {
                s = s.Trim();
                if (s.Length == 0) return 0;
                double r;
                if (double.TryParse(s, NumberStyles.Float, Inv, out r)) return r;
                return double.NaN;
            }
            return double.NaN;
        }
        public static double Num(Dictionary<string, object> d, string k) { return Num(Get(d, k)); }
        // Number(x) || def
        public static double NumOr(object v, double def) { double n = Num(v); return (double.IsNaN(n) || n == 0) ? def : n; }
        public static bool Finite(double d) { return !double.IsNaN(d) && !double.IsInfinity(d); }
        public static bool IsTrue(object v) { return v is bool && (bool)v; }          // v === true
        public static bool IsFalse(object v) { return v is bool && !(bool)v; }        // v === false
        public static bool IsTrue(Dictionary<string, object> d, string k) { return IsTrue(Get(d, k)); }
        public static bool NotFalse(Dictionary<string, object> d, string k) { return !IsFalse(Get(d, k)); }
        public static bool Truthy(object v)
        {
            if (v == null) return false;
            if (v is bool) return (bool)v;
            if (v is string) return ((string)v).Length > 0;
            if (IsNum(v)) { double d = ToDouble(v); return d != 0 && !double.IsNaN(d); }
            return true;
        }
        // JS sayi -> metin (12 -> "12", 12.5 -> "12.5")
        public static string NumStr(double d)
        {
            if (double.IsNaN(d)) return "NaN";
            if (d == Math.Floor(d) && Math.Abs(d) < 1e15) return ((long)d).ToString(Inv);
            return d.ToString("R", Inv);
        }
        // JSON'a yazilacak sayi: tam sayiysa long (12 -> 12), degilse double
        public static object NumVal(double d)
        {
            if (double.IsNaN(d) || double.IsInfinity(d)) return null;
            if (d == Math.Floor(d) && Math.Abs(d) < 9e15) return (long)d;
            return d;
        }
        public static Dictionary<string, object> Obj(params object[] kv)
        {
            var d = new Dictionary<string, object>();
            for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
            return d;
        }
        public static Dictionary<string, object> Clone(Dictionary<string, object> d) { return d == null ? null : ParseObj(Str(d)); }
        public static Dictionary<string, object> Assign(Dictionary<string, object> target, Dictionary<string, object> src)
        {
            if (src != null) foreach (var kv in src) target[kv.Key] = kv.Value;
            return target;
        }
        public static long NowMs() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }
        public static string IsoNow() { return DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", Inv); }
        public static string LowerTr(string s) { return (s ?? "").ToLower(Tr); }
        public static string Clip(string s, int max) { s = s ?? ""; return s.Length > max ? s.Substring(0, max) : s; }
    }

    // ------------------------------------------------------------------ Dosya yardimcilari
    public static class Files
    {
        public static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
        public static string Read(string path) { return File.ReadAllText(path, Encoding.UTF8); }
        public static void Write(string path, string content) { File.WriteAllText(path, content, Utf8); }
        // gecici dosyaya yaz + yer degistir (config.json yarim kalmasin - Node surumundeki ayni ilke)
        public static void WriteAtomic(string path, string content)
        {
            string tmp = path + ".tmp-" + System.Diagnostics.Process.GetCurrentProcess().Id + "-" + J.NowMs();
            File.WriteAllText(tmp, content, Utf8);
            if (File.Exists(path))
            {
                try { File.Replace(tmp, path, null); return; }
                catch { File.Copy(tmp, path, true); File.Delete(tmp); return; }
            }
            File.Move(tmp, path);
        }
        public static List<object> ReadJsonArray(string path)
        {
            try { return J.L(J.Parse(Read(path))) ?? new List<object>(); } catch { return new List<object>(); }
        }
        public static List<object> TakeLast(List<object> list, int n) { return list.Count > n ? list.Skip(list.Count - n).ToList() : list; }
    }

    // ------------------------------------------------------------------ config.json
    // Node surumu her okumada dosyayi yeniden okuyordu (panelden yapilan degisiklik aninda gecerli) - ayni davranis.
    public static class Cfg
    {
        public static string PathFile;
        static readonly object _lock = new object();

        public static Dictionary<string, object> Read()
        {
            try { return J.ParseObj(Files.Read(PathFile)); } catch { return new Dictionary<string, object>(); }
        }
        // JSON.parse(fs.readFileSync(CONFIG_PATH)) - dosya bozuksa hata firlatir (Node'daki gibi yazmayi engeller)
        public static Dictionary<string, object> ReadStrict()
        {
            var o = J.D(J.Parse(Files.Read(PathFile)));
            if (o == null) throw new Exception("config.json okunamadı.");
            return o;
        }
        public static void Write(Dictionary<string, object> c) { lock (_lock) Files.WriteAtomic(PathFile, J.Pretty(c)); }
        public static void Update(Action<Dictionary<string, object>> fn)
        {
            lock (_lock)
            {
                var c = ReadStrict();
                fn(c);
                Files.WriteAtomic(PathFile, J.Pretty(c));
            }
        }
        public static object Get(string key) { return J.Get(Read(), key); }
    }

    // ------------------------------------------------------------------ Kripto yardimcilari
    public static class Crypto
    {
        public static byte[] Sha256(string s) { using (var h = SHA256.Create()) return h.ComputeHash(Encoding.UTF8.GetBytes(s)); }
        public static string Sha256Hex(byte[] b) { using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(b)).Replace("-", "").ToLowerInvariant(); }
        public static string B64Url(byte[] b) { return Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_'); }
        public static byte[] FromB64Url(string s)
        {
            s = s.Replace('-', '+').Replace('_', '/');
            switch (s.Length % 4) { case 2: s += "=="; break; case 3: s += "="; break; }
            return Convert.FromBase64String(s);
        }
        public static string HmacB64Url(byte[] key, string data) { using (var h = new HMACSHA256(key)) return B64Url(h.ComputeHash(Encoding.UTF8.GetBytes(data))); }
        public static bool FixedEquals(string a, string b)
        {
            if (a == null || b == null || a.Length != b.Length) return false;
            int diff = 0;
            for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
            return diff == 0;
        }
        public static string RandomHex(int bytes)
        {
            var b = new byte[bytes];
            using (var r = RandomNumberGenerator.Create()) r.GetBytes(b);
            return BitConverter.ToString(b).Replace("-", "").ToLowerInvariant();
        }
        public static string Uuid() { return Guid.NewGuid().ToString(); }
    }

    // ------------------------------------------------------------------ Basit HTTP istemcisi (fetch karsiligi)
    public class HttpResult
    {
        public int Status;
        public byte[] Body = new byte[0];
        public bool Ok { get { return Status >= 200 && Status < 300; } }
        public string Text { get { return Encoding.UTF8.GetString(Body); } }
        public Dictionary<string, object> JsonObj() { return J.ParseObj(Text); }
    }

    public static class Web
    {
        static Web()
        {
            // Cloudflare TLS 1.2 ister - .NET 4.x varsayilani eski olabilir (Tls12 = 3072, Tls11 = 768)
            try { ServicePointManager.SecurityProtocol = (SecurityProtocolType)(3072 | 768 | 192); } catch { }
            ServicePointManager.Expect100Continue = false;
            ServicePointManager.DefaultConnectionLimit = 64;
        }
        public static void Init() { }

        public static HttpResult Request(string method, string url, string body, Dictionary<string, string> headers, int timeoutMs)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = method;
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.UserAgent = "AlfaPOS-QRMenu/2";
            req.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
            if (headers != null)
                foreach (var kv in headers)
                {
                    if (kv.Key.Equals("Content-Type", StringComparison.OrdinalIgnoreCase)) req.ContentType = kv.Value;
                    else if (kv.Key.Equals("Accept", StringComparison.OrdinalIgnoreCase)) req.Accept = kv.Value;
                    else req.Headers[kv.Key] = kv.Value;
                }
            if (body != null)
            {
                byte[] b = Encoding.UTF8.GetBytes(body);
                if (req.ContentType == null) req.ContentType = "application/json";
                req.ContentLength = b.Length;
                using (var s = req.GetRequestStream()) s.Write(b, 0, b.Length);
            }
            HttpWebResponse resp;
            try { resp = (HttpWebResponse)req.GetResponse(); }
            catch (WebException ex)
            {
                resp = ex.Response as HttpWebResponse;
                if (resp == null) throw new Exception(ex.Status == WebExceptionStatus.Timeout ? "Zaman aşımı." : ex.Message);
            }
            using (resp)
            using (var s = resp.GetResponseStream())
            using (var ms = new MemoryStream())
            {
                if (s != null) s.CopyTo(ms);
                return new HttpResult { Status = (int)resp.StatusCode, Body = ms.ToArray() };
            }
        }
        public static HttpResult Get(string url, int timeoutMs) { return Request("GET", url, null, null, timeoutMs); }
        public static HttpResult PostJson(string url, object payload, int timeoutMs, Dictionary<string, string> headers = null)
        {
            var h = headers ?? new Dictionary<string, string>();
            if (!h.ContainsKey("Content-Type")) h["Content-Type"] = "application/json";
            return Request("POST", url, J.Str(payload), h, timeoutMs);
        }
    }
}
