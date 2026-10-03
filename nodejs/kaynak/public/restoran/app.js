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
  document.getElementById('feedView').hidden = tab !== 'feed';
  document.getElementById('mapView').hidden = tab !== 'map';
  document.getElementById('reportView').hidden = tab !== 'report';
  if (tab === 'map') { ensureMap(); loadLocations(); setTimeout(() => map && map.invalidateSize(), 50); }
  if (tab === 'report') loadReport();
}

function addFeedItem(event, whenText) {
  document.getElementById('feedEmpty').hidden = true;
  const feed = document.getElementById('feed');
  const el = document.createElement('div');
  let cls = 'claim', text = '';
  if (event.kind === 'paket-alindi') {
    cls = 'claim';
    text = `<span class="who">${event.courierName}</span> paket #${event.ticketId} aldı`;
  } else if (event.kind === 'teslim-edildi') {
    cls = 'delivered';
    text = `<span class="who">${event.courierName}</span> #${event.number || event.ticketId} teslim etti — ${money(event.amountCollected)} tahsil edildi`;
  } else if (event.kind === 'teslim-odeme-bekliyor') {
    cls = 'pending-payment';
    text = `<span class="who">${event.courierName}</span> #${event.number || event.ticketId} teslim etti — ödeme ALINMADI, adisyon açık`;
  } else {
    return;
  }
  el.className = `feed-item ${cls}`;
  el.innerHTML = `<span>${text}</span><span class="when">${whenText || timeNow()}</span>`;
  feed.prepend(el);
}

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

/* --- Paketçi Raporu --- */
async function loadReport() {
  let data;
  try { data = await api('/api/admin/report'); } catch { return; }
  const list = document.getElementById('reportList');
  const empty = document.getElementById('reportEmpty');
  empty.hidden = data.byCourier.length > 0;
  list.innerHTML = data.byCourier.map(c => `
    <div class="feed-item">
      <span><span class="who">${c.courierName}</span><br><span class="when">${c.pending} bekliyor · ${c.enroute} yolda</span></span>
      <span class="when">${c.deliveredCount} teslim · ${money(c.deliveredTotal)}</span>
    </div>`).join('');
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
document.body.addEventListener('click', e => {
  const name = e.target.closest('[data-focus-courier]');
  if (name) focusCourier(name.dataset.focusCourier);
});

api('/api/me').then(me => {
  if (me.role !== 'admin') return;
  document.getElementById('loginView').hidden = true;
  document.getElementById('mainView').hidden = false;
  connectWs();
  startPolling();
}).catch(() => {});
