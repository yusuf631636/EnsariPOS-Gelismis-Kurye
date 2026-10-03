/* Web Push (arka planda bildirim) - "kurye uygulamadan cikmadigi surece bildirim
   servisi calismali, uygulama kapatilsa bile bildirim alinabilsin" istegi icin
   (15.09.2026). VAPID anahtar ciftini ilk calistirmada KENDI uretir ve data/vapid.json'a
   yazar - restoran/musteri hicbir anahtar girmek ZORUNDA degil.

   ONEMLI - DURUSTCE SINIRLARI: bir servis worker'in KENDI ozel sesi (siren/alarm)
   CALAMAZ - tarayicilarin hicbiri push event'inde ozel ses dosyasi calmaya izin
   vermiyor (Notification API'nin eski "sound" secenegi yillar once kaldirildi).
   Push, uygulama TAMAMEN KAPALIYKEN sadece CIHAZIN kendi standart bildirim
   sesi/titresimiyle gelir (Android'de bu hala DUYULUR bir uyaridir). GERCEK ozel
   siren/tekrar-eden alarm SADECE uygulama acikken (on planda ya da arka planda ama
   hafizada canliyken) calinabilir - bu da app.js'teki Web Audio API alarmiyla
   yapiliyor. Iki mekanizma BIRLIKTE "arka planda surekli calissin" istegini en iyi
   sekilde karsiliyor: sekme aciksa ozel yuksek sesli alarm, sekme/uygulama tamamen
   kapaliysa cihazin kendi bildirim sesi. */
const fs = require('fs');
const path = require('path');
let webpush = null;
try { webpush = require('web-push'); } catch { /* paket yoksa push sessizce devre disi kalir */ }

const VAPID_FILE = path.join(__dirname, 'data', 'vapid.json');
const db = require('./db');

let vapidKeys = null;
function ensureVapidKeys() {
  if (vapidKeys) return vapidKeys;
  if (fs.existsSync(VAPID_FILE)) {
    try { vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')); return vapidKeys; } catch {}
  }
  if (!webpush) return null;
  vapidKeys = webpush.generateVAPIDKeys();
  fs.mkdirSync(path.dirname(VAPID_FILE), { recursive: true });
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2));
  return vapidKeys;
}

function ready() {
  if (!webpush) return false;
  const keys = ensureVapidKeys();
  if (!keys) return false;
  webpush.setVapidDetails('mailto:destek@ornek-alanadi.com', keys.publicKey, keys.privateKey);
  return true;
}

function publicKey() {
  const keys = ensureVapidKeys();
  return keys ? keys.publicKey : null;
}

async function sendToSubscription(endpoint, subscriptionJson, payload) {
  if (!ready()) return;
  try {
    await webpush.sendNotification(JSON.parse(subscriptionJson), JSON.stringify(payload));
  } catch (error) {
    // 410 Gone / 404 - abonelik artik gecersiz (tarayici verisi silinmis, izin geri alinmis vb.)
    if (error && (error.statusCode === 404 || error.statusCode === 410)) {
      db.removePushSubscription(endpoint);
    }
  }
}

async function notifyCourier(courierName, payload) {
  if (!ready()) return;
  const subs = db.pushSubscriptionsForCourier(courierName);
  await Promise.all(subs.map(s => sendToSubscription(s.endpoint, s.subscription, payload)));
}

async function notifyAllCouriers(payload) {
  if (!ready()) return;
  const subs = db.allCourierPushSubscriptions();
  // "Bekleyen sipariş bildirimi" kurye/yönetici tarafından kapatılmışsa (bkz. db.js
  // courier_settings) o kuryeye push GONDERILMEZ - "atandı" bildirimi (notifyCourier)
  // bundan ETKİLENMEZ, sadece "yeni bekleyen sipariş" toplu bildirimi bu anahtara bakar.
  const enabled = subs.filter(s => db.getCourierNotifyEnabled(s.courier_name));
  await Promise.all(enabled.map(s => sendToSubscription(s.endpoint, s.subscription, payload)));
}

module.exports = { publicKey, notifyCourier, notifyAllCouriers, isReady: ready };
