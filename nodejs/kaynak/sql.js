/* kendi-restoranim-kurye\sql.js'deki desenin gelistirilmis hali.
   ONEMLI BULGU (bu oturumda canli testte yakalandi): modern "go-sqlcmd" (winget
   Microsoft.Sqlcmd - sqlcmd bulunamayan makinelerde otomatik yedek olarak kullanilan
   arac, bkz. asagida) stdout'a PIPE edilince Turkce karakterleri ("ç" gibi) SESSIZCE
   "?" ile degistiriyor - codepage secmekle duzelmeyen, KAYIP bir hata (veri kaynakta
   zaten "?" olarak geliyor). Eski ODBC tabanli sqlcmd'de bu sorun yoktu (cp857 ile
   dogru okunuyordu) ama artik HER IKI aracin da guvenle calismasi icin TAMAMEN farkli
   bir yontem kullaniyoruz: sqlcmd'ye "-u -o <dosya>" ile ciktiyi STDOUT'A DEGIL bir
   DOSYAYA, gercek UTF-16LE (Unicode) olarak yazdiriyoruz, sonra o dosyayi okuyoruz.
   Girdi (sorgu) dosyasi da ayni sebeple UTF-16LE + BOM ile yaziliyor. Boylece hicbir
   codepage tahmini/varsayimi kalmiyor - dogrulandi (ç/ş/ğ/ı/İ/Ö/Ü hepsi dogru donuyor). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const config = fs.existsSync(path.join(__dirname, 'config.json')) ? JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) : {};
const SQL_SERVER = process.env.SAMBAPOS_SQL_SERVER || config.server || 'localhost';
const SQL_DATABASE = process.env.SAMBAPOS_DB || config.database || 'SAMBAPOS5';
const SQL_USER = process.env.SAMBAPOS_SQL_USER || config.user || '';
const SQL_PASSWORD = process.env.SAMBAPOS_SQL_PASSWORD || config.password || '';

/* "spawn sqlcmd ENOENT": bazi makinelerde sqlcmd PATH'te olsa da Windows SERVISLERI
   (bu SCM'nin kendi baslama anindan miras aldigi ortamdan dolayi) PATH'e sonradan
   eklenen bir seyi goremeyebilir. config.json'da elle "sqlcmdPath" verilmisse o
   kullanilir; yoksa once duz "sqlcmd" (PATH) denenir, calismazsa bilinen kurulum
   konumlari sirayla denenir.

   15.09.2026 CANLI BULGU: modern "go-sqlcmd" (yukaridaki "sqlcmd" PATH araci),
   restoranin ESKI bir SQL Server surumune (2012/2014 gibi, SambaPOS kurulumlarinda
   COK YAYGIN) baglanmaya calisirken "TLS Handshake failed: tls: server selected
   unsupported protocol version" hatasi verip TAMAMEN REDDEDIYOR - eski surumler
   sadece TLS 1.0/SSL destekliyor, modern Go TLS kutuphanesi bunu guvenlik geregi
   kabul etmiyor. Bu SADECE ENOENT (dosya bulunamadi) DEGIL, calisan ama basarisiz
   olan bir arac - bu yuzden asagidaki fallback artik ENOENT'e ozel degil, HERHANGI
   bir hataya (baglanti/TLS dahil) tetikleniyor. SQL Server'in KENDI eski surumune ait
   Native Client sqlcmd'si (ODBC tabanli, eski TLS'i native destekler) bu sorunu
   yasamiyor - versiyon numarasi bilinmediginden (musteride hangi SQL Server surumu
   kurulu oldugunu ONCEDEN bilemeyiz) TUM yaygin surumler (2012=110, 2014=120,
   2016=130, 2017=140, 2019=150) sirayla denenir. */
