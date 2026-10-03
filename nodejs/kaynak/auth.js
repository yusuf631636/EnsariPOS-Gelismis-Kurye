/* kendi-restoranim-kurye\auth.js ile ayni, dogrulanmis oturum/kilitleme deseni - ayri kopya. */
const crypto = require('crypto');
const sambapos = require('./sambapos');
const { saveSession, touchSession, loadSession, deleteSession } = require('./db');

/* Uygulama artik APK olarak kuruluyor - "arka planda sessizce calissin, cikis
   yapilmadigi surece sifre sorulmasin" istendi (13.09.2026). Zaten SQLite'a
   yaziliyor (persist), sadece sure uzatildi. */
const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 gun
const LOCK_THRESHOLD = 5, LOCK_MS = 5 * 60 * 1000;
const COOKIE_NAMES = { admin: 'gks_admin_session', courier: 'gks_courier_session' };

const attempts = new Map();

function parseCookies(req) {
  const header = req.headers.cookie, out = {};
  if (!header) return out;
  header.split(';').forEach(part => { const i = part.indexOf('='); if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); });
  return out;
}
function isHttps(req) { return req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted; }
function setSessionCookie(req, res, token, role) {
  const parts = [`${COOKIE_NAMES[role]}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(req, res) {
  const isHttp = isHttps(req);
  const cookies = Object.values(COOKIE_NAMES).map(name => {
    const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (isHttp) parts.push('Secure');
    return parts.join('; ');
  });
  res.setHeader('Set-Cookie', cookies);
}
function newSession(data) {
  const token = crypto.randomBytes(24).toString('hex');
  saveSession(token, { ...data, expires: Date.now() + SESSION_TTL_MS });
  return token;
}
/* onceki surumde admin VE kurye cerezleri AYNI ANDA gecerliyse (ayni cihaz/
   tarayicida hem Restoran hem Kurye uygulamasina giris yapilmissa - APK'lar
   ayni Chrome depolamasini paylastigi icin bu artik SIK karsilasilan bir
   durum) admin HER ZAMAN kazanip kurye'nin "paketi uzerine al" gibi kendi
   islemlerini "yetkiniz yok" diye reddediyordu (13.09.2026, canli tespit -
   "bazen yetkiniz yok diyor paketi uzerine alinca"). role parametresi
   verilirse SADECE o rolun cerezine bakilir, digeri hic goz onune alinmaz -
   iki oturum birbirinden tamamen BAGIMSIZ calisir. role verilmezse eski
   davranis (once admin, sonra kurye) korunur - sadece bilgi amacli /api/me
   gibi yerlerde kullanilir. */
function currentSession(req, role) {
  const cookies = parseCookies(req);
  const roles = role ? [role] : ['admin', 'courier'];
  for (const r of roles) {
    const token = cookies[COOKIE_NAMES[r]];
    if (!token) continue;
    const record = loadSession(token);
    if (!record) continue;
    if (record.expires < Date.now()) { deleteSession(token); continue; }
    const expires = Date.now() + SESSION_TTL_MS;
    touchSession(token, expires);
    return { ...record, expires };
  }
  return null;
}
function destroySession(req) {
  const cookies = parseCookies(req);
  for (const role of ['admin', 'courier']) {
    const token = cookies[COOKIE_NAMES[role]];
    if (token) deleteSession(token);
  }
}
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function lockedForMs(ip) { const state = attempts.get(ip); return state && state.lockUntil > Date.now() ? state.lockUntil - Date.now() : 0; }
function registerFail(ip) {
  const state = attempts.get(ip) || { count: 0, lockUntil: 0 };
  state.count += 1;
  if (state.count >= LOCK_THRESHOLD) { state.lockUntil = Date.now() + LOCK_MS; state.count = 0; }
  attempts.set(ip, state);
}
function registerSuccess(ip) { attempts.delete(ip); }
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1e6) req.destroy(new Error('İstek çok büyük.')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}
async function courierLogin(pin) { return sambapos.courierByPin(pin); }
async function adminLogin(pin) { return sambapos.adminValidByPin(pin); }

module.exports = {
  setSessionCookie, clearSessionCookie, newSession, currentSession, destroySession,
  clientIp, lockedForMs, registerFail, registerSuccess, readJsonBody,
  courierLogin, adminLogin
};
