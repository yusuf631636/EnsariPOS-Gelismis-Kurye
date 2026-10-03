using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Text;
using System.Threading;

namespace Alfa
{
    // Tek istek modeli: hem yerel HttpListener'dan hem bulut tunelinden gelen istekler buna cevrilir
    // (Node surumundeki "tunel sahte req/res ile ayni handleRequest'i cagirir" deseni).
    public class Req
    {
        public string Method = "GET";
        public string Path = "/";          // yuzde-kodlu (URL.pathname gibi)
        public string Search = "";         // "?a=b" ya da ""
        public Dictionary<string, string> Headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, string> Query = new Dictionary<string, string>();
        public byte[] Body = new byte[0];
        public bool IsTunnel;
        public string RemoteIp = "";

        public static Req From(string method, string rawUrl)
        {
            var r = new Req { Method = (method ?? "GET").ToUpperInvariant() };
            string u = rawUrl ?? "/";
            int h = u.IndexOf('#'); if (h >= 0) u = u.Substring(0, h);
            int q = u.IndexOf('?');
            r.Path = q >= 0 ? u.Substring(0, q) : u;
            if (r.Path.Length == 0 || r.Path[0] != '/') r.Path = "/" + r.Path;
            r.Search = q >= 0 ? u.Substring(q) : "";
            if (r.Search == "?") r.Search = "";
            if (q >= 0)
                foreach (var part in u.Substring(q + 1).Split('&'))
                {
                    if (part.Length == 0) continue;
                    int eq = part.IndexOf('=');
                    string k = Dec(eq >= 0 ? part.Substring(0, eq) : part), v = eq >= 0 ? Dec(part.Substring(eq + 1)) : "";
                    if (!r.Query.ContainsKey(k)) r.Query[k] = v;   // URLSearchParams.get() ilk degeri verir
                }
            return r;
        }
        static string Dec(string s) { try { return Uri.UnescapeDataString(s.Replace('+', ' ')); } catch { return s; } }

        public string Q(string key) { string v; return Query.TryGetValue(key, out v) ? v : null; }
        public string Header(string key) { string v; return Headers.TryGetValue(key, out v) ? v : null; }
        public string Cookie(string name)
        {
            string header = Header("cookie");
            if (string.IsNullOrEmpty(header)) return null;
            foreach (var part in header.Split(';'))
            {
                int i = part.IndexOf('=');
                if (i > -1 && part.Substring(0, i).Trim() == name)
                {
                    try { return Uri.UnescapeDataString(part.Substring(i + 1).Trim()); } catch { return part.Substring(i + 1).Trim(); }
                }
            }
            return null;
        }
        public string BodyText { get { return Encoding.UTF8.GetString(Body); } }
        public Dictionary<string, object> JsonBody(int maxBytes = 1000000)
        {
            if (Body.Length > maxBytes) throw new Exception("İstek çok büyük.");
            if (Body.Length == 0) return new Dictionary<string, object>();
            try { return J.D(J.Parse(BodyText)) ?? new Dictionary<string, object>(); } catch { return new Dictionary<string, object>(); }
        }
    }

    public class Res
    {
        public int Status = 200;
        public readonly List<KeyValuePair<string, string>> Headers = new List<KeyValuePair<string, string>>();
        public readonly MemoryStream Body = new MemoryStream();
        // Akisli cevap (SSE, SambaPOS koprusu): LAN'da dogrudan ag akisina yazilir, tunelde tamponlanir.
        public Action<Stream> Streamer;
        public bool Handled;