const KNOWN_SQLCMD_PATHS = [
  'C:\\Program Files\\Sqlcmd\\sqlcmd.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\WinGet\\Links\\sqlcmd.exe'),
  'C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\170\\Tools\\Binn\\SQLCMD.EXE',
  'C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\180\\Tools\\Binn\\SQLCMD.EXE',
  'C:\\Program Files (x86)\\Microsoft SQL Server\\Client SDK\\ODBC\\170\\Tools\\Binn\\SQLCMD.EXE',
  'C:\\Program Files\\Microsoft SQL Server\\150\\Tools\\Binn\\SQLCMD.EXE',
  'C:\\Program Files\\Microsoft SQL Server\\140\\Tools\\Binn\\SQLCMD.EXE',
  'C:\\Program Files\\Microsoft SQL Server\\130\\Tools\\Binn\\SQLCMD.EXE',
  'C:\\Program Files\\Microsoft SQL Server\\120\\Tools\\Binn\\SQLCMD.EXE',
  'C:\\Program Files\\Microsoft SQL Server\\110\\Tools\\Binn\\SQLCMD.EXE',
  'C:\\Program Files (x86)\\Microsoft SQL Server\\110\\Tools\\Binn\\SQLCMD.EXE',
];
let resolvedSqlcmd = config.sqlcmdPath || null;
let triedFallback = false;

const BOM = '\ufeff';
function stripBom(text) { return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; }

function runSqlcmd(exe, args, cb) {
  execFile(exe, args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, cb);
}

function sql(query, { wide = false } = {}) {
  return new Promise((resolve, reject) => {
    const auth = SQL_USER && SQL_PASSWORD ? ['-U', SQL_USER, '-P', SQL_PASSWORD] : ['-E'];
    const trust = config.options && config.options.trustServerCertificate ? ['-C'] : [];
    const widthFlag = wide ? ['-y', '8000'] : ['-W'];
    const tag = crypto.randomBytes(8).toString('hex');
    const inFile = path.join(os.tmpdir(), `gks-in-${tag}.sql`);
    const outFile = path.join(os.tmpdir(), `gks-out-${tag}.txt`);
    fs.writeFileSync(inFile, BOM + query, 'utf16le');
    const args = ['-S', SQL_SERVER, ...auth, ...trust, '-d', SQL_DATABASE, '-h', '-1', ...widthFlag, '-s', '|', '-u', '-o', outFile, '-i', inFile];

    const cleanup = () => { fs.unlink(inFile, () => {}); fs.unlink(outFile, () => {}); };
    const finish = (e, err) => {
      const stderr = String(err || '');
      let stdout = '';
      try { stdout = stripBom(fs.readFileSync(outFile, 'utf16le')); } catch { /* olusmadiysa bos kalir */ }
      cleanup();
      const looksLikeError = /^Msg \d+, Level \d+, State \d+/m.test(stdout);
      if (e) return reject(new Error(stderr.trim() || stdout.trim() || e.message));
      if (looksLikeError) return reject(new Error(stdout.trim()));
      resolve(stdout.trim());
    };

    /* Adaylari SIRAYLA dener (ilk BULUNAN degil, ilk CALISAN) - bircok SQL
       Server surumunun Native Client'i ayni anda kurulu olabilir, hangisinin
       bu restoranin sunucusuyla GERCEKTEN konusabildigini sadece deneyerek
       anlariz. Basarili olan surecin GERI KALANI icin (config.json'a hic
       elle sqlcmdPath yazmadan) onbelleklenir. */
    const tryCandidates = (candidates, idx, lastErr) => {
      if (idx >= candidates.length) return finish(lastErr || new Error('sqlcmd bulunamadı.'), null);
      const exe = candidates[idx];
      runSqlcmd(exe, args, (e, out, err) => {
        if (e) return tryCandidates(candidates, idx + 1, e);
        resolvedSqlcmd = exe;
        finish(e, err);
      });
    };

    runSqlcmd(resolvedSqlcmd || 'sqlcmd', args, (e, out, err) => {
      if (e && !resolvedSqlcmd) {
        const candidates = KNOWN_SQLCMD_PATHS.filter(p => p && fs.existsSync(p));
        if (candidates.length) return tryCandidates(candidates, 0, e);
      }
      finish(e, err);
    });
  });
}
function rows(text, keys) {
  return text ? text.split(/\r?\n/).filter(Boolean).map(line => {
    const v = line.split('|').map(x => x.trim());
    return Object.fromEntries(keys.map((k, i) => [k, v[i] || '']));
  }) : [];
}

module.exports = { sql, rows, config };
