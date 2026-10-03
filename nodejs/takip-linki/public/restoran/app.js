if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/restoran/sw.js').catch(() => {}));
}

function money(n) { return `${(Number(n) || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺`; }
function timeNow() { return new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }); }
function ago(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'az önce';
  if (mins < 60) return `${mins} dk önce`;
  return `${Math.round(mins / 60)} sa önce`;
}

async function api(path, opts) {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'İstek başarısız.');
  return data;
}

/* Giris IKI ADIMDIR: once e-posta/telefon + bulut panel sifresi (login-step1),
   basarili olursa SambaPOS admin PIN'i sorulur (login-step2) - "hangi sifreyi
   nereye yazacagim" karisikligini onlemek icin (13.09.2026'da eklendi). */
async function loginStep1() {
  const identifier = document.getElementById('identifierInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  const errBox = document.getElementById('step1Err');
  errBox.hidden = true;
  try {
    await api('/api/admin/login-step1', { method: 'POST', body: JSON.stringify({ identifier, password }) });
    document.getElementById('step1Card').hidden = true;
    document.getElementById('step2Card').hidden = false;
    document.getElementById('pinInput').focus();
  } catch (error) {
    errBox.textContent = error.message;
    errBox.hidden = false;
  }
}
async function loginStep2() {
  const pin = document.getElementById('pinInput').value.trim();
  const errBox = document.getElementById('step2Err');
  errBox.hidden = true;
  try {
    await api('/api/admin/login-step2', { method: 'POST', body: JSON.stringify({ pin }) });
    document.getElementById('loginView').hidden = true;
    document.getElementById('mainView').hidden = false;
    connectWs();
    startPolling();
  } catch (error) {
    errBox.textContent = error.message;
    errBox.hidden = false;
  }
}
function backToStep1() {
  document.getElementById('step2Card').hidden = true;
  document.getElementById('step1Card').hidden = false;
  document.getElementById('pinInput').value = '';
}

async function logout() {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.reload();
}

function switchTab(tab) {
  document.getElementById('tabFeed').classList.toggle('active', tab === 'feed');
  document.getElementById('tabMap').classList.toggle('active', tab === 'map');
  document.getElementById('tabReport').classList.toggle('active', tab === 'report');
  document.getElementById('tabPayments').classList.toggle('active', tab === 'payments');
  document.getElementById('tabCouriers').classList.toggle('active', tab === 'couriers');
  document.getElementById('tabSettings').classList.toggle('active', tab === 'settings');
  document.getElementById('feedView').hidden = tab !== 'feed';
  document.getElementById('mapView').hidden = tab !== 'map';
  document.getElementById('reportView').hidden = tab !== 'report';
  document.getElementById('paymentsView').hidden = tab !== 'payments';
  document.getElementById('couriersView').hidden = tab !== 'couriers';
  document.getElementById('settingsView').hidden = tab !== 'settings';
  if (tab === 'map') { ensureMap(); loadLocations(); setTimeout(() => map && map.invalidateSize(), 50); }
  if (tab === 'report') loadReport();
  if (tab === 'payments') loadPayments();
  if (tab === 'couriers') loadCouriers();
  if (tab === 'settings') refreshThemeUI();
}

/* Musteriye ELLE gonderilecek takip linkini uretir/getirir ve kopyalar (28.09.2026,
   kullanici karari: "benim müşteriye manuel link gondericem" - otomatik SMS YOK).
   Panelde ayri bir "siparis listesi" olmadigi icin en dogal yer, ticketId'nin zaten
   gorundugu Canli Akis satirlarindaki bu buton. */
async function copyTrackingLink(ticketId) {
  try {
    const { url } = await api(`/api/admin/orders/${ticketId}/tracking-link`, { method: 'POST' });
    try { await navigator.clipboard.writeText(url); alert('Takip linki kopyalandı:\n' + url); }
    catch { prompt('Takip linki (kopyalayın):', url); }
  } catch (error) {
    alert(error.message);
  }
}

function addFeedItem(event, whenText) {
  document.getElementById('feedEmpty').hidden = true;
  const feed = document.getElementById('feed');
  const el = document.createElement('div');
  let cls = 'claim', text = '';
  const trackBtn = event.ticketId ? `<button class="track-link-btn" data-track-ticket="${event.ticketId}" type="button" title="Müşteriye gönderilecek takip linkini kopyala">🔗</button>` : '';
  if (event.kind === 'paket-alindi') {
    cls = 'claim';
    text = `<span class="who">${event.courierName}</span> paket #${event.ticketId} aldı ${trackBtn}`;
  } else if (event.kind === 'teslim-edildi') {
    cls = 'delivered';
    text = `<span class="who">${event.courierName}</span> #${event.number || event.ticketId} teslim etti — ${money(event.amountCollected)} tahsil edildi ${trackBtn}`;
  } else if (event.kind === 'teslim-odeme-bekliyor') {
    cls = 'pending-payment';
    text = `<span class="who">${event.courierName}</span> #${event.number || event.ticketId} teslim etti — ödeme ALINMADI, adisyon açık ${trackBtn}`;
  } else {
    return;
  }
  el.className = `feed-item ${cls}`;
  el.innerHTML = `<span>${text}</span><span class="when">${whenText || timeNow()}</span>`;
  feed.prepend(el);
}
document.addEventListener('click', e => {
  const ticketId = e.target && e.target.dataset && e.target.dataset.trackTicket;
  if (ticketId) copyTrackingLink(ticketId);
});

/* "Canli Akis" SADECE WebSocket push'una bagliydi - kuryeler.ornek-alanadi.com tuneli
   WS'i henuz tasimadigi icin tunel uzerinden erisimde sekme HER ZAMAN bombos
   kaliyordu (13.09.2026, canli tespit). Burada REST uzerinden son olaylar
   cekilir - WS calisiyorsa (yerel/test.ornek-alanadi.com) zaten aninda gorunuyor,
   calismiyorsa (tunel) bu polling ile en azindan gecmis/yakin zamanli olaylar
   gorunur olur. Ayni olayin WS+polling ile IKI KEZ gorunmesi ihtimaline karsi
   sadece veritabani id'si DAHA ONCE gosterilmemis olaylar eklenir. */
let seenEventIds = new Set();
async function loadRecentEvents() {
  let events = [];
  try { events = (await api('/api/admin/recent-events')).events; } catch { return; }
  const fresh = events.filter(e => !seenEventIds.has(e.id)).reverse();
  fresh.forEach(e => {
    seenEventIds.add(e.id);
    addFeedItem(
      { kind: e.event, courierName: e.courier_name, ticketId: e.ticket_id, number: null, amountCollected: e.amount },
      ago(e.at)
    );
  });
}

/* --- Kurye konumlari (harita) --- */
let map = null, markers = new Map();
function ensureMap() {
  if (map) return;
  map = L.map('map').setView([39.92, 32.85], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
}
function focusCourier(name) {
  const marker = markers.get(name);
  if (!marker) return;
  switchTab('map');
  map.setView(marker.getLatLng(), 17);
  marker.openPopup();
}
async function loadLocations() {
  let locations = [];
  try { locations = (await api('/api/admin/locations')).locations; } catch { return; }
  ensureMap();
  const list = document.getElementById('locationList');
  list.innerHTML = locations.length ? locations.map(l => `
    <div class="feed-item" data-focus-courier="${l.courier_name}" style="cursor:pointer">
      <span class="who">${l.courier_name}</span><span class="when">${ago(l.updated_at)}</span>
    </div>`).join('') : '<div class="empty">Henüz konum paylaşan kurye yok.</div>';
  const seen = new Set();
  locations.forEach(l => {
    seen.add(l.courier_name);
    const pos = [l.lat, l.lng];
    if (markers.has(l.courier_name)) markers.get(l.courier_name).setLatLng(pos);
    else markers.set(l.courier_name, L.marker(pos).addTo(map).bindPopup(l.courier_name));
    markers.get(l.courier_name).setPopupContent(`<b>${l.courier_name}</b><br>${ago(l.updated_at)}`);
  });
  for (const [name, marker] of markers) if (!seen.has(name)) { map.removeLayer(marker); markers.delete(name); }
  if (locations.length && !ensureMap.centered) { map.setView([locations[0].lat, locations[0].lng], 13); ensureMap.centered = true; }
}

/* --- Paketçi Raporu: kuryenin üstüne basılınca hangi ödeme türünden ne kadar
   aldığı görünsün (kullanıcı isteği, 15.09.2026: "örneğin paketçi üstüne basılınca
   görünsün - yemek kartı ve online ayrı, nakit, kredi kartı"). Ayrı bir uç yerine
   zaten çekilen sipariş detaylarından (Ödeme Raporu ile aynı veri) kurye bazında
   kırılım burada hesaplanır - gereksiz ikinci bir sorgu deseni eklenmez. */
let reportDeliveriesCache = [];
let expandedCourier = null;
function courierPaymentBreakdown(courierName) {
  const rows = reportDeliveriesCache.filter(d => d.courierName === courierName && d.amountCollected > 0);
  const byType = new Map();
  rows.forEach(d => {
    const name = d.paymentTypeName || 'Bilinmiyor';
    byType.set(name, (byType.get(name) || 0) + (Number(d.amountCollected) || 0));
  });
  return [...byType.entries()];
}
async function loadReport() {
  let data, details;
  try {
    [data, details] = await Promise.all([api('/api/admin/report'), api(`/api/admin/report/deliveries?date=${new Date().toISOString().slice(0, 10)}`)]);
  } catch { return; }
  reportDeliveriesCache = details.deliveries || [];
  const list = document.getElementById('reportList');
  const empty = document.getElementById('reportEmpty');
  empty.hidden = data.byCourier.length > 0;
  list.innerHTML = data.byCourier.map(c => {
    const open = expandedCourier === c.courierName;
    const breakdown = open ? courierPaymentBreakdown(c.courierName) : [];
    return `
    <div class="feed-item courier-row" data-courier-row="${c.courierName}" style="flex-direction:column;align-items:stretch;cursor:pointer">
      <div style="display:flex;justify-content:space-between;align-items:center;width:100%">
        <span><span class="who">${c.courierName}</span><br><span class="when">${c.pending} bekliyor · ${c.enroute} yolda</span></span>
        <span class="when">${c.deliveredCount} teslim · ${money(c.deliveredTotal)}</span>
      </div>
      ${open ? `<div class="pay-breakdown" style="padding:10px 0 0">${breakdown.length ? breakdown.map(([name, total]) => `<div class="pay-row"><span>${name}</span><span>${money(total)}</span></div>`).join('') : '<div class="muted" style="font-size:12.5px">Bugün ödeme kaydı yok.</div>'}</div>` : ''}
    </div>`;
  }).join('');
}

/* --- Ödeme Raporu: "sadece toplam ödeme değil, paranın nasıl alındığını ayrı ayrı
   göster" + sipariş bazlı detay tablosu (kullanıcı isteği, 15.09.2026). --- */
function paymentsSelectedDate() {
  const input = document.getElementById('paymentsDate');
  return input.value || new Date().toISOString().slice(0, 10);
}
async function loadPayments() {
  const date = paymentsSelectedDate();
  let report, details;
  try {
    [report, details] = await Promise.all([
      api(`/api/admin/report?date=${date}`),
      api(`/api/admin/report/deliveries?date=${date}`)
    ]);
  } catch { return; }

  const breakdown = document.getElementById('paymentsBreakdown');
  const rows = (report.payments || []).map(p => `
    <div class="pay-row"><span>${p.paymentTypeName}<span class="cnt">(${p.count})</span></span><span>${money(p.total)}</span></div>`).join('');
  breakdown.innerHTML = rows + `<div class="pay-row total"><span>Genel Toplam</span><span>${money(report.grandTotal || 0)}</span></div>`;

  const body = document.getElementById('paymentsDetailBody');
  const empty = document.getElementById('paymentsDetailEmpty');
  const list = details.deliveries || [];
  empty.hidden = list.length > 0;
  body.innerHTML = list.map(d => {
    const net = (Number(d.amountCollected) || 0) - 0; // iade/iptal takibi henuz yok - net = alinan tutar
    const time = d.at ? new Date(d.at.replace(' ', 'T') + 'Z').toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : '';
    return `<tr>
      <td>#${d.ticketNumber || d.ticketId}</td><td>${time}</td><td>${d.orderSource || '–'}</td><td>${d.courierName || ''}</td><td>${d.customerName || ''}</td>
      <td>${d.orderTotal != null ? money(d.orderTotal) : '–'}</td><td>${d.paymentTypeName || (d.amountCollected ? '–' : 'Ödeme bekliyor')}</td>
      <td>${money(d.amountCollected)}</td><td>${d.changeAmount ? money(d.changeAmount) : '–'}</td><td>${money(net)}</td>
    </tr>`;
  }).join('');
}

/* --- Kurye Ayarları: isim + PIN listesi (kullanıcı isteği, 15.09.2026: "yönetici
   kurye ayarı görsün, şifrelerini görsün"). Salt-okunur - kuryeler SambaPOS'un kendi
   "Paketçiler" kullanıcı rolünden geliyor, ekleme/silme/PIN değiştirme SambaPOS'un
   kendi Kullanıcılar ekranından yapılmalı (bu uygulama SambaPOS'un kimlik/kullanıcı
   tablosuna YAZMIYOR - kasıtlı, oradaki PIN doğrulama mantığına karışmamak için). */
async function loadCouriers() {
  let data, settings;
  try { [data, settings] = await Promise.all([api('/api/admin/couriers'), api('/api/admin/courier-settings')]); } catch { return; }
  const notifyByName = new Map(settings.couriers.map(c => [c.name, c.notifyEnabled]));
  const list = document.getElementById('couriersList');
  const empty = document.getElementById('couriersEmpty');
  empty.hidden = data.couriers.length > 0;
  list.innerHTML = data.couriers.map(c => {
    const on = notifyByName.has(c.name) ? notifyByName.get(c.name) : true;
    return `
    <div class="feed-item" style="flex-direction:column;align-items:stretch">
      <div style="display:flex;justify-content:space-between;align-items:center;width:100%">
        <span class="who">${c.name}</span>
        <span class="when" style="font-size:16px;font-weight:700;letter-spacing:2px">${c.pin}</span>
      </div>
      <div class="seg" style="margin-top:10px" data-notify-seg="${c.name}">
        <button data-notify-opt="on" class="${on ? 'active' : ''}">Bildirim Açık</button>
        <button data-notify-opt="off" class="${!on ? 'active' : ''}">Bildirim Kapalı</button>
      </div>
    </div>`;
  }).join('');
}

function connectWs() {
  document.getElementById('statusDot').classList.remove('off');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onmessage = e => {
    try {
      const event = JSON.parse(e.data);
      if (event.kind === 'konum') { loadLocations(); return; }
      addFeedItem(event);
      if (event.kind === 'teslim-edildi' || event.kind === 'teslim-odeme-bekliyor') loadReport();
    } catch {}
  };
  ws.onclose = () => { document.getElementById('statusDot').classList.add('off'); setTimeout(connectWs, 4000); };
  ws.onerror = () => ws.close();
}

/* kuryeler.ornek-alanadi.com tuneli su an sadece HTTP istek/cevap tasiyor, kendi
   WebSocket kanalini (canli konum/akis push'u) TASIMIYOR - o yuzden tunel
   uzerinden erisimde WS hic baglanamiyor, "canli konum takip edemiyorum,
   sabit kaliyor" sikayetinin gercek nedeni bu (13.09.2026, canli tespit).
   Tam cozum (WS-icinde-WS tuneli) ayri bir gelistirme - simdilik konum
   yenilemesi WS'e bagimli KALMAYACAK sekilde, harita sekmesi kapaliyken de
   surekli ve sik (6sn) yapiliyor; boylece tunel uzerinden de "neredeyse
   canli" gorunur. */
function startPolling() {
  loadLocations();
  loadReport();
  loadRecentEvents();
  setInterval(loadLocations, 6000);
  setInterval(loadRecentEvents, 6000);
}

document.getElementById('step1Btn').onclick = loginStep1;
document.getElementById('step2Btn').onclick = loginStep2;
document.getElementById('backBtn').onclick = backToStep1;
document.getElementById('passwordInput').addEventListener('keydown', e => { if (e.key === 'Enter') loginStep1(); });
document.getElementById('identifierInput').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('passwordInput').focus(); });
document.getElementById('pinInput').addEventListener('keydown', e => { if (e.key === 'Enter') loginStep2(); });
document.getElementById('logoutBtn').onclick = logout;
document.getElementById('tabFeed').onclick = () => switchTab('feed');
document.getElementById('tabMap').onclick = () => switchTab('map');
document.getElementById('tabReport').onclick = () => switchTab('report');
document.getElementById('tabPayments').onclick = () => switchTab('payments');
document.getElementById('tabCouriers').onclick = () => switchTab('couriers');
document.getElementById('tabSettings').onclick = () => switchTab('settings');
document.body.addEventListener('click', e => {
  const name = e.target.closest('[data-focus-courier]');
  if (name) focusCourier(name.dataset.focusCourier);
  const courierRow = e.target.closest('[data-courier-row]');
  if (courierRow) {
    const name2 = courierRow.dataset.courierRow;
    expandedCourier = expandedCourier === name2 ? null : name2;
    loadReport();
  }
  const notifyBtn = e.target.closest('[data-notify-opt]');
  if (notifyBtn) {
    const seg = notifyBtn.closest('[data-notify-seg]');
    const courierName = seg.dataset.notifySeg;
    const enabled = notifyBtn.dataset.notifyOpt === 'on';
    api('/api/admin/courier-settings', { method: 'POST', body: JSON.stringify({ courierName, notifyEnabled: enabled }) })
      .then(loadCouriers).catch(() => {});
  }
});

document.getElementById('paymentsDate').value = new Date().toISOString().slice(0, 10);
document.getElementById('paymentsDate').addEventListener('change', loadPayments);
document.getElementById('paymentsTodayBtn').onclick = () => { document.getElementById('paymentsDate').value = new Date().toISOString().slice(0, 10); loadPayments(); };

function refreshThemeUI() {
  const theme = window.gksTheme ? gksTheme.get() : 'system';
  document.querySelectorAll('#themeSeg [data-theme-opt]').forEach(b => b.classList.toggle('active', b.dataset.themeOpt === theme));
}
document.querySelectorAll('#themeSeg [data-theme-opt]').forEach(b => b.onclick = () => { gksTheme.set(b.dataset.themeOpt); refreshThemeUI(); });

api('/api/me').then(me => {
  if (me.role !== 'admin') return;
  document.getElementById('loginView').hidden = true;
  document.getElementById('mainView').hidden = false;
  connectWs();
  startPolling();
}).catch(() => {});
