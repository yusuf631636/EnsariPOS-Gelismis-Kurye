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
  CREATE TABLE IF NOT EXISTS order_tracking (
    token      TEXT PRIMARY KEY,
    ticket_id  INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_order_tracking_ticket ON order_tracking(ticket_id);
`);
db.exec(`DELETE FROM sessions WHERE expires < ${Date.now()}`);

function logEvent(ticketId, courierName, event, detail, amount) {
  db.prepare('INSERT INTO delivery_events (ticket_id, courier_name, event, detail, amount) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId ?? null, courierName ?? null, event, detail ?? null, amount ?? null);
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

/* Kuryenin kendi ekraninda "bugun ne teslim ettim" listesi - aksam ozeti icin. */
function courierDeliveries(courierName, startIso, endIso) {
  return db.prepare(`
    SELECT ticket_id, amount, at
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

/* Musteriye elle gonderilecek "takip linki" - ayni siparis icin ikinci kez
   istenirse AYNI token dondurulur (her tiklamada yeni link uretilip
   eskisini gecersiz kilmasin diye). Token tahmin edilemez olsun diye
   crypto.randomBytes kullanilir - baska bir yetkilendirme YOKTUR, linki
   bilen gorur (posta kutusu/QR kod bileti mantigi, SambaPOS sifresi gibi
   hassas bir sey tasimaz). */
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
  logEvent, recentEvents, deliverySummary, courierDeliveries,
  setCourierLocation, allCourierLocations,
  saveSession, touchSession, loadSession, deleteSession,
  getOrCreateTrackingToken, ticketIdForToken
};
