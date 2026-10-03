/* [YEREL TARAF - bu dosya RESTORAN BILGISAYARINDA calisir (bu urunun kurulumu
   nereye yapilirsa orada), BULUTTA DEGIL. Tunelin KARSI/SUNUCU tarafi
   C:\toplu\gk-tunnel.js'dir - o, buluta (bu VPS'e) kurulu, disaridan gelen
   baglantilari KABUL eder; bu dosya ise disari dogru ONA baglanir.]

   kuryeler.ornek-alanadi.com uzerinden UZAKTAN erisim - GENEL AMACLI ters HTTP tuneli.
   Buluttaki C:\toplu\gk-tunnel.js + routes/gk-web.js ile eslesir: gelen HER HTTP
   istegini (method/path/header/govde) oldugu gibi WebSocket uzerinden alir, bu
   uygulamanin KENDI handleRequest() fonksiyonuna (server.js - gercek HTTP
   sunucusunun kullandigi AYNI fonksiyon) sahte bir req/res ile verir, cevabi
   yakalayip geri gonderir. server.js'in PIN/oturum/lisans mantigi bu tunelin
   FARKINDA bile degildir - kod TEK SATIR degismeden hem yerel hem tunelli
   istekleri ayni sekilde isler.

   Lisans kontrolunden (license.js) BAGIMSIZDIR: anahtar varsa baglanmayi HER ZAMAN
   dener - lisans kapaliysa bulut tarafi (gk-tunnel.js) baglantiyi zaten reddeder,
   burada ayrica kontrol etmeye gerek yok (tek dogruluk kaynagi bulutta kalir). */
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const license = require('./license');

const RECONNECT_MIN_MS = 2000, RECONNECT_MAX_MS = 30000;
let reconnectDelay = RECONNECT_MIN_MS;

function log(...args) { console.log(new Date().toISOString(), '[tunnel]', ...args); }

/* ONEMLI - gercek bir kacis (race condition) burada yasandi (13.09.2026, canli
   OZ URFA testinde tespit edildi): govde ('data'/'end') ONCEDEN, req nesnesi
   OLUSTURULDUGU AN process.nextTick ile "gonderiliyordu" - ama handleRequest
   govdeyi okumadan ONCE baska bir async islem (ornegin veritabanindan siparis
   okuma) yaparsa, o islem bitene kadar nextTick COKTAN gecmis oluyor, govde
   dinleyicisi (auth.readJsonBody) hic kimse dinlemezken "havaya" yayinlanmis
   oluyordu - readJsonBody'nin Promise'i SONSUZA KADAR beklemede kaliyor, 15sn
   sonra tunel zaman asimina ugruyordu ("odeme secince istek hatasi" - govdesi
   olan ama govdeyi HEMEN okumayan TEK uc buydu, login/claim etkilenmiyordu
   cunku govdeyi hic beklemeden ilk is okuyorlardi ya da govdeleri yoktu).
   Duzeltme: govde, .on('data'/'end') GERCEKTEN cagrildigi anda (ne zaman
   olursa olsun) yayinlanir - boylece dinleyici HER ZAMAN zamaninda yetisir. */
function makeFakeReq(method, urlPath, headers, bodyBuffer) {
  const req = new EventEmitter();
  req.method = method;
  req.url = urlPath;
  req.headers = headers || {};
  req.socket = { remoteAddress: '127.0.0.1' };
  let scheduled = false;
  const originalOn = req.on.bind(req);
  req.on = (event, listener) => {
    if ((event === 'data' || event === 'end') && !scheduled) {
      scheduled = true;
      process.nextTick(() => {
        if (bodyBuffer && bodyBuffer.length) req.emit('data', bodyBuffer);
        req.emit('end');
      });
    }
    return originalOn(event, listener);
  };
  return req;
}

/* handleRequest bazi yollarda (statik dosya servisi) fs.createReadStream().pipe(res)
   kullanir - pipe() hedefte .on('drain'/...) arar, o yuzden gercek bir EventEmitter
   olmasi sart. .end() NE ZAMAN cagrilirsa cagrilsin (senkron veya stream bittiginde
   asenkron) cozumleyici TAM O ANDA calisir - iki durumda da dogru govdeyi yakalar. */
