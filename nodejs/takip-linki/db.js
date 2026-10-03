/* kendi-restoranim-kurye\db.js ile AYNI, dogrulanmis SQLite deseni - kendi bagimsiz
   veritabani dosyasi (data/gelismis-kurye.db), mevcut hicbir dosyaya dokunmaz. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'gelismis-kurye.db'));
/* Ayni SQLite eszamanlilik sertlestirmesi C:\toplu\db.js'de canli bir "database
   is locked" hatasini cozdu - burada risk cok daha az (tek restoran/tek surec)
   ama ayni ucretsiz onlemi almak hicbir seyi bozmaz. */
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec(`
  CREATE TABLE IF NOT EXISTS delivery_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id     INTEGER,
    courier_name  TEXT,
    event         TEXT NOT NULL,
    detail        TEXT,
    amount        REAL,
    at            TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS courier_locations (
    courier_name TEXT PRIMARY KEY,
    lat          REAL NOT NULL,
    lng          REAL NOT NULL,
    accuracy     REAL,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token         TEXT PRIMARY KEY,
    role          TEXT NOT NULL,
    courier_id    TEXT,
    courier_name  TEXT,
    expires       INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS courier_settings (
    courier_name    TEXT PRIMARY KEY,
    notify_enabled  INTEGER NOT NULL DEFAULT 1,
    updated_by      TEXT,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint      TEXT PRIMARY KEY,
    courier_name  TEXT,
    role          TEXT NOT NULL DEFAULT 'courier',
    subscription  TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS order_tracking (
    token      TEXT PRIMARY KEY,
    ticket_id  INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_order_tracking_ticket ON order_tracking(ticket_id);
`);
db.exec(`DELETE FROM sessions WHERE expires < ${Date.now()}`);

/* delivery_events'e sonradan eklenen kolonlar (odeme turu detayi + siparis anlik
   goruntusu - "odeme raporunu duzelt, nasil almis tutari raporlarda gorunsun"
   istegi icin, 15.09.2026). Eski satirlarda bu kolonlar NULL kalir, rapor bunu
   "bilinmiyor/eski kayit" olarak isler - veri kaybi yok, sadece yeni alan. */
const existingCols = new Set(db.prepare('PRAGMA table_info(delivery_events)').all().map(c => c.name));
const addCol = (name, type) => { if (!existingCols.has(name)) db.exec(`ALTER TABLE delivery_events ADD COLUMN ${name} ${type}`); };
addCol('payment_type_id', 'INTEGER');
addCol('payment_type_name', 'TEXT');
addCol('ticket_number', 'TEXT');
addCol('customer_name', 'TEXT');
addCol('order_total', 'REAL');
addCol('tendered_amount', 'REAL');
addCol('change_amount', 'REAL');
addCol('order_source', 'TEXT');

