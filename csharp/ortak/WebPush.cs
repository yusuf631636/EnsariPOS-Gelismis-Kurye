using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;

namespace Alfa
{
    // Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) - Node "web-push" paketinin karsiligi.
    // .NET 4'te ham ECDH / AES-GCM olmadigi icin P-256 ve GCM burada yazildi (BigInteger ile).
    // Anahtar bicimi web-push ile ayni (data/vapid.json: { publicKey, privateKey } base64url) -
    // kuryelerin mevcut abonelikleri gecerli kalir.
    public static class P256
    {
        public static readonly BigInteger P = H("FFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF");
        public static readonly BigInteger N = H("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
        public static readonly BigInteger B = H("5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B");
        public static readonly BigInteger Gx = H("6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296");
        public static readonly BigInteger Gy = H("4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5");

        static BigInteger H(string hex) { return BigInteger.Parse("0" + hex, NumberStyles.HexNumber); }
        static BigInteger M(BigInteger x) { x %= P; return x.Sign < 0 ? x + P : x; }
        public static BigInteger FromBytes(byte[] be, int off = 0, int len = -1)
        {
            if (len < 0) len = be.Length - off;
            var le = new byte[len + 1];
            for (int i = 0; i < len; i++) le[i] = be[off + len - 1 - i];
            return new BigInteger(le);
        }
        public static byte[] ToBytes32(BigInteger v)
        {
            var le = v.ToByteArray();
            var r = new byte[32];
            for (int i = 0; i < 32 && i < le.Length; i++) r[31 - i] = le[i];
            return r;
        }
        static BigInteger Inv(BigInteger x, BigInteger m) { return BigInteger.ModPow(((x % m) + m) % m, m - 2, m); }

        // Jacobian (X,Y,Z); Z=0 sonsuz nokta
        static BigInteger[] Dbl(BigInteger[] q)
        {
            if (q[2].IsZero || q[1].IsZero) return new[] { BigInteger.One, BigInteger.One, BigInteger.Zero };
            BigInteger delta = M(q[2] * q[2]), gamma = M(q[1] * q[1]), beta = M(q[0] * gamma);
            BigInteger alpha = M(3 * M(q[0] - delta) * M(q[0] + delta));
            BigInteger x3 = M(alpha * alpha - 8 * beta);
            BigInteger z3 = M(M((q[1] + q[2]) * (q[1] + q[2])) - gamma - delta);
            BigInteger y3 = M(alpha * M(4 * beta - x3) - 8 * M(gamma * gamma));
            return new[] { x3, y3, z3 };
        }
        static BigInteger[] Add(BigInteger[] a, BigInteger[] b)
        {
            if (a[2].IsZero) return b;
            if (b[2].IsZero) return a;
            BigInteger z1z1 = M(a[2] * a[2]), z2z2 = M(b[2] * b[2]);
            BigInteger u1 = M(a[0] * z2z2), u2 = M(b[0] * z1z1);
            BigInteger s1 = M(a[1] * b[2] * z2z2), s2 = M(b[1] * a[2] * z1z1);
            BigInteger h = M(u2 - u1), r = M(2 * (s2 - s1));
            if (h.IsZero) return r.IsZero ? Dbl(a) : new[] { BigInteger.One, BigInteger.One, BigInteger.Zero };
            BigInteger i = M(4 * h * h), j = M(h * i), v = M(u1 * i);
            BigInteger x3 = M(r * r - j - 2 * v);
            BigInteger y3 = M(r * M(v - x3) - 2 * M(s1 * j));
            BigInteger z3 = M(M(M((a[2] + b[2]) * (a[2] + b[2])) - z1z1 - z2z2) * h);
            return new[] { x3, y3, z3 };
        }
        // k * (x,y) -> affine (x,y)
        public static BigInteger[] Mul(BigInteger k, BigInteger x, BigInteger y)
        {
            var R = new[] { BigInteger.One, BigInteger.One, BigInteger.Zero };
            var Q = new[] { x, y, BigInteger.One };
            var kb = k.ToByteArray();
            for (int i = kb.Length * 8 - 1; i >= 0; i--)
            {
                R = Dbl(R);
                if (((kb[i / 8] >> (i % 8)) & 1) == 1) R = Add(R, Q);
            }
            if (R[2].IsZero) throw new CryptographicException("Geçersiz nokta.");
            BigInteger zi = Inv(R[2], P), zi2 = M(zi * zi);
            return new[] { M(R[0] * zi2), M(R[1] * zi2 * zi) };
        }
        public static bool OnCurve(BigInteger x, BigInteger y) { return M(y * y) == M(x * x * x - 3 * x + B); }
        public static BigInteger RandomScalar()
        {
            using (var rng = RandomNumberGenerator.Create())
            {
                var b = new byte[32];
                while (true) { rng.GetBytes(b); var k = FromBytes(b); if (k.Sign > 0 && k < N) return k; }
            }
        }
        public static byte[] PublicUncompressed(BigInteger d)
        {
            var q = Mul(d, Gx, Gy);
            var r = new byte[65]; r[0] = 4;
            Array.Copy(ToBytes32(q[0]), 0, r, 1, 32); Array.Copy(ToBytes32(q[1]), 0, r, 33, 32);
            return r;
        }
        public static byte[] Ecdh(BigInteger d, byte[] pubUncompressed)
        {
            if (pubUncompressed.Length != 65 || pubUncompressed[0] != 4) throw new CryptographicException("Geçersiz genel anahtar.");
            BigInteger x = FromBytes(pubUncompressed, 1, 32), y = FromBytes(pubUncompressed, 33, 32);
            if (!OnCurve(x, y)) throw new CryptographicException("Genel anahtar eğri üzerinde değil.");
            return ToBytes32(Mul(d, x, y)[0]);
        }
        // ES256 imza (r||s, 64 bayt)
        public static byte[] SignSha256(BigInteger d, byte[] msg)
        {
            byte[] hash; using (var sha = SHA256.Create()) hash = sha.ComputeHash(msg);
            BigInteger z = FromBytes(hash);
            while (true)
            {
                BigInteger k = RandomScalar();
                BigInteger r = Mul(k, Gx, Gy)[0] % N;
                if (r.IsZero) continue;
                BigInteger s = (Inv(k, N) * ((z + r * d) % N)) % N;
                if (s.IsZero) continue;
                var o = new byte[64];
                Array.Copy(ToBytes32(r), 0, o, 0, 32); Array.Copy(ToBytes32(s), 0, o, 32, 32);
                return o;
            }
        }
    }

