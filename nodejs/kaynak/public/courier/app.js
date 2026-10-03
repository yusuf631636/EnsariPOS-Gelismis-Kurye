if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/courier/sw.js').catch(() => {}));
}

let activeTab = 'unassigned';
let selectedPayTypeId = null;
let deliverTicketId = null;
let payTypesCache = null;
let knownMineIds = new Set();
let hasLoadedMineOnce = false; // ilk yuklemede mevcut siparisleri "yeni" gibi seslendirmemek icin

function money(n) { return `${(Number(n) || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺`; }

/* Restoran (SambaPOS'un kendi ekranindan) bu kuryeye yeni bir paket atadiginda sesli/titresimli
   uyari - kendi-restoranim-kurye ile ayni dogrulanmis desen ("Siparişiniz var"). */
function announceNewOrder() {
  try {
    speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance('Siparişiniz var');
    utter.lang = 'tr-TR';
    speechSynthesis.speak(utter);
  } catch { /* Speech API desteklenmiyor olabilir - sessizce gec */ }
  try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch {}
}

async function api(path, opts) {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'İstek başarısız.');
  return data;
}

async function login() {
  const pin = document.getElementById('pinInput').value.trim();
  const errBox = document.getElementById('loginErr');
  errBox.hidden = true;
  try {
    const data = await api('/api/courier/login', { method: 'POST', body: JSON.stringify({ pin }) });
    document.getElementById('courierName').textContent = data.courierName;
    document.getElementById('loginView').hidden = true;
    document.getElementById('mainView').hidden = false;
    startPolling();
  } catch (error) {
    errBox.textContent = error.message;
    errBox.hidden = false;
  }
}

async function logout() {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.reload();
}

function switchTab(tab) {
  activeTab = tab;
  document.getElementById('tabUnassigned').classList.toggle('active', tab === 'unassigned');
  document.getElementById('tabMine').classList.toggle('active', tab === 'mine');
  document.getElementById('tabDeliveries').classList.toggle('active', tab === 'deliveries');
  document.getElementById('unassignedView').hidden = tab !== 'unassigned';
  document.getElementById('mineView').hidden = tab !== 'mine';
  document.getElementById('deliveriesView').hidden = tab !== 'deliveries';
  if (tab === 'deliveries') loadDeliveries();
}

function orderCard({ id, number, total, customerName, address, phone }, kind) {
  const el = document.createElement('div');
  el.className = 'order';
  el.innerHTML = `
    <div class="order-top"><span class="num">#${number || id}</span><span class="amount">${money(total)}</span></div>
    <div class="order-name">${customerName || 'Bilinmeyen'}</div>
    ${address ? `<div class="order-address">${address}</div>` : ''}
    <div class="order-meta">${phone ? `<span>${phone}</span>` : ''}</div>
    <div class="actions">
      ${phone ? `<a href="tel:${phone}">📞 Ara</a>` : `<span class="unavailable">Telefon yok</span>`}
      ${address ? `<a href="https://maps.google.com/?q=${encodeURIComponent(address)}" target="_blank">🗺️ Yol Tarifi</a>` : `<span class="unavailable">Adres yok</span>`}
    </div>
    <button class="content-toggle" data-content="${id}">Sipariş içeriğini göster</button>
    ${kind === 'unassigned' ? `<button class="claim-btn" data-claim="${id}">Bu paketi al</button>` : `<button class="deliver-btn" data-deliver="${id}">Teslim Et</button>`}
  `;
  return el;
}

async function loadUnassigned() {
  const data = await api('/api/courier/unassigned');
  const list = document.getElementById('unassignedList');
  const empty = document.getElementById('unassignedEmpty');
  document.getElementById('countUnassigned').textContent = data.orders.length ? ` (${data.orders.length})` : '';
  list.innerHTML = '';
  empty.hidden = data.orders.length > 0;
  data.orders.forEach(order => list.appendChild(orderCard(order, 'unassigned')));
}

async function loadMine() {
  const data = await api('/api/courier/orders');
  const list = document.getElementById('mineList');
  const empty = document.getElementById('mineEmpty');
  document.getElementById('countMine').textContent = data.orders.length ? ` (${data.orders.length})` : '';

  const currentIds = new Set(data.orders.map(o => o.id));
  const isNewOrder = hasLoadedMineOnce && [...currentIds].some(id => !knownMineIds.has(id));
  if (isNewOrder) announceNewOrder();
  hasLoadedMineOnce = true;
  knownMineIds = currentIds;

  list.innerHTML = '';
  empty.hidden = data.orders.length > 0;
  data.orders.forEach(order => {
    const el = orderCard(order, 'mine');
    const badge = document.createElement('span');
    badge.className = `badge ${order.packageStatus === 'Yolda' ? 'yolda' : 'bekliyor'}`;
    badge.textContent = order.packageStatus || 'Bekliyor';
    el.querySelector('.order-meta').appendChild(badge);
    list.appendChild(el);
  });
}

async function loadDeliveries() {
  const data = await api('/api/courier/my-deliveries');
  document.getElementById('deliveriesSummary').innerHTML = `<b>${data.count}</b> paket teslim edildi · <b>${money(data.total)}</b> tahsilat <span class="muted">(bugün)</span>`;
  const list = document.getElementById('deliveriesList');
  const empty = document.getElementById('deliveriesEmpty');
  empty.hidden = data.deliveries.length > 0;
  list.innerHTML = data.deliveries.map(d => `
    <div class="order">
      <div class="order-top"><span class="num">#${d.ticket_id}</span><span class="amount">${money(d.amount)}</span></div>
      <div class="order-meta"><span>${new Date(d.at.replace(' ', 'T') + 'Z').toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</span></div>
    </div>`).join('');
}

