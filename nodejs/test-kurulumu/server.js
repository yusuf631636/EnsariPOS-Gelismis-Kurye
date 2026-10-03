/* GELISMIS KURYE SISTEMI - bagimsiz sunucu.
   Bu, mevcut "kendi-restoranim-kurye" (kurye.ornek-alanadi.com, port 4021) uygulamasindan
   TAMAMEN AYRI, kendi portunda calisan YENI bir uygulamadir. Ayni SQL Server/SambaPOS
   veritabanina baglanir ama HICBIR dosyasini paylasmaz/degistirmez - test asamasinda
   ayni restoranda ikisi YAN YANA calisabilir, biri digerini etkilemez.

   Kapsam (once sadece bu restorana, sonra genel musteri urunune tasinacak):
   - Kurye: "Bekleyen Paketler" sekmesinden bosta paketi KENDI USTUNE ALIR (claimPackage) -
     SambaPOS'ta sanki elle atanmis gibi gorunur.
   - Kurye: "Uzerimdekiler" sekmesinden teslim ederken GERCEK SambaPOS odeme turlerinden
     birini secer; "odeme alinmadi" derse adisyon KAPANMAZ.
   - Restoran: kim hangi paketi ne zaman aldi, canli (WebSocket) gorur. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { config } = require('./sql');
const sambapos = require('./sambapos');
const auth = require('./auth');
const wsServer = require('./ws');
const { logEvent, deliverySummary, courierDeliveries, setCourierLocation, allCourierLocations, recentEvents, getOrCreateTrackingToken, ticketIdForToken } = require('./db');
const license = require('./license');

const PORT = Number(process.env.PORT || config.port || 4090);
const ROOT = __dirname;
const APP_NAME = 'Gelişmiş Kurye Sistemi';

/* "day" (YYYY-MM-DD) sunucunun YEREL takvim gunu olarak yorumlanir; kendi-restoranim-kurye
   ile ayni dogrulanmis desen (delivery_events.at SQLite'da her zaman UTC yaziyor). */