    public static class AesGcm
    {
        static byte[] Ecb(byte[] key, byte[] block)
        {
            using (var aes = new AesManaged { Mode = CipherMode.ECB, Padding = PaddingMode.None, Key = key })
            using (var enc = aes.CreateEncryptor()) return enc.TransformFinalBlock(block, 0, 16);
        }
        static byte[] GfMul(byte[] x, byte[] y)
        {
            var z = new byte[16]; var v = (byte[])y.Clone();
            for (int i = 0; i < 128; i++)
            {
                if (((x[i / 8] >> (7 - i % 8)) & 1) == 1) for (int j = 0; j < 16; j++) z[j] ^= v[j];
                bool lsb = (v[15] & 1) == 1;
                for (int j = 15; j > 0; j--) v[j] = (byte)((v[j] >> 1) | (v[j - 1] << 7));
                v[0] >>= 1;
                if (lsb) v[0] ^= 0xE1;
            }
            return z;
        }
        // 12 bayt IV, ek veri yok. Donus: sifreli metin || 16 bayt etiket
        public static byte[] Encrypt(byte[] key, byte[] iv, byte[] plain)
        {
            var h = Ecb(key, new byte[16]);
            var j0 = new byte[16]; Array.Copy(iv, j0, 12); j0[15] = 1;
            var c = new byte[plain.Length];
            var ctr = (byte[])j0.Clone();
            for (int off = 0; off < plain.Length; off += 16)
            {
                for (int i = 15; i >= 12; i--) { if (++ctr[i] != 0) break; }
                var ks = Ecb(key, ctr);
                for (int i = 0; i < 16 && off + i < plain.Length; i++) c[off + i] = (byte)(plain[off + i] ^ ks[i]);
            }
            var s = new byte[16];
            for (int off = 0; off < c.Length; off += 16)
            {
                var blk = new byte[16]; Array.Copy(c, off, blk, 0, Math.Min(16, c.Length - off));
                for (int i = 0; i < 16; i++) s[i] ^= blk[i];
                s = GfMul(s, h);
            }
            var len = new byte[16];
            ulong bits = (ulong)c.Length * 8;
            for (int i = 0; i < 8; i++) len[15 - i] = (byte)(bits >> (8 * i));
            for (int i = 0; i < 16; i++) s[i] ^= len[i];
            s = GfMul(s, h);
            var ej0 = Ecb(key, j0);
            var o = new byte[c.Length + 16];
            Array.Copy(c, o, c.Length);
            for (int i = 0; i < 16; i++) o[c.Length + i] = (byte)(s[i] ^ ej0[i]);
            return o;
        }
    }

    public class WebPush
    {
        public readonly string PublicKey;      // base64url (65 bayt)
        readonly BigInteger _d;
        readonly string _subject;