async function refresh() {
  try {
    document.getElementById('statusDot').classList.remove('off');
    await Promise.all([loadUnassigned(), loadMine()]);
  } catch {
    document.getElementById('statusDot').classList.add('off');
  }
}

function startPolling() {
  refresh();
  setInterval(refresh, 8000);
  startLocationSharing();
}

/* Kurye izin verdigi surece konumu ~15 saniyede bir sunucuya gonderir (restoran ekranindaki
   canli haritada gorunsun diye) - kendi-restoranim-kurye ile ayni dogrulanmis desen. */
let watchId = null;
function startLocationSharing() {
  if (!('geolocation' in navigator) || watchId !== null) return;
  let lastSent = 0;
  watchId = navigator.geolocation.watchPosition(
    position => {
      const now = Date.now();
      if (now - lastSent < 15000) return;
      lastSent = now;
      api('/api/courier/location', { method: 'POST', body: JSON.stringify({ lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy }) }).catch(() => {});
    },
    () => { /* izin reddedildi/hata - sessizce devam, konum paylasilmadan da uygulama calisir */ },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
  );
}

async function claimPackage(id) {
  try {
    await api(`/api/courier/orders/${id}/claim`, { method: 'POST' });
    switchTab('mine');
    refresh();
  } catch (error) {
    alert(error.message);
  }
}

async function openContent(id) {
  const sheet = document.getElementById('contentSheet');
  const rows = document.getElementById('contentRows');
  rows.innerHTML = '<div class="muted">Yükleniyor…</div>';
  sheet.hidden = false;
  try {
    const data = await api(`/api/courier/orders/${id}/content`);
    rows.innerHTML = data.items.map(item => `<div class="content-row"><span><span class="qty">${item.quantity}×</span>${item.name}</span><span>${money(item.price * item.quantity)}</span></div>`).join('') || '<div class="muted">İçerik bulunamadı.</div>';
  } catch (error) {
    rows.innerHTML = `<div class="err">${error.message}</div>`;
  }
}

async function openPaySheet(id) {
  deliverTicketId = id;
  selectedPayTypeId = null;
  document.getElementById('payErr').hidden = true;
  document.getElementById('confirmDeliverBtn').disabled = true;
  const grid = document.getElementById('payGrid');
  grid.innerHTML = '<div class="muted">Yükleniyor…</div>';
  document.getElementById('paySheet').hidden = false;
  try {
    if (!payTypesCache) payTypesCache = (await api('/api/payment-types')).types;
    grid.innerHTML = '';
    payTypesCache.forEach(pt => {
      const btn = document.createElement('button');
      btn.className = 'pay-opt';
      btn.textContent = pt.name;
      btn.dataset.payId = pt.id;
      btn.onclick = () => selectPayType(pt.id);
      grid.appendChild(btn);
    });
  } catch (error) {
    grid.innerHTML = `<div class="err">${error.message}</div>`;
  }
}

function selectPayType(id) {
  selectedPayTypeId = id;
  document.querySelectorAll('.pay-opt').forEach(btn => btn.classList.toggle('selected', Number(btn.dataset.payId) === Number(id)));
  document.getElementById('confirmDeliverBtn').disabled = false;
}

async function confirmDeliver(noPayment) {
  const errBox = document.getElementById('payErr');
  errBox.hidden = true;
  try {
    const body = noPayment ? { noPayment: true } : { paymentTypeId: selectedPayTypeId };
    await api(`/api/courier/orders/${deliverTicketId}/delivered`, { method: 'POST', body: JSON.stringify(body) });
    document.getElementById('paySheet').hidden = true;
    refresh();
  } catch (error) {
    errBox.textContent = error.message;
    errBox.hidden = false;
  }
}

document.getElementById('loginBtn').onclick = login;
document.getElementById('pinInput').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
document.getElementById('logoutBtn').onclick = logout;
document.getElementById('tabUnassigned').onclick = () => switchTab('unassigned');
document.getElementById('tabMine').onclick = () => switchTab('mine');
document.getElementById('tabDeliveries').onclick = () => switchTab('deliveries');
document.getElementById('closeContentSheet').onclick = () => { document.getElementById('contentSheet').hidden = true; };
document.getElementById('closePaySheet').onclick = () => { document.getElementById('paySheet').hidden = true; };
document.getElementById('noPaymentBtn').onclick = () => { if (confirm('Ödeme alınmadan teslim edilsin mi? Adisyon açık kalacak.')) confirmDeliver(true); };
document.getElementById('confirmDeliverBtn').onclick = () => confirmDeliver(false);

document.body.addEventListener('click', e => {
  const claimId = e.target.dataset && e.target.dataset.claim;
  const deliverId = e.target.dataset && e.target.dataset.deliver;
  const contentId = e.target.dataset && e.target.dataset.content;
  if (claimId) claimPackage(claimId);
  if (deliverId) openPaySheet(deliverId);
  if (contentId) openContent(contentId);
});

// Zaten oturum aciksa (cerez varsa) direkt ana ekrana gec.
api('/api/me').then(me => {
  if (me.role !== 'courier') return;
  document.getElementById('courierName').textContent = me.courierName || '';
  document.getElementById('loginView').hidden = true;
  document.getElementById('mainView').hidden = false;
  startPolling();
}).catch(() => {});
