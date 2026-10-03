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
let SQL_SERVER = process.env.SAMBAPOS_SQL_SERVER || config.server || 'localhost';
const SQL_DATABASE = process.env.SAMBAPOS_DB || config.database || 'SAMBAPOS5';
const SQL_USER = process.env.SAMBAPOS_SQL_USER || config.user || '';
const SQL_PASSWORD = process.env.SAMBAPOS_SQL_PASSWORD || config.password || '';

/* Bu VPS'te SQL Server LocalDB (kalici bir Windows servisi DEGIL, kullanici
   oturumuna bagli, bos kalinca kendiliginden duruyor) kullaniliyor - her
   durup yeniden baslamasinda "\\.\pipe\LOCALDB#<YENI-GUID>\..." seklinde
   YENI bir named pipe adi uretiyor. config.json'daki adres bu yuzden zamanla
   BAYATLIYOR ("Borunun diger ucunda islem yok" hatasi - canli tespit,
   14.09.2026). Asagidaki fonksiyon, SADECE pipe hatasi alindiginda
   SqlLocalDB.exe'den GUNCEL adresi sorup SQL_SERVER'i kendiliginden
   tazeler ve sorguyu bir kez tekrar dener - boylece servis/bilgisayar
   arada kapanip acilsa bile elle mudahaleye gerek kalmaz. */
const LOCALDB_INSTANCE = 'MSSQLLocalDB';
const SQLLOCALDB_EXE_CANDIDATES = [
  'C:\\Program Files\\Microsoft SQL Server\\160\\Tools\\Binn\\SqlLocalDB.exe',
  'C:\\Program Files\\Microsoft SQL Server\\150\\Tools\\Binn\\SqlLocalDB.exe',
  'C:\\Program Files\\Microsoft SQL Server\\140\\Tools\\Binn\\SqlLocalDB.exe',
  'C:\\Program Files\\Microsoft SQL Server\\130\\Tools\\Binn\\SqlLocalDB.exe',
  'C:\\Program Files\\Microsoft SQL Server\\120\\Tools\\Binn\\SqlLocalDB.exe'
];
function isLocalDbPipe(server) { return /LOCALDB#/i.test(String(server || '')); }
function resolveLocalDbPipe() {
  return new Promise((resolve, reject) => {
    const exe = SQLLOCALDB_EXE_CANDIDATES.find(p => fs.existsSync(p));
    if (!exe) return reject(new Error('SqlLocalDB.exe bulunamadı.'));
    execFile(exe, ['start', LOCALDB_INSTANCE], { windowsHide: true }, () => {
      execFile(exe, ['info', LOCALDB_INSTANCE], { windowsHide: true }, (e, out) => {
        if (e) return reject(e);
        const match = String(out || '').match(/Instance pipe name:\s*(\S+)/i);
        if (!match) return reject(new Error('LocalDB pipe adı okunamadı.'));
        resolve(match[1].trim());
      });
    });
  });
}

/* "spawn sqlcmd ENOENT": bazi makinelerde sqlcmd PATH'te olsa da Windows SERVISLERI
   (bu SCM'nin kendi baslama anindan miras aldigi ortamdan dolayi) PATH'e sonradan
   eklenen bir seyi goremeyebilir. config.json'da elle "sqlcmdPath" verilmisse o
   kullanilir; yoksa once duz "sqlcmd" (PATH) denenir, ENOENT alinirsa bilinen kurulum
   konumlari sirayla denenir. */
const KNOWN_SQLCMD_PATHS = [
  'C:\\Program Files\\Sqlcmd\\sqlcmd.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\WinGet\\Links\\sqlcmd.exe'),
  'C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\170\\Tools\\Binn\\SQLCMD.EXE',
  'C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\180\\Tools\\Binn\\SQLCMD.EXE',
  'C:\\Program Files (x86)\\Microsoft SQL Server\\Client SDK\\ODBC\\170\\Tools\\Binn\\SQLCMD.EXE',
];
let resolvedSqlcmd = config.sqlcmdPath || null;

const BOM = '\ufeff';
function stripBom(text) { return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; }

function runSqlcmd(exe, args, cb) {
  execFile(exe, args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, cb);
}

function sql(query, { wide = false, _retried = false } = {}) {
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
    const finish = async (e, err) => {
      const stderr = String(err || '');
      let stdout = '';
      try { stdout = stripBom(fs.readFileSync(outFile, 'utf16le')); } catch { /* olusmadiysa bos kalir */ }
      cleanup();
      const looksLikeError = /^Msg \d+, Level \d+, State \d+/m.test(stdout);
      /* Baglanti seviyesindeki HERHANGI bir hata (dosya bulunamadi, boru
         koptu, baglanti reddedildi, vb.) LocalDB'de HEP ayni kokten gelir -
         pipe adresi bayatlamis demektir. Windows hata metnini dilüsere/
         surume gore eslestirmeye calismak KIRILGAN olurdu (bir kez zaten
         yanlis cikti - "Msg N, Level..." ile baslayan GERCEK bir SQL hatasi
         DEGILSE, yani sunucuya hic baglanilamadiysa) tazele+tekrar dene. */
      if (e && !looksLikeError && !_retried && isLocalDbPipe(SQL_SERVER)) {
        try {
          SQL_SERVER = await resolveLocalDbPipe();
          return resolve(sql(query, { wide, _retried: true }));
        } catch { /* pipe tazelenemedi, asagida normal hata donulur */ }
      }
      if (e) return reject(new Error(stderr.trim() || stdout.trim() || e.message));
      if (looksLikeError) return reject(new Error(stdout.trim()));
      resolve(stdout.trim());
    };

    runSqlcmd(resolvedSqlcmd || 'sqlcmd', args, (e, out, err) => {
      if (e && e.code === 'ENOENT' && !resolvedSqlcmd) {
        const candidate = KNOWN_SQLCMD_PATHS.find(p => p && fs.existsSync(p));
        if (candidate) {
          resolvedSqlcmd = candidate;
          return runSqlcmd(candidate, args, (e2, out2, err2) => finish(e2, err2));
        }
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