function logEvent(ticketId, courierName, event, detail, amount, extra) {
  const e = extra || {};
  db.prepare(`INSERT INTO delivery_events
    (ticket_id, courier_name, event, detail, amount, payment_type_id, payment_type_name, ticket_number, customer_name, order_total, tendered_amount, change_amount, order_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ticketId ?? null, courierName ?? null, event, detail ?? null, amount ?? null,
      e.paymentTypeId ?? null, e.paymentTypeName ?? null, e.ticketNumber ?? null, e.customerName ?? null,
      e.orderTotal ?? null, e.tenderedAmount ?? null, e.changeAmount ?? null, e.orderSource ?? null);
}
function recentEvents(limit) {
  return db.prepare('SELECT id, ticket_id, courier_name, event, detail, amount, at FROM delivery_events ORDER BY id DESC LIMIT ?').all(limit || 100);
}
/* Belirli bir tarih araligindaki teslimatlarin kurye bazinda ozeti - "Paketçi Raporu". */
function deliverySummary(startIso, endIso) {
  return db.prepare(`
    SELECT courier_name, COUNT(*) AS count, COALESCE(SUM(amount),0) AS total
    FROM delivery_events
    WHERE event='teslim-edildi' AND at >= ? AND at < ?
    GROUP BY courier_name ORDER BY total DESC
  `).all(startIso, endIso);
}

/* "kuryenin parayi nasil aldigi" kirilimi - odeme turune gore (Nakit/Kredi Karti/vb,
   isimler SambaPOS'un KENDI PaymentTypes tablosundan geliyor, sabit varsayilmiyor).
   Odeme alinmadan teslim edilenler (noPayment) burada YOK - onlarda tahsil edilen
   0'dir, kirilimde gosterilecek bir tutar yok (ayri olarak "odeme bekleyen" sayisi
   raporda zaten var - /api/admin/report'taki 'pending'). */
function paymentBreakdown(startIso, endIso) {
  return db.prepare(`
    SELECT COALESCE(payment_type_name,'Bilinmiyor (eski kayıt)') AS payment_type_name,
      COUNT(*) AS count, COALESCE(SUM(amount),0) AS total
    FROM delivery_events
    WHERE event='teslim-edildi' AND amount > 0 AND at >= ? AND at < ?
    GROUP BY COALESCE(payment_type_name,'Bilinmiyor (eski kayıt)') ORDER BY total DESC
  `).all(startIso, endIso);
}

/* Tek tek siparis satirlari - admin "Ödeme Raporu" detay tablosu icin. */
function deliveryDetails(startIso, endIso) {
  return db.prepare(`
    SELECT ticket_id, ticket_number, courier_name, customer_name, order_total,
      payment_type_name, amount, tendered_amount, change_amount, order_source, at
    FROM delivery_events
    WHERE event IN ('teslim-edildi','teslim-odeme-bekliyor') AND at >= ? AND at < ?
    ORDER BY at DESC
  `).all(startIso, endIso);
}

/* Kuryenin kendi ekraninda "bugun ne teslim ettim" listesi - aksam ozeti icin. */
function courierDeliveries(courierName, startIso, endIso) {
  return db.prepare(`
    SELECT ticket_id, amount, payment_type_name, at
    FROM delivery_events
    WHERE courier_name = ? AND event = 'teslim-edildi' AND at >= ? AND at < ?
    ORDER BY id DESC
  `).all(courierName, startIso, endIso);
}

function setCourierLocation(courierName, lat, lng, accuracy) {
  db.prepare(`INSERT INTO courier_locations (courier_name, lat, lng, accuracy, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(courier_name) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, accuracy=excluded.accuracy, updated_at=datetime('now')`)
    .run(courierName, lat, lng, accuracy ?? null);
}
function allCourierLocations() {
  return db.prepare('SELECT courier_name, lat, lng, accuracy, updated_at FROM courier_locations').all();
}

/* Push aboneligi (Web Push) - "arka planda calissin" istegi icin: uygulama kapaliyken
   de bildirim gelebilsin diye tarayicinin verdigi endpoint+anahtarlar burada saklanir.
   endpoint zaten tarayici basina benzersiz - PRIMARY KEY olarak kullanilir, ayni
   cihaz/tarayici tekrar abone olursa (yeniden giris vb.) UZERINE YAZILIR. */
function savePushSubscription(endpoint, courierName, role, subscriptionJson) {
  db.prepare(`INSERT INTO push_subscriptions (endpoint, courier_name, role, subscription, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(endpoint) DO UPDATE SET courier_name=excluded.courier_name, role=excluded.role, subscription=excluded.subscription`)
    .run(endpoint, courierName ?? null, role || 'courier', subscriptionJson);
}
function removePushSubscription(endpoint) { db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint); }
function pushSubscriptionsForCourier(courierName) {
  return db.prepare(`SELECT endpoint, subscription FROM push_subscriptions WHERE role='courier' AND courier_name = ?`).all(courierName);
}
function allCourierPushSubscriptions() {
  return db.prepare(`SELECT endpoint, courier_name, subscription FROM push_subscriptions WHERE role='courier'`).all();
}

/* Bekleyen sipariş bildirimi ac/kapa - SUNUCU TARAFINDA (client localStorage DEGIL) -
   kullanici istegi (15.09.2026): "bildirimi kurye kapatsa bile biz acabilecek
   olmaliyiz" - yani yonetici, kuryenin kendi telefonunda kapattigi bir bildirimi
   UZAKTAN tekrar acabilmeli. Kurye kendi ekranindan da degistirebilir (ayni tabloya
   yazar) ama YETKILI KAYNAK burasi - kurye ac/kapa yapsa da yonetici HER ZAMAN
   gorup degistirebilir, kuryenin telefonundaki yerel ayar (localStorage) sadece
   ses/titresim/tekrar gibi CIHAZA OZGU ayrintilar icin kalir. */
function getCourierNotifyEnabled(courierName) {
  const row = db.prepare('SELECT notify_enabled FROM courier_settings WHERE courier_name = ?').get(courierName);
  return row ? !!row.notify_enabled : true; // hic ayar yoksa varsayilan: acik
}
function setCourierNotifyEnabled(courierName, enabled, updatedBy) {
  db.prepare(`INSERT INTO courier_settings (courier_name, notify_enabled, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(courier_name) DO UPDATE SET notify_enabled=excluded.notify_enabled, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
    .run(courierName, enabled ? 1 : 0, updatedBy || null);
}
function allCourierNotifySettings() {
  return db.prepare('SELECT courier_name, notify_enabled, updated_at FROM courier_settings').all();
}

/* Musteriye elle gonderilecek "takip linki" - ayni siparis icin ikinci kez
   istenirse AYNI token dondurulur. Token tahmin edilemez olsun diye
   crypto.randomBytes kullanilir - baska bir yetkilendirme YOKTUR, linki
   bilen gorur (posta kutusu/QR kod bileti mantigi). */
function getOrCreateTrackingToken(ticketId) {
  const existing = db.prepare('SELECT token FROM order_tracking WHERE ticket_id = ? ORDER BY created_at DESC LIMIT 1').get(ticketId);
  if (existing) return existing.token;
  const token = crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO order_tracking (token, ticket_id) VALUES (?, ?)').run(token, ticketId);
  return token;
}
function ticketIdForToken(token) {
  const row = db.prepare('SELECT ticket_id FROM order_tracking WHERE token = ?').get(token);
  return row ? row.ticket_id : null;
}

function saveSession(token, data) {
  db.prepare('INSERT INTO sessions (token, role, courier_id, courier_name, expires) VALUES (?, ?, ?, ?, ?)')
    .run(token, data.role, data.courierId ?? null, data.courierName ?? null, data.expires);
}
function touchSession(token, expires) { db.prepare('UPDATE sessions SET expires = ? WHERE token = ?').run(expires, token); }
function loadSession(token) {
  const row = db.prepare('SELECT role, courier_id AS courierId, courier_name AS courierName, expires FROM sessions WHERE token = ?').get(token);
  return row || null;
}
function deleteSession(token) { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); }

module.exports = {
  logEvent, recentEvents, deliverySummary, paymentBreakdown, deliveryDetails, courierDeliveries,
  setCourierLocation, allCourierLocations,
  getCourierNotifyEnabled, setCourierNotifyEnabled, allCourierNotifySettings,
  savePushSubscription, removePushSubscription, pushSubscriptionsForCourier, allCourierPushSubscriptions,
  saveSession, touchSession, loadSession, deleteSession,
  getOrCreateTrackingToken, ticketIdForToken
};