        public WebPush(string publicKeyB64, string privateKeyB64, string subject)
        {
            PublicKey = publicKeyB64; _subject = subject;
            _d = P256.FromBytes(Crypto.FromB64Url(privateKeyB64));
        }

        public static Dictionary<string, object> GenerateKeys()
        {
            var d = P256.RandomScalar();
            return J.Obj("publicKey", Crypto.B64Url(P256.PublicUncompressed(d)), "privateKey", Crypto.B64Url(P256.ToBytes32(d)));
        }

        static byte[] Hmac(byte[] key, params byte[][] parts)
        {
            using (var h = new HMACSHA256(key))
            {
                var all = parts.SelectMany(p => p).ToArray();
                return h.ComputeHash(all);
            }
        }
        static byte[] B(string s) { return Encoding.ASCII.GetBytes(s); }

        // RFC 8291 govdesi (test icin ayri)
        public static byte[] EncryptPayload(byte[] uaPublic, byte[] authSecret, byte[] payload, BigInteger asPrivate, byte[] salt)
        {
            byte[] asPublic = P256.PublicUncompressed(asPrivate);
            byte[] ecdh = P256.Ecdh(asPrivate, uaPublic);
            byte[] prkKey = Hmac(authSecret, ecdh);
            byte[] ikm = Hmac(prkKey, B("WebPush: info"), new byte[] { 0 }, uaPublic, asPublic, new byte[] { 1 });
            byte[] prk = Hmac(salt, ikm);
            byte[] cek = Hmac(prk, B("Content-Encoding: aes128gcm"), new byte[] { 0, 1 }).Take(16).ToArray();
            byte[] nonce = Hmac(prk, B("Content-Encoding: nonce"), new byte[] { 0, 1 }).Take(12).ToArray();
            var plain = new byte[payload.Length + 1]; Array.Copy(payload, plain, payload.Length); plain[payload.Length] = 2;
            byte[] ct = AesGcm.Encrypt(cek, nonce, plain);
            var body = new List<byte>();
            body.AddRange(salt);
            body.AddRange(new byte[] { 0, 0, 0x10, 0 });   // rs = 4096
            body.Add(65);
            body.AddRange(asPublic);
            body.AddRange(ct);
            return body.ToArray();
        }

        public string VapidJwt(string endpoint)
        {
            var u = new Uri(endpoint);
            string aud = u.Scheme + "://" + u.Host + (u.IsDefaultPort ? "" : ":" + u.Port);
            long exp = J.NowMs() / 1000 + 12 * 3600;
            string head = Crypto.B64Url(Encoding.UTF8.GetBytes("{\"typ\":\"JWT\",\"alg\":\"ES256\"}"));
            string body = Crypto.B64Url(Encoding.UTF8.GetBytes(J.Str(J.Obj("aud", aud, "exp", exp, "sub", _subject))));
            string unsigned = head + "." + body;
            return unsigned + "." + Crypto.B64Url(P256.SignSha256(_d, Encoding.ASCII.GetBytes(unsigned)));
        }

        // Donus: HTTP durum kodu (201 = basarili; 404/410 = abonelik gecersiz)
        public int Send(Dictionary<string, object> subscription, string payload, int ttlSeconds = 2419200)
        {
            string endpoint = J.S(subscription, "endpoint");
            var keys = J.DD(J.Get(subscription, "keys"));
            byte[] ua = Crypto.FromB64Url(J.S(keys, "p256dh")), auth = Crypto.FromB64Url(J.S(keys, "auth"));
            var salt = new byte[16]; using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(salt);
            byte[] body = EncryptPayload(ua, auth, Encoding.UTF8.GetBytes(payload), P256.RandomScalar(), salt);
            var req = (System.Net.HttpWebRequest)System.Net.WebRequest.Create(endpoint);
            req.Method = "POST";
            req.Timeout = 15000;
            req.ContentType = "application/octet-stream";
            req.Headers["Content-Encoding"] = "aes128gcm";
            req.Headers["TTL"] = ttlSeconds.ToString(CultureInfo.InvariantCulture);
            req.Headers["Authorization"] = "vapid t=" + VapidJwt(endpoint) + ", k=" + PublicKey;
            req.ContentLength = body.Length;
            using (var s = req.GetRequestStream()) s.Write(body, 0, body.Length);
            try { using (var r = (System.Net.HttpWebResponse)req.GetResponse()) return (int)r.StatusCode; }
            catch (System.Net.WebException ex)
            {
                var r = ex.Response as System.Net.HttpWebResponse;
                if (r == null) throw;
                using (r) return (int)r.StatusCode;
            }
        }
    }
}
