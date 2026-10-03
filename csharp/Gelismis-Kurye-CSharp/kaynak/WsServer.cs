using System;
using System.Collections.Generic;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using Alfa;

namespace GKurye
{
    // ws.js karsiligi: /ws uzerinden restoran ekranina canli olay yayini. HttpListener WebSocket'i
    // Windows 8+ ister; eski Windows'ta istek reddedilir, restoran ekrani zaten 6 sn sorgulamayla calisir.
    public static class WsServer
    {
        public static bool Accept(HttpListenerContext ctx, List<object> clients)
        {
            if (ctx.Request.Url.AbsolutePath != "/ws" || !ctx.Request.IsWebSocketRequest) return false;
            WebSocket ws;
            try { ws = ctx.AcceptWebSocketAsync(null).Result.WebSocket; }
            catch { try { ctx.Response.StatusCode = 400; ctx.Response.Close(); } catch { } return true; }
            lock (clients) clients.Add(ws);
            try
            {
                var buf = new ArraySegment<byte>(new byte[4096]);
                while (ws.State == WebSocketState.Open)
                {
                    var r = ws.ReceiveAsync(buf, CancellationToken.None).Result;
                    if (r.MessageType == WebSocketMessageType.Close) { try { ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None).Wait(2000); } catch { } break; }
                }
            }
            catch { }
            finally { lock (clients) clients.Remove(ws); try { ws.Dispose(); } catch { } }
            return true;
        }

        public static void Broadcast(List<object> clients, string text)
        {
            object[] list; lock (clients) list = clients.ToArray();
            var seg = new ArraySegment<byte>(Encoding.UTF8.GetBytes(text));
            foreach (WebSocket ws in list)
            {
                try { if (ws.State == WebSocketState.Open) lock (ws) ws.SendAsync(seg, WebSocketMessageType.Text, true, CancellationToken.None).Wait(5000); }
                catch { }
            }
        }
    }
}