        public void SetHeader(string k, string v)
        {
            Headers.RemoveAll(x => x.Key.Equals(k, StringComparison.OrdinalIgnoreCase));
            Headers.Add(new KeyValuePair<string, string>(k, v));
        }
        public void AddHeader(string k, string v) { Headers.Add(new KeyValuePair<string, string>(k, v)); }
        public string GetHeader(string k)
        {
            foreach (var kv in Headers) if (kv.Key.Equals(k, StringComparison.OrdinalIgnoreCase)) return kv.Value;
            return null;
        }
        public void Write(byte[] b) { Body.Write(b, 0, b.Length); }
        public void Write(string s) { Write(Encoding.UTF8.GetBytes(s)); }
        public void Send(int status, string contentType, byte[] body, string cache = null)
        {
            Status = status;
            SetHeader("Content-Type", contentType);
            if (cache != null) SetHeader("Cache-Control", cache);
            Write(body);
            Handled = true;
        }
        public void Json(int status, object data) { Send(status, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(J.Str(data)), "no-store"); }
        public void Html(int status, string html) { Send(status, "text/html; charset=utf-8", Encoding.UTF8.GetBytes(html)); }
        public void Text(int status, string text) { Send(status, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes(text)); }
    }

    // ------------------------------------------------------------------ Yerel HTTP (port 4500)
    public class LocalHost
    {
        HttpListener _l;
        volatile bool _running;
        readonly int _port;
        readonly Action<Req, Res> _handler;

        readonly bool _loopbackOnly;
        public LocalHost(int port, Action<Req, Res> handler) { _port = port; _handler = handler; }
        // config.json "bindHost": "127.0.0.1" (Caddy arkasi) - Node'daki listen(port, bindHost) karsiligi:
        // Host basligi ne olursa olsun kabul edilir, ama SADECE bu bilgisayardan gelen baglantilar islenir.
        public LocalHost(int port, Action<Req, Res> handler, string bindHost) : this(port, handler)
        {
            _loopbackOnly = bindHost == "127.0.0.1" || bindHost == "localhost" || bindHost == "::1";
        }

        public void Start()
        {
            _l = new HttpListener();
            _l.Prefixes.Add("http://+:" + _port + "/");
            try { _l.Start(); }
            catch (HttpListenerException ex)
            {
                Log.Write("http://+:" + _port + "/ acilamadi (" + ex.Message + "), sadece localhost dinlenecek.");
                _l = new HttpListener();
                _l.Prefixes.Add("http://localhost:" + _port + "/");
                _l.Start();
            }
            _running = true;
            _l.BeginGetContext(OnContext, null);
        }

        public void Stop() { _running = false; try { _l.Stop(); _l.Close(); } catch { } }

        void OnContext(IAsyncResult ar)
        {
            HttpListenerContext ctx = null;
            try { ctx = _l.EndGetContext(ar); } catch { }
            if (_running) { try { _l.BeginGetContext(OnContext, null); } catch (Exception ex) { Log.Write("Dinleyici hatasi: " + ex.Message); } }
            if (ctx == null) return;
            var c = ctx;
            ThreadPool.QueueUserWorkItem(delegate { Serve(c); });
        }

        // WebSocket yukseltmesi (ör. /ws canli akis): true donerse istek devralinmistir (cevap kapatilmaz)
        public Func<HttpListenerContext, bool> Upgrade;

