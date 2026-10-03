using System;
using System.Collections.Generic;
using System.IO;
using Alfa;

namespace GKurye
{
    // db.js karsiligi (Gelismis Kurye) - AYNI SQLite dosyasi (data/gelismis-kurye.db) ve ayni 3 tablo.
    public static class Store
    {
        static Sqlite db;

        public static void Open(string root)
        {
            db = new Sqlite(Path.Combine(root, "data", "gelismis-kurye.db"), root);
            db.Exec("PRAGMA journal_mode = WAL;");
            db.Exec("PRAGMA busy_timeout = 5000;");
            db.Exec(@"
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
  );");
            db.Exec("DELETE FROM sessions WHERE expires < " + J.NowMs());
        }

        public static void LogEvent(object ticketId, object courierName, string ev, object detail, object amount)
        {
            db.Run("INSERT INTO delivery_events (ticket_id, courier_name, event, detail, amount) VALUES (?, ?, ?, ?, ?)", ticketId, courierName, ev, detail, amount);
        }
        public static List<Dictionary<string, object>> RecentEvents(int limit) { return db.All("SELECT id, ticket_id, courier_name, event, detail, amount, at FROM delivery_events ORDER BY id DESC LIMIT ?", limit > 0 ? limit : 100); }
        public static List<Dictionary<string, object>> DeliverySummary(string s, string e)
        {
            return db.All(@"
    SELECT courier_name, COUNT(*) AS count, COALESCE(SUM(amount),0) AS total
    FROM delivery_events
    WHERE event='teslim-edildi' AND at >= ? AND at < ?
    GROUP BY courier_name ORDER BY total DESC", s, e);
        }
        public static List<Dictionary<string, object>> CourierDeliveries(string name, string s, string e)
        {
            return db.All(@"
    SELECT ticket_id, amount, at
    FROM delivery_events
    WHERE courier_name = ? AND event = 'teslim-edildi' AND at >= ? AND at < ?
    ORDER BY id DESC", name, s, e);
        }
        public static void SetCourierLocation(string name, double lat, double lng, object accuracy)
        {
            db.Run(@"INSERT INTO courier_locations (courier_name, lat, lng, accuracy, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(courier_name) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, accuracy=excluded.accuracy, updated_at=datetime('now')", name, lat, lng, accuracy);
        }
        public static List<Dictionary<string, object>> AllCourierLocations() { return db.All("SELECT courier_name, lat, lng, accuracy, updated_at FROM courier_locations"); }
        public static void SaveSession(string token, string role, object courierId, object courierName, long expires)
        {
            db.Run("INSERT INTO sessions (token, role, courier_id, courier_name, expires) VALUES (?, ?, ?, ?, ?)", token, role, courierId, courierName, expires);
        }
        public static void TouchSession(string token, long expires) { db.Run("UPDATE sessions SET expires = ? WHERE token = ?", expires, token); }
        public static Dictionary<string, object> LoadSession(string token) { return db.Get("SELECT role, courier_id AS courierId, courier_name AS courierName, expires FROM sessions WHERE token = ?", token); }
        public static void DeleteSession(string token) { db.Run("DELETE FROM sessions WHERE token = ?", token); }
    }
}