function makeFakeRes(onDone) {
  const res = new EventEmitter();
  const chunks = [];
  let statusCode = 200, headers = {}, done = false;
  // Gercek Node http.ServerResponse'da setHeader() ile ONCEDEN konan basliklar
  // (orn. auth.js'in Set-Cookie'si), SONRA cagrilan writeHead()'in kendi
  // basliklariyla BIRLESIR - degistirilmez. Burada da AYNI davranis taklit
  // edilmezse (duz atama yerine merge), giris sonrasi oturum cerezi (Set-Cookie)
  // json()'un kendi writeHead() cagrisinda SESSIZCE kayboluyordu (canli testte
  // yakalandi - tunel uzerinden giris basarili ama sonraki istekler 401 veriyordu).
  res.writeHead = (status, h) => { statusCode = status; headers = { ...headers, ...(h || {}) }; };
  res.setHeader = (k, v) => { headers[k] = v; };
  res.write = chunk => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; };
  res.end = chunk => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    if (done) return;
    done = true;
    onDone({ status: statusCode, headers, body: Buffer.concat(chunks) });
  };
  return res;
}

async function processRequest(handleRequest, msg) {
  const bodyBuffer = Buffer.from(msg.bodyBase64 || '', 'base64');
  const req = makeFakeReq(msg.method, msg.path, msg.headers, bodyBuffer);
  const result = await new Promise(resolve => {
    const res = makeFakeRes(resolve);
    handleRequest(req, res).catch(error => {
      log('handleRequest hatasi (yakalanmamis):', error.message);
      try { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: error.message })); } catch { resolve({ status: 500, headers: {}, body: Buffer.alloc(0) }); }
    });
  });
  return result;
}

/* Tunel her ~4 dakikada bir kopup yeniden baglaniyordu (13.09.2026, canli
   OZ URFA testinde loglardan tespit edildi) - suphe: Cloudflare/ara katmanlar
   dusuk seviye WS ping/pong KONTROL cerceve'lerini "aktivite" saymiyor, sadece
   GERCEK veri (text/binary) cercevelerini sayiyor olabilir - bu yuzden burada
   GERCEK bir mesaj (uygulama seviyesinde ping) gonderiliyor. Kopma anina denk
   gelen bir istek, tam bu ~2-3sn'lik yeniden baglanma penceresine denk
   gelirse "NOT_CONNECTED"/zaman asimi ile basarisiz olabiliyordu - kullanicinin
   "odeme secince ara sira istek hatasi" sikayetiyle ortusuyor. */
const PING_INTERVAL_MS = 30000;

function connect(handleRequest, gkKey, wsUrl) {
  const ws = new WebSocket(`${wsUrl}?key=${encodeURIComponent(gkKey)}`);
  let pingTimer = null;

  ws.on('open', () => {
    log('kuryeler.ornek-alanadi.com tüneline bağlandı.');
    reconnectDelay = RECONNECT_MIN_MS;
    pingTimer = setInterval(() => { try { ws.send(JSON.stringify({ type: 'ping' })); } catch {} }, PING_INTERVAL_MS);
  });

  ws.on('message', async raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type !== 'request') return;
    try {
      const result = await processRequest(handleRequest, msg);
      ws.send(JSON.stringify({
        type: 'response', id: msg.id, status: result.status, headers: result.headers,
        bodyBase64: result.body.toString('base64')
      }));
    } catch (error) {
      log('istek islenemedi (yoksayildi):', error.message);
      try { ws.send(JSON.stringify({ type: 'response', id: msg.id, status: 500, headers: {}, bodyBase64: '' })); } catch {}
    }
  });

  ws.on('close', () => {
    if (pingTimer) clearInterval(pingTimer);
    log('tünel bağlantısı kesildi, yeniden denenecek.');
    setTimeout(() => connect(handleRequest, gkKey, wsUrl), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX_MS);
  });
  ws.on('error', error => { log('tünel hatası:', error.message); ws.close(); });
}

function start(handleRequest) {
  const gkKey = license.gkActivationKey();
  if (!gkKey) { log('gkActivationKey yok - uzaktan erişim tüneli pasif (yerel/LAN erişimi etkilenmez).'); return; }
  const wsUrl = license.CLOUD_URL.replace(/^http/, 'ws') + '/gk-tunnel';
  connect(handleRequest, gkKey, wsUrl);
}

module.exports = { start };