        void Serve(HttpListenerContext ctx)
        {
            var hr = ctx.Request; var hs = ctx.Response;
            if (_loopbackOnly)
            {
                bool local = false;
                try { local = IPAddress.IsLoopback(hr.RemoteEndPoint.Address); } catch { }
                if (!local) { try { hs.StatusCode = 403; hs.Close(); } catch { } return; }
            }
            if (Upgrade != null && hr.Headers["Upgrade"] != null)
            {
                try { if (Upgrade(ctx)) return; } catch (Exception ex) { Log.Write("WebSocket yukseltme hatasi: " + ex.Message); }
            }
            try
            {
                var req = Req.From(hr.HttpMethod, hr.RawUrl);
                foreach (string k in hr.Headers.AllKeys) req.Headers[k] = hr.Headers[k];
                try { req.RemoteIp = hr.RemoteEndPoint.Address.ToString(); } catch { }
                if (hr.HasEntityBody)
                {
                    using (var ms = new MemoryStream())
                    {
                        var buf = new byte[32768]; int n;
                        while ((n = hr.InputStream.Read(buf, 0, buf.Length)) > 0)
                        {
                            ms.Write(buf, 0, n);
                            if (ms.Length > 14 * 1024 * 1024) { hs.StatusCode = 413; return; }
                        }
                        req.Body = ms.ToArray();
                    }
                }
                var res = new Res();
                _handler(req, res);
                hs.StatusCode = res.Status;
                foreach (var kv in res.Headers)
                {
                    string k = kv.Key;
                    if (k.Equals("Content-Type", StringComparison.OrdinalIgnoreCase)) hs.ContentType = kv.Value;
                    else if (k.Equals("Content-Length", StringComparison.OrdinalIgnoreCase) || k.Equals("Connection", StringComparison.OrdinalIgnoreCase)
                        || k.Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase) || k.Equals("Keep-Alive", StringComparison.OrdinalIgnoreCase)) continue;
                    else { try { hs.AppendHeader(k, kv.Value); } catch { } }
                }
                if (res.Streamer != null)
                {
                    hs.SendChunked = true;
                    res.Streamer(hs.OutputStream);
                }
                else
                {
                    hs.ContentLength64 = res.Body.Length;
                    res.Body.Position = 0;
                    res.Body.CopyTo(hs.OutputStream);
                }
            }
            catch (HttpListenerException) { }
            catch (IOException) { }
            catch (Exception ex) { Log.Write("HTTP hatasi: " + ex.Message); }
            finally { try { hs.Close(); } catch { } }
        }
    }

    // ------------------------------------------------------------------ Bulut tuneli (tunnel.js karsiligi)
    // Restoran PC'si buluta (ör. app.ornek-alanadi.com/ultra-tunnel) TEK bir kalici WebSocket acar; gelen her
    // HTTP istegi {type:'request',id,method,path,headers,bodyBase64} olarak gelir, ayni handler ile
    // islenip {type:'response',...} doner. ClientWebSocket Windows 7'de calismadigi icin kucuk,
    // kendi RFC 6455 istemcimiz kullanilir (TLS 1.2 SslStream).
    public static class Tunnel
    {
        static Dictionary<string, object> _siteInfo;   // bulutun 'hello' mesajindaki bilgiler (varsa)
        static volatile bool _stop;
        static int _delay = 2000;

        public static Dictionary<string, object> SiteInfo { get { return _siteInfo; } }
        public static void SetSiteInfo(Dictionary<string, object> info) { _siteInfo = info; }
        static void L(string m) { Log.Write("[tunnel] " + m); }

        // cloudUrl: https://app.ornek-alanadi.com, path: /ultra-tunnel, key: aktivasyon anahtari
        public static void Start(Action<Req, Res> handler, string cloudUrl, string path, string key)
        {
            if (string.IsNullOrEmpty(key)) { L("aktivasyon anahtarı yok - uzaktan erişim tüneli pasif (yerel/LAN erişimi etkilenmez)."); return; }
            string wsUrl = cloudUrl.Replace("https://", "wss://").Replace("http://", "ws://") + path + "?key=" + Uri.EscapeDataString(key);
            var t = new Thread(() =>
            {
                while (!_stop)
                {
                    try { RunOnce(wsUrl, handler); }
                    catch (Exception ex) { L("tünel hatası: " + ex.Message); }
                    if (_stop) break;
                    L("tünel bağlantısı kesildi, yeniden denenecek.");
                    Thread.Sleep(_delay);
                    _delay = Math.Min((int)(_delay * 1.5), 30000);
                }
            }) { IsBackground = true, Name = "tunnel" };
            t.Start();
        }
        public static void Stop() { _stop = true; }

        static void RunOnce(string wsUrl, Action<Req, Res> handler)
        {
            using (var ws = WsClient.Connect(wsUrl))
            {
                L("bulut tüneline bağlandı.");
                _delay = 2000;
                var pinger = new Timer(_ => { try { ws.SendText("{\"type\":\"ping\"}"); } catch { } }, null, 30000, 30000);
                try
                {
                    while (!_stop)
                    {
                        string text = ws.Receive();
                        if (text == null) return;
                        Dictionary<string, object> msg;
                        try { msg = J.D(J.Parse(text)); } catch { continue; }
                        if (msg == null) continue;
                        string type = J.S(msg, "type");
                        if (type == "hello")
                        {
                            msg.Remove("type");
                            _siteInfo = msg;
                            L("kimlik alindi" + (J.S(msg, "slug").Length > 0 ? ", slug: " + J.S(msg, "slug") : ""));
                            continue;
                        }
                        if (type != "request") continue;
                        var m = msg;
                        ThreadPool.QueueUserWorkItem(delegate { Process(ws, m, handler); });
                    }
                }
                finally { pinger.Dispose(); }
            }
        }

        static void Process(WsClient ws, Dictionary<string, object> msg, Action<Req, Res> handler)
        {
            object id = J.Get(msg, "id");
            try
            {
                var req = Req.From(J.S(msg, "method"), J.S(msg, "path"));
                req.IsTunnel = true;
                req.RemoteIp = "127.0.0.1";
                var hd = J.D(J.Get(msg, "headers"));
                if (hd != null) foreach (var kv in hd) req.Headers[kv.Key] = J.L(kv.Value) != null ? string.Join(", ", J.L(kv.Value).Select(J.S)) : J.S(kv.Value);
                string b64 = J.S(msg, "bodyBase64");
                req.Body = b64.Length > 0 ? Convert.FromBase64String(b64) : new byte[0];
                var res = new Res();
                handler(req, res);
                byte[] body;
                if (res.Streamer != null) { using (var ms = new MemoryStream()) { res.Streamer(ms); body = ms.ToArray(); } }
                else body = res.Body.ToArray();
                var headers = new Dictionary<string, object>();
                foreach (var g in res.Headers.GroupBy(h => h.Key, StringComparer.OrdinalIgnoreCase))
                {
                    var vals = g.Select(x => (object)x.Value).ToList();
                    headers[g.Key] = vals.Count == 1 ? vals[0] : (object)vals;
                }
                ws.SendText(J.Str(J.Obj("type", "response", "id", id, "status", res.Status, "headers", headers, "bodyBase64", Convert.ToBase64String(body))));
            }
            catch (Exception ex)
            {
                L("istek işlenemedi (yoksayıldı): " + ex.Message);
                try { ws.SendText(J.Str(J.Obj("type", "response", "id", id, "status", 500, "headers", new Dictionary<string, object>(), "bodyBase64", ""))); } catch { }
            }
        }
    }

    // Minimal RFC 6455 WebSocket istemcisi (sadece metin mesajlari; ping/pong/close islenir)
    public class WsClient : IDisposable
    {
        TcpClient _tcp;
        Stream _s;
        readonly object _sendLock = new object();
        readonly Random _rnd = new Random();

        public static WsClient Connect(string url)
        {
            var u = new Uri(url);
            bool tls = u.Scheme == "wss";
            int port = u.IsDefaultPort ? (tls ? 443 : 80) : u.Port;
            var c = new WsClient();
            c._tcp = new TcpClient();
            c._tcp.NoDelay = true;
            var ar = c._tcp.BeginConnect(u.Host, port, null, null);
            if (!ar.AsyncWaitHandle.WaitOne(15000)) { c._tcp.Close(); throw new Exception("Bağlantı zaman aşımı."); }
            c._tcp.EndConnect(ar);
            Stream s = c._tcp.GetStream();
            if (tls)
            {
                var ssl = new SslStream(s, false);
                ssl.AuthenticateAsClient(u.Host, null, (SslProtocols)(3072 | 768 | 192), false);
                s = ssl;
            }
            c._s = s;
            var keyBytes = new byte[16]; c._rnd.NextBytes(keyBytes);
            string key = Convert.ToBase64String(keyBytes);
            string hs = "GET " + u.PathAndQuery + " HTTP/1.1\r\nHost: " + u.Host + (u.IsDefaultPort ? "" : ":" + port) +
                "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key +
                "\r\nSec-WebSocket-Version: 13\r\nUser-Agent: AlfaPOS-QRMenu/2\r\n\r\n";
            var hb = Encoding.ASCII.GetBytes(hs);
            s.Write(hb, 0, hb.Length);
            s.Flush();
            // yanit basliklari
            var sb = new StringBuilder();
            c._tcp.ReceiveTimeout = 20000;
            while (!sb.ToString().EndsWith("\r\n\r\n"))
            {
                int b = s.ReadByte();
                if (b < 0) throw new Exception("Tünel el sıkışması kesildi.");
                sb.Append((char)b);
                if (sb.Length > 16384) throw new Exception("Tünel el sıkışması çok uzun.");
            }
            string first = sb.ToString().Split('\n')[0];
            if (!first.Contains(" 101")) throw new Exception("Tünel reddedildi: " + first.Trim());
            c._tcp.ReceiveTimeout = 90000;   // bulut 25 sn'de bir ping atar; 90 sn sessizlik = kopuk
            return c;
        }

        // Sunucusu ping atmayan kanallar (ör. Patron /patron-ws) icin sessizlik suresi ayarlanabilir (varsayilan 90 sn)
        public int ReceiveTimeoutMs { get { return _tcp.ReceiveTimeout; } set { _tcp.ReceiveTimeout = value; } }

        void ReadExact(byte[] buf, int count)
        {
            int off = 0;
            while (off < count)
            {
                int n = _s.Read(buf, off, count - off);
                if (n <= 0) throw new IOException("Bağlantı kapandı.");
                off += n;
            }
        }

        // Tam bir metin mesaji dondurur; baglanti kapanirsa null
        public string Receive()
        {
            var msg = new MemoryStream();
            var hdr = new byte[2];
            while (true)
            {
                ReadExact(hdr, 2);
                bool fin = (hdr[0] & 0x80) != 0;
                int op = hdr[0] & 0x0F;
                bool masked = (hdr[1] & 0x80) != 0;
                long len = hdr[1] & 0x7F;
                if (len == 126) { var b = new byte[2]; ReadExact(b, 2); len = (b[0] << 8) | b[1]; }
                else if (len == 127) { var b = new byte[8]; ReadExact(b, 8); len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | b[i]; }
                if (len > 64L * 1024 * 1024) throw new IOException("Çok büyük tünel mesajı.");
                byte[] mask = null;
                if (masked) { mask = new byte[4]; ReadExact(mask, 4); }
                var payload = new byte[len];
                if (len > 0) ReadExact(payload, (int)len);
                if (masked) for (int i = 0; i < payload.Length; i++) payload[i] ^= mask[i % 4];
                if (op == 0x8) { try { SendFrame(0x8, new byte[0]); } catch { } return null; }
                if (op == 0x9) { SendFrame(0xA, payload); continue; }
                if (op == 0xA) continue;
                msg.Write(payload, 0, payload.Length);
                if (fin) return Encoding.UTF8.GetString(msg.ToArray());
            }
        }

        public void SendText(string text) { SendFrame(0x1, Encoding.UTF8.GetBytes(text)); }

        void SendFrame(int op, byte[] payload)
        {
            lock (_sendLock)
            {
                var head = new MemoryStream();
                head.WriteByte((byte)(0x80 | op));
                long len = payload.Length;
                if (len < 126) head.WriteByte((byte)(0x80 | len));
                else if (len <= 0xFFFF) { head.WriteByte(0x80 | 126); head.WriteByte((byte)(len >> 8)); head.WriteByte((byte)len); }
                else { head.WriteByte(0x80 | 127); for (int i = 7; i >= 0; i--) head.WriteByte((byte)(len >> (8 * i))); }
                var mask = new byte[4]; _rnd.NextBytes(mask);
                head.Write(mask, 0, 4);
                var masked = new byte[payload.Length];
                for (int i = 0; i < payload.Length; i++) masked[i] = (byte)(payload[i] ^ mask[i % 4]);
                var h = head.ToArray();
                _s.Write(h, 0, h.Length);
                _s.Write(masked, 0, masked.Length);
                _s.Flush();
            }
        }

        public void Dispose() { try { _s.Dispose(); } catch { } try { _tcp.Close(); } catch { } }
    }
}