function dayRangeUtc(day) {
  const start = new Date(`${day}T00:00:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const fmt = d => d.toISOString().slice(0, 19).replace('T', ' ');
  return { start: fmt(start), end: fmt(end) };
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  const map = { '/courier': '/courier/index.html', '/restoran': '/restoran/index.html', '/': '/courier/index.html' };
  const rel = map[pathname] || pathname;
  const file = path.join(ROOT, 'public', rel);
  if (!file.startsWith(path.join(ROOT, 'public') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'Bulunamadı' });
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

function ownsOrder(session, order) { return session.role === 'admin' || (session.role === 'courier' && order.courierName === session.courierName); }

/* Musteriye elle (WhatsApp vb.) gonderilecek, girissiz "Siparis Takip" sayfasi
   (28.09.2026, kullanici karari: "benden taraf müşteriye ... bu bilgilendirmeye
   biz bir link eklemek istiyorum ... benim müşteriye manuel link gondericem").
   Kimlik dogrulama YOK - token'in kendisi biletin yerine gecer (tahmin edilemez,
   crypto.randomBytes), SambaPOS sifresi/PIN gibi hassas hicbir sey tasimaz. Asıl
   veri /api/takip/:token/status'tan canli cekilir; bu sadece sabit kabuk. */
function renderTrackingPage(token) {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sipariş Takip</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
  body{margin:0;background:#0b0d10;color:#f3f5f7;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;min-height:100vh;padding:20px;box-sizing:border-box}
  .card{max-width:480px;margin:0 auto;background:#161a1e;border:1px solid rgba(255,255,255,.09);border-radius:16px;padding:24px 20px}
  h1{margin:0 0 4px;font-size:19px}
  .sub{color:#8b939a;font-size:13px;margin:0 0 18px;min-height:16px}
  .status{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;font-weight:700;font-size:14px;margin-bottom:8px}
  .status.hazirlaniyor{background:rgba(255,193,7,.15);color:#ffc107}
  .status.yolda{background:rgba(76,140,240,.15);color:#4c8cf0}
  .status.teslim{background:rgba(56,193,114,.15);color:#38c172}
  #map{height:280px;border-radius:12px;margin-top:14px;display:none}
  .muted{color:#8b939a;font-size:12px;margin-top:10px}
</style></head>
<body>
  <div class="card">
    <h1>Sipariş Takip</h1>
    <p class="sub" id="sub">Yükleniyor…</p>
    <div class="status hazirlaniyor" id="statusBadge">…</div>
    <div id="map"></div>
    <p class="muted" id="updatedAt"></p>
  </div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  const TOKEN = ${JSON.stringify(token)};
  let map, marker, stop = false;
  function labelFor(status) {
    if (status === 'yolda') return { text: '🛵 Yolda', cls: 'yolda' };
    if (status === 'teslim') return { text: '✅ Teslim Edildi', cls: 'teslim' };
    return { text: '👨‍🍳 Hazırlanıyor', cls: 'hazirlaniyor' };
  }
  async function tick() {
    if (stop) return;
    try {
      const r = await fetch('/api/takip/' + encodeURIComponent(TOKEN) + '/status');
      const data = await r.json();
      if (!data.ok) {
        document.getElementById('sub').textContent = data.error || 'Bu takip linkinin süresi doldu.';
        document.getElementById('statusBadge').hidden = true;
        document.getElementById('map').style.display = 'none';
        stop = true;
        return;
      }
      const label = labelFor(data.status);
      const badge = document.getElementById('statusBadge');
      badge.textContent = label.text;
      badge.className = 'status ' + label.cls;
      document.getElementById('sub').textContent = data.number ? ('Sipariş No: ' + data.number) : '';
      if (data.status === 'yolda' && data.lat && data.lng) {
        document.getElementById('map').style.display = 'block';
        if (!map) { map = L.map('map').setView([data.lat, data.lng], 15); L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '' }).addTo(map); }
        if (!marker) marker = L.marker([data.lat, data.lng]).addTo(map); else marker.setLatLng([data.lat, data.lng]);
        map.setView([data.lat, data.lng]);
        document.getElementById('updatedAt').textContent = 'Konum birkaç saniyede bir güncellenir.';
      } else {
        document.getElementById('map').style.display = 'none';
      }
      if (data.status === 'teslim') stop = true; else setTimeout(tick, 7000);
    } catch { setTimeout(tick, 7000); }
  }
  tick();
</script>
</body></html>`;
}

/* Bu fonksiyon, "kuryeler.ornek-alanadi.com" tuneli (tunnel.js) tarafindan da AYNEN
   cagirilir - gercek bir HTTP sunucusundan gelen req/res ile tunelden gelen
   TAKLIT req/res arasinda BURADA hicbir fark yoktur, TEK SATIR degismez. */
async function handleRequest(req, res) {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const ip = auth.clientIp(req);

    /* Lisans kontrolu, giris ekranindan ONCE degil - statik sayfalar (login ekrani)
       her zaman acik kalir ki musteri neden calismadigini gorsun, ama HICBIR API
       islemi (giris denemesi dahil) lisans kapaliyken calismaz. */
    if (u.pathname.startsWith('/api/') && u.pathname !== '/api/config' && !license.isLicensed()) {
      return json(res, 403, { error: license.licenseError() || 'Bu kurulumun lisansı aktif değil. AlfaPOS ile iletişime geçin.' });
    }

    if (u.pathname === '/api/courier/login' && req.method === 'POST') {
      const wait = auth.lockedForMs(ip);
      if (wait > 0) return json(res, 429, { error: `Çok fazla hatalı deneme. ${Math.ceil(wait / 1000)} saniye sonra tekrar deneyin.` });
      const body = await auth.readJsonBody(req);
      const courier = await auth.courierLogin(String(body.pin || ''));
      if (!courier) { auth.registerFail(ip); return json(res, 401, { error: 'PIN hatalı.' }); }
      auth.registerSuccess(ip);
      const token = auth.newSession({ role: 'courier', courierId: courier.id, courierName: courier.name });
      auth.setSessionCookie(req, res, token, 'courier');
      return json(res, 200, { ok: true, courierName: courier.name });
    }
    /* Restoran/admin girisi IKI ADIMA bolunmustur (13.09.2026, canli bir karisiklik
       sonrasi): 1) e-posta/telefon + BULUT PANEL SIFRESI (musterinin diger panellerde
       de kullandigi GERCEK sifre, customers.password_hash'e karsi dogrulanir), 2)
       SADECE 1. adim basarili olduktan sonra SambaPOS admin PIN'i sorulur. Onceki
       tek-ekranli tasarimda kullanici bulut sifresini SambaPOS PIN'i saniyor,
       ikisini karistiriyordu. 1. adimi gecen oturum GECICI "admin-pending" rolundedir -
       gercek admin uclarinin hicbirine erisemez, sadece 2. adimi tamamlayabilir. */
    if (u.pathname === '/api/admin/login-step1' && req.method === 'POST') {
      const wait = auth.lockedForMs(ip);
      if (wait > 0) return json(res, 429, { error: `Çok fazla hatalı deneme. ${Math.ceil(wait / 1000)} saniye sonra tekrar deneyin.` });
      const body = await auth.readJsonBody(req);
      const identifier = String(body.identifier || '').trim();
      const password = String(body.password || '');
      if (!identifier || !password) return json(res, 400, { error: 'E-posta/telefon ve şifrenizi girin.' });
      const verified = await license.verifyPassword(identifier, password);
      if (!verified.ok) { auth.registerFail(ip); return json(res, 401, { error: verified.error || 'E-posta/telefon veya şifre hatalı.' }); }
      auth.registerSuccess(ip);
      const token = auth.newSession({ role: 'admin-pending' });
      auth.setSessionCookie(req, res, token, 'admin');
      return json(res, 200, { ok: true });
    }
    if (u.pathname === '/api/admin/login-step2' && req.method === 'POST') {
      const wait = auth.lockedForMs(ip);
      if (wait > 0) return json(res, 429, { error: `Çok fazla hatalı deneme. ${Math.ceil(wait / 1000)} saniye sonra tekrar deneyin.` });
      const pending = auth.currentSession(req);
      if (!pending || pending.role !== 'admin-pending') return json(res, 401, { error: 'Önce e-posta ve şifrenizle giriş yapın.' });
      const body = await auth.readJsonBody(req);
      if (!(await auth.adminLogin(String(body.pin || '')))) { auth.registerFail(ip); return json(res, 401, { error: 'PIN hatalı.' }); }
      auth.registerSuccess(ip);
      const token = auth.newSession({ role: 'admin' });
      auth.setSessionCookie(req, res, token, 'admin');
      return json(res, 200, { ok: true });
    }
    if (u.pathname === '/api/logout' && req.method === 'POST') {
      auth.destroySession(req);
      auth.clearSessionCookie(req, res);
      return json(res, 200, { ok: true });
    }
    if (u.pathname === '/api/config') return json(res, 200, { appName: APP_NAME });

    /* Musteri takip sayfasinin (girissiz) canli veri kaynagi - bkz. renderTrackingPage
       yukarida. Token gecersizse veya adisyon SambaPOS'ta gercekten kapandiysa
       (kullanici karari: "adisyon kapanınca görmeyebilir") ok:false doner, sayfa
       bunu "süresi doldu" olarak gosterir. */
    const trackStatusMatch = u.pathname.match(/^\/api\/takip\/([A-Za-z0-9_-]+)\/status$/);
    if (trackStatusMatch && req.method === 'GET') {
      const ticketId = ticketIdForToken(trackStatusMatch[1]);
      if (!ticketId) return json(res, 200, { ok: false, error: 'Geçersiz takip linki.' });
      const info = await sambapos.ticketTrackingInfo(ticketId);
      if (!info || info.isClosed) return json(res, 200, { ok: false, error: 'Bu siparişin takip süresi sona erdi. Afiyet olsun!' });
      let status = 'hazirlaniyor';
      if (info.packageStatus === 'Yolda') status = 'yolda';
      else if (String(info.packageStatus || '').indexOf('Teslim Edildi') === 0) status = 'teslim';
      let lat = null, lng = null;
      if (status === 'yolda' && info.courierName) {
        const loc = allCourierLocations().find(l => l.courier_name === info.courierName);
        if (loc) { lat = loc.lat; lng = loc.lng; }
      }
      return json(res, 200, { ok: true, status, lat, lng });
    }

    if (u.pathname.startsWith('/api/')) {
      /* admin VE kurye cerezleri AYNI cihazda birbirinden BAGIMSIZ olarak
         gecerli olabilir (APK'lar ayni Chrome depolamasini paylasiyor) - HER
         BIRI kendi cerezine gore ayri ayri cozulur, biri digerini "kazanip"
         gecersiz kilmaz (bkz. auth.js'teki not, 13.09.2026 canli tespit). */
      const adminSession = auth.currentSession(req, 'admin');
      const courierSession = auth.currentSession(req, 'courier');
      if (!adminSession && !courierSession) return json(res, 401, { error: 'Oturum gerekli.' });
      // Geriye donuk uyumluluk: rol farki gozetmeyen yerlerde (ownsOrder,
      // /api/me) "hangisi varsa" seklinde tek bir session da lazim - admin
      // BURADA da ONCELIKLI ama SADECE bilgi/erisim-VAR-MI amacli, kurye'ye
      // OZEL uclar asla bunu kullanmaz (dogrudan courierSession'a bakarlar).
      const session = adminSession || courierSession;

      if (u.pathname === '/api/me' && req.method === 'GET') {
        return json(res, 200, { role: session.role, courierName: session.courierName || null });
      }
      if (u.pathname === '/api/courier/unassigned' && req.method === 'GET') {
        return json(res, 200, { orders: await sambapos.unassignedPackages() });
      }
      const claimMatch = u.pathname.match(/^\/api\/courier\/orders\/(\d+)\/claim$/);
      if (claimMatch && req.method === 'POST') {
        if (!courierSession) return json(res, 403, { error: 'Yetkiniz yok.' });
        try {
          await sambapos.claimPackage(claimMatch[1], courierSession.courierName);
        } catch (error) {
          return json(res, 409, { error: error.message });
        }
        logEvent(+claimMatch[1], courierSession.courierName, 'paket-alindi', null, null);
        wsServer.broadcastEvent({ kind: 'paket-alindi', ticketId: +claimMatch[1], courierName: courierSession.courierName });
        return json(res, 200, { ok: true });
      }
      if (u.pathname === '/api/courier/orders' && req.method === 'GET') {
        const all = await sambapos.activeCourierOrders();
        const scoped = adminSession ? all : all.filter(o => o.courierName === courierSession.courierName);
        return json(res, 200, { orders: scoped, appName: APP_NAME });
      }
      if (u.pathname === '/api/payment-types' && req.method === 'GET') {
        return json(res, 200, { types: await sambapos.paymentTypes() });
      }
      /* Kuryenin kendi ekraninda "bugun ne teslim ettim" ozeti - aksam raporu icin. */
      if (u.pathname === '/api/courier/my-deliveries' && req.method === 'GET') {
        if (!courierSession) return json(res, 403, { error: 'Yetkiniz yok.' });
        const day = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('date') || '') ? u.searchParams.get('date') : new Date().toISOString().slice(0, 10);
        const { start, end } = dayRangeUtc(day);
        const deliveries = courierDeliveries(courierSession.courierName, start, end);
        const total = deliveries.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);
        return json(res, 200, { date: day, count: deliveries.length, total, deliveries });
      }
      const contentMatch = u.pathname.match(/^\/api\/courier\/orders\/(\d+)\/content$/);
      if (contentMatch && req.method === 'GET') {
        /* "Sipariş içeriğini göster" butonu HEM Bekleyen Paketler (henuz kimseye
           atanmamis) HEM Uzerimdekiler listesinde gorunur (public/courier/app.js:73) -
           ama burada SADECE activeCourierOrders() (atanmis siparisler) icinde arandigi
           icin bekleyen bir paketin icerigine bakmaya calisan kurye hep "izin yok"
           aliyordu (13.09.2026, canli tespit). Atanmamis bir paketin icerigi herkese
           acik olmali (henuz sahiplenilmeden karar vermek icin), atanmis bir paketin
           icerigi ise SADECE sahibine/admin'e (ownsOrder). */
        const active = (await sambapos.activeCourierOrders()).find(o => String(o.id) === contentMatch[1]);
        if (active) {
          if (!ownsOrder(session, active)) return json(res, 403, { error: 'Bu siparişe erişiminiz yok.' });
        } else {
          const pending = (await sambapos.unassignedPackages()).find(o => String(o.id) === contentMatch[1]);
          if (!pending) return json(res, 403, { error: 'Bu siparişe erişiminiz yok.' });
        }
        return json(res, 200, { items: await sambapos.orderContent(contentMatch[1]) });
      }
      const deliveredMatch = u.pathname.match(/^\/api\/courier\/orders\/(\d+)\/delivered$/);
      if (deliveredMatch && req.method === 'POST') {
        const order = (await sambapos.activeCourierOrders()).find(o => String(o.id) === deliveredMatch[1]);
        if (!order || !ownsOrder(session, order)) return json(res, 403, { error: 'Bu siparişe erişiminiz yok.' });
        const body = await auth.readJsonBody(req);
        const noPayment = !!body.noPayment;
        let result;
        try {
          result = await sambapos.markDelivered(deliveredMatch[1], body.paymentTypeId, noPayment, session.courierId);
        } catch (error) {
          return json(res, 409, { error: error.message });
        }
        logEvent(order.id, order.courierName, result.closed ? 'teslim-edildi' : 'teslim-odeme-bekliyor', null, result.amountCollected);
        wsServer.broadcastEvent({
          kind: result.closed ? 'teslim-edildi' : 'teslim-odeme-bekliyor',
          ticketId: order.id, number: order.number, courierName: order.courierName, amountCollected: result.amountCollected
        });
        return json(res, 200, { ok: true, ...result });
      }
      /* Restoran panelindeki "Takip Linki" butonu (28.09.2026) - musteriye ELLE
         gonderilmek uzere (WhatsApp vb.) o siparise ozel bir link uretir/dondurur.
         Ayni zamanda SambaPOS'un kendi TicketStates'ine "Kurye Takip Linki" olarak
         yazar - restoranin kendi mesaj/otomasyon sablonunda boyle bir alani
         gosterme imkani varsa oraya EKLEYEBILSIN diye (bu kismin calisip
         calismayacagi ucuncu parti sablona bagli, biz sadece degeri saglariz). */
      const trackLinkMatch = u.pathname.match(/^\/api\/admin\/orders\/(\d+)\/tracking-link$/);
      if (trackLinkMatch && req.method === 'POST') {
        if (session.role !== 'admin') return json(res, 403, { error: 'Yetkiniz yok.' });
        const ticketId = +trackLinkMatch[1];
        const token = getOrCreateTrackingToken(ticketId);
        const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
        const url = `${proto}://${req.headers.host}/takip/${token}`;
        /* Bulut, bu token'i tunel uzerinden (kuryeler.ornek-alanadi.com) dogru restorana
           yonlendirebilsin diye haberdar edilir - basarisiz olursa link YINE DE
           donulur (LAN'dan/dogrudan erisimde zaten calisir, sadece tunelden
           erisimde secim cerezini atlama ozelligi o an calismamis olur). */
        await license.registerTrackingToken(token).catch(() => {});
        try { await sambapos.writeTicketTrackingState(ticketId, url); } catch { /* siparis SQL'de yoksa link yine de donulur */ }
        return json(res, 200, { ok: true, url });
      }
      if (u.pathname === '/api/admin/couriers' && req.method === 'GET') {
        if (session.role !== 'admin') return json(res, 403, { error: 'Yetkiniz yok.' });
        return json(res, 200, { couriers: await sambapos.couriers() });
      }
      if (u.pathname === '/api/courier/location' && req.method === 'POST') {
        if (!courierSession) return json(res, 403, { error: 'Yetkiniz yok.' });
        const body = await auth.readJsonBody(req);
        const lat = Number(body.lat), lng = Number(body.lng), accuracy = Number(body.accuracy) || null;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json(res, 400, { error: 'Geçersiz konum.' });
        setCourierLocation(courierSession.courierName, lat, lng, accuracy);
        wsServer.broadcastEvent({ kind: 'konum', courierName: courierSession.courierName, lat, lng, accuracy });
        return json(res, 200, { ok: true });
      }
      if (u.pathname === '/api/admin/locations' && req.method === 'GET') {
        if (session.role !== 'admin') return json(res, 403, { error: 'Yetkiniz yok.' });
        return json(res, 200, { locations: allCourierLocations() });
      }
      /* "Canli Akis" sekmesi SADECE WebSocket push'una bagliydi - kuryeler.ornek-alanadi.com
         tuneli WS'i henuz tasimadigi icin (bkz. tunnel.js/gk-web.js) tunel uzerinden
         erisimde sekme HER ZAMAN bombos kaliyordu (13.09.2026, canli tespit). Bu uc,
         zaten var olan ama hic kullanilmayan recentEvents() ile son olaylari REST
         uzerinden de getirir - WS calisiyorsa aninda, calismiyorsa (tunel) ilk
         yuklemede/pollingde gorunur olur. */
      if (u.pathname === '/api/admin/recent-events' && req.method === 'GET') {
        if (session.role !== 'admin') return json(res, 403, { error: 'Yetkiniz yok.' });
        return json(res, 200, { events: recentEvents(50) });
      }
      /* "Paketçi Raporu": bugun (ya da secilen tarih) her kuryenin kac paket teslim
         ettigi + ne kadar tahsil ettigi, "su an uzerinde" bekleyen/yoldaki paket sayisiyla
         birlikte - kendi-restoranim-kurye'deki admin raporuyla ayni mantik. */
      if (u.pathname === '/api/admin/report' && req.method === 'GET') {
        if (session.role !== 'admin') return json(res, 403, { error: 'Yetkiniz yok.' });
        const day = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('date') || '') ? u.searchParams.get('date') : new Date().toISOString().slice(0, 10);
        const { start, end } = dayRangeUtc(day);
        const delivered = deliverySummary(start, end);
        const activeByCourier = {};
        for (const o of await sambapos.activeCourierOrders()) {
          const bucket = activeByCourier[o.courierName] || (activeByCourier[o.courierName] = { pending: 0, enroute: 0 });
          if (o.packageStatus === 'Yolda') bucket.enroute++; else bucket.pending++;
        }
        const names = new Set([...delivered.map(d => d.courier_name), ...Object.keys(activeByCourier)]);
        const byCourier = [...names].sort().map(name => {
          const d = delivered.find(row => row.courier_name === name);
          const a = activeByCourier[name] || { pending: 0, enroute: 0 };
          return { courierName: name, pending: a.pending, enroute: a.enroute, deliveredCount: d ? d.count : 0, deliveredTotal: d ? d.total : 0 };
        });
        return json(res, 200, { date: day, byCourier });
      }
      /* GECICI TESHIS UCU: "kurye PIN'i yanlis" hatasinin gercek nedenini bulmak icin -
         hangi Kullanici Rolu ID'sinin gercekten "Paketciler" oldugunu ve o rol altinda
         kayitli PIN'leri gosterir. Sadece admin oturumuyla erisilir. Sorun cozulunce
         bu uc kaldirilacak. */
      if (u.pathname === '/api/admin/debug/roles' && req.method === 'GET') {
        if (session.role !== 'admin') return json(res, 403, { error: 'Yetkiniz yok.' });
        return json(res, 200, { rows: await sambapos.debugRolesAndUsers() });
      }
      return json(res, 404, { error: 'Bulunamadı' });
    }

    const trackPageMatch = u.pathname.match(/^\/takip\/([A-Za-z0-9_-]+)$/);
    if (trackPageMatch && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(renderTrackingPage(trackPageMatch[1]));
    }

    serveStatic(req, res, u.pathname);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

