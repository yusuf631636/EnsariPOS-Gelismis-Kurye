/* Restoran bilgisayarindaki Gelismis Kurye Sistemi'nin kendini otomatik
   guncellemesi - C:\toplu\kurye-bulut-ajan\updater.js ile AYNI, kanitlanmis
   desen (bagimsiz kopya, iki urun birbirine kod duzeyinde bagli degil).
   TASARIM ILKESI: canli servisi (HTTP sunucusu, tunel, SambaPOS senkronu)
   HICBIR sekilde etkileyemez. Bu yuzden:
   - Tamamen ayri, seyrek bir zamanlayici kullanir.
   - Her adim kendi try/catch'i icinde - herhangi bir hata sessizce loglanip
     bir sonraki denemeye birakilir, process asla bu yuzden çokmez.
   - Once GECICI bir klasore indirir, HER .js dosyasini "node --check" ile
     sozdizimi olarak dogrular, SADECE hepsi gecerliyse canli dosyalarin
     UZERINE yazar. Bozuk/yari-inmis bir guncelleme asla devreye girmez.
   - Eski dosyalarin bir yedegini tutar (update-backup/).
   - Basarili guncellemeden sonra surec process.exit(0) ile kapanir - NSSM
     servisi onu otomatik yeniden baslatir. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DIR = __dirname;
const CHECK_FIRST_DELAY_MS = 5 * 60 * 1000;   // ilk kontrol: acilistan 5 dk sonra
const CHECK_INTERVAL_MS = 60 * 60 * 1000;      // sonrasi: saatte bir

function log(...args) { console.log(new Date().toISOString(), '[guncelleme]', ...args); }

function localVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
}

function parseVersion(v) { return String(v || '0').split('.').map(n => Number(n) || 0); }
function isNewer(remote, local) {
  const r = parseVersion(remote), l = parseVersion(local);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rv = r[i] || 0, lv = l[i] || 0;
    if (rv !== lv) return rv > lv;
  }
  return false;
}

function fetchJson(url) {
  return fetch(url, { signal: AbortSignal.timeout(15000) }).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}
function fetchText(url) {
  return fetch(url, { signal: AbortSignal.timeout(15000) }).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  });
}

function checkSyntax(filePath) {
  return new Promise(resolve => {
    execFile(process.execPath, ['--check', filePath], { windowsHide: true }, error => resolve(!error));
  });
}

async function runCheck(cloudServerUrl) {
  const base = `${String(cloudServerUrl || 'https://app.ornek-alanadi.com').replace(/\/$/, '')}/gk-agent-update`;
  let manifest;
  try { manifest = await fetchJson(`${base}/version.json`); }
  catch (error) { log('surum bilgisi alinamadi (bulut ulasilamiyor olabilir), atlaniyor:', error.message); return; }

  const remoteVersion = String(manifest.version || '');
  const files = Array.isArray(manifest.files) ? manifest.files.filter(f => /^[a-zA-Z0-9_.-]+$/.test(f)) : [];
  const local = localVersion();
  if (!remoteVersion || !files.length) { log('surum manifestosu bos/gecersiz, atlaniyor.'); return; }
  if (!isNewer(remoteVersion, local)) { log(`guncel (yerel ${local}, bulut ${remoteVersion}).`); return; }

  log(`yeni surum bulundu: ${local} -> ${remoteVersion}. Indiriliyor...`);
  const stagingDir = path.join(os.tmpdir(), `gks-update-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    for (const file of files) {
      const text = await fetchText(`${base}/${encodeURIComponent(file)}`);
      fs.writeFileSync(path.join(stagingDir, file), text, 'utf8');
    }
    for (const file of files) {
      if (!file.endsWith('.js')) continue;
      const ok = await checkSyntax(path.join(stagingDir, file));
      if (!ok) throw new Error(`${file} sozdizimi hatali - guncelleme iptal edildi, mevcut surum korunuyor.`);
    }
    JSON.parse(fs.readFileSync(path.join(stagingDir, 'version.json'), 'utf8'));

    const backupDir = path.join(DIR, 'update-backup');
    fs.mkdirSync(backupDir, { recursive: true });
    for (const file of files) {
      const live = path.join(DIR, file);
      if (fs.existsSync(live)) fs.copyFileSync(live, path.join(backupDir, file));
    }

    for (const file of files) fs.copyFileSync(path.join(stagingDir, file), path.join(DIR, file));

    log(`guncelleme basarili: ${local} -> ${remoteVersion}. Servis yeniden baslatiliyor...`);
    fs.rmSync(stagingDir, { recursive: true, force: true });
    setTimeout(() => process.exit(0), 250);
  } catch (error) {
    log('guncelleme basarisiz, MEVCUT SURUM DEGISTIRILMEDI:', error.message);
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* onemli degil */ }
  }
}

function start(config) {
  const cloudServerUrl = config && config.cloudServerUrl;
  setTimeout(() => {
    runCheck(cloudServerUrl).catch(error => log('beklenmeyen hata (yoksayildi):', error.message));
    setInterval(() => {
      runCheck(cloudServerUrl).catch(error => log('beklenmeyen hata (yoksayildi):', error.message));
    }, CHECK_INTERVAL_MS);
  }, CHECK_FIRST_DELAY_MS);
}

module.exports = { start };