http.createServer(handleRequest).listen(PORT, config.bindHost, function () {
  wsServer.attach(this);
  console.log(`${APP_NAME}: http://127.0.0.1:${PORT}  (kurye: /courier, restoran: /restoran)`);
});
/* config.bindHost YOKSA (restoran kurulumlarinin normal hali) tum arayuzlerde dinler -
   kurye telefonlari ayni WiFi'den yerel IP ile erisebilsin diye kasitli. Bu VPS'teki
   test ornegi gibi ONUNDE Caddy/HTTPS olan yerlerde config.json'a "bindHost":"127.0.0.1"
   eklenerek dogrudan disariya acilmasi engellenir. */

/* Buluttan (kuryeler.ornek-alanadi.com) uzaktan erisim tuneli - ayri bir Gelismis Kurye
   aktivasyon anahtari VARSA baslar, yoksa hic denemez (yerel-sadece kurulumlar
   etkilenmez). Lisans kontrolunden (license.js) BAGIMSIZ, kendi baglanti/yeniden
   deneme dongusune sahiptir. */
try { require('./tunnel').start(handleRequest); } catch (error) { console.error('Tünel modülü başlatılamadı (yoksayıldı):', error.message); }

/* Otomatik guncelleme - C:\toplu\kurye-bulut-ajan\updater.js ile AYNI kanitlanmis
   desen. config.json'da "cloudServerUrl" YOKSA app.ornek-alanadi.com varsayilir. */
try { require('./updater').start(config); } catch (error) { console.error('Güncelleme modülü başlatılamadı (yoksayıldı):', error.message); }

process.on('uncaughtException', error => console.error('Yakalanmamış hata:', error));
process.on('unhandledRejection', error => console.error('Yakalanmamış Promise reddi:', error));
