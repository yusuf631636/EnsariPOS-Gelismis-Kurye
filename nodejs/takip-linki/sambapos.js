/* GELISMIS KURYE SISTEMI - tum SQL islemleri.
   Bu dosya kendi-restoranim-kurye\sambapos.js'deki DOGRULANMIS desenleri (kurye listesi,
   PIN girisi, tarih/JSON parse yardimcilari) temel alir ama TAMAMEN AYRI, YENI bir dosyadir -
   mevcut canli sambapos.js'e HICBIR sekilde dokunulmaz/import edilmez.

   YENI OZELLIKLER (bu dosyaya ozel):
   - paymentTypes(): SambaPOS'ta GERCEKTEN tanimli odeme turlerini SQL'den dinamik okur
     (sabit "1=Nakit" varsayimi YOK - her restoranda PaymentTypes.Id degerleri farkli olabilir).
   - unassignedPackages(): kuryeye HENUZ atanmamis, acik, paket tipi adisyonlar.
   - claimPackage(): kurye "bu paketi ben aliyorum" dedigi an, SambaPOS'un kendi
     TicketEntities baglantisini + TicketStates("Paketçi Adı") alanini ATOMIK olarak
     yazar - sanki SambaPOS ekranindan kurye elle secilmis gibi.
   - markDelivered(): ARTIK kuryenin SECTIGI gercek SambaPOS odeme turuyle calisir,
     ve "odeme alinmadi" durumunda adisyonu KAPATMAZ (bkz. asagida).

   SEMA NOTLARI (kendi-restoranim-kurye ve kurye-bulut-ajan'da dogrulanmis, ayni SambaPOS5 semasi):
   - Kuryeler (bu ozel restoranda): Users tablosu, UserRole_Id=3 ("Paketciler"), PinCode ile giris.
   - Kurye<->adisyon eslesmesi: TicketEntities (EntityTypeId=3), + yedekleme olarak
     TicketStates JSON'da SN="Paketçi Adı". Ikisi de guncellenir (rapor motoru + bu uygulama
     ayni SN="Paket"/"Paketçi Adı" alanlarini okuyor, tutarli kalmali).
   - SQL Server JSON_VALUE/OPENJSON KULLANILMAZ (compat-level sorunlari daha once bu projede
     gercek veri kaybina yol acmisti) - TUM JSON parse islemi JS tarafinda yapilir. */
const { sql, rows } = require('./sql');

function sqlWide(query) { return sql(query, { wide: true }); }

/* ONEMLI: hicbir Rol/EntityType ID'si SABIT VARSAYILMAZ. Bu tam olarak bu oturumda
   iki kez canli olarak yasanan hataydi (restoran A'da "Paketciler" rolu Id=3, bu test
   kurulumunda Id=2 cikti) - kod hangi ID'nin ne oldugunu HER ZAMAN SQL'den ada gore
   bulur, sonucu ilk sorgudan sonra bellekte tutar (sik sorgulamamak icin). */
let cachedCourierRoleId = null;
async function courierRoleId() {
  if (cachedCourierRoleId) return cachedCourierRoleId;
  const found = rows(await sqlWide(`SET NOCOUNT ON; SELECT TOP 1 Id FROM UserRoles WHERE LOWER(Name) LIKE N'%paket%' OR LOWER(Name) LIKE N'%kurye%' ORDER BY Id;`), ['id'])[0];
  if (!found) throw new Error('SambaPOS\'ta kurye rolü bulunamadı ("Paketçiler" gibi bir Kullanıcı Rolü tanımlı olmalı).');
  cachedCourierRoleId = +found.id;
  return cachedCourierRoleId;
}
let cachedAdminRoleId = null;
async function adminRoleId() {
  if (cachedAdminRoleId) return cachedAdminRoleId;
  const found = rows(await sqlWide(`SET NOCOUNT ON; SELECT TOP 1 Id FROM UserRoles WHERE LOWER(Name) LIKE N'%admin%' ORDER BY Id;`), ['id'])[0];
  cachedAdminRoleId = found ? +found.id : 1; // bulunamazsa SambaPOS'un ilk kurulan kullanicisi (Id=1) her zaman admindir - guvenli yedek.
  return cachedAdminRoleId;
}
let cachedCourierEntityTypeId = null;
async function courierEntityTypeId() {
  if (cachedCourierEntityTypeId) return cachedCourierEntityTypeId;
  const found = rows(await sqlWide(`SET NOCOUNT ON; SELECT TOP 1 Id FROM EntityTypes WHERE LOWER(Name) LIKE N'%paket%' OR LOWER(Name) LIKE N'%kurye%' ORDER BY Id;`), ['id'])[0];
  if (!found) throw new Error('SambaPOS\'ta kurye varlık tipi bulunamadı ("Paketçiler" gibi bir Müşteri/Varlık Tipi tanımlı olmalı).');
  cachedCourierEntityTypeId = +found.id;
  return cachedCourierEntityTypeId;
}
/* TicketEntities.AccountId/AccountTypeId NOT NULL - EKSIK BIRAKILAMAZ (gercek hata:
   "Cannot insert the value NULL into column 'AccountId'..." canli testte yakalandi).
   AccountTypeId, EntityTypes.AccountTypeId'den gelir (varlik TIPININ ozelligi);
   AccountId ise o SPESIFIK varligin (Entities.AccountId) kendi degeridir - courierEntityByName
   ile birlikte okunur, bulunamazsa 0 (bu semada hesap takibi kullanilmayan varliklarin
   hepsinde gozlenen guvenli varsayilan). */
let cachedCourierAccountTypeId = null;
async function courierAccountTypeId() {
  if (cachedCourierAccountTypeId !== null) return cachedCourierAccountTypeId;
  const entityType = await courierEntityTypeId();
  const found = rows(await sqlWide(`SET NOCOUNT ON; SELECT AccountTypeId FROM EntityTypes WHERE Id=${entityType};`), ['accountTypeId'])[0];
  cachedCourierAccountTypeId = found ? +found.accountTypeId : 0;
  return cachedCourierAccountTypeId;
}
/* Kurye disindaki TUM varlik tiplerini (musteri, online siparis entegrasyonlari vb.)
   kapsar - hangi ID'lerin "musteri turu" oldugunu tek tek bilmemize gerek yok, sadece
   kurye tipi HARIC hepsi. */
let cachedCustomerEntityTypeIds = null;
async function customerEntityTypeIds() {
  if (cachedCustomerEntityTypeIds) return cachedCustomerEntityTypeIds;
  const courierType = await courierEntityTypeId();
  const found = rows(await sqlWide(`SET NOCOUNT ON; SELECT Id FROM EntityTypes WHERE Id <> ${courierType};`), ['id']);
  cachedCustomerEntityTypeIds = found.length ? found.map(r => r.id).join(',') : '-1';
  return cachedCustomerEntityTypeIds;
}

function parseCustomData(json) {
  try {
    const arr = JSON.parse(json || '[]');
    return Object.fromEntries(arr.filter(item => item && item.Name).map(item => [item.Name, item.Value]));
  } catch { return {}; }
}
function parseNetDate(value) {
  const match = String(value || '').match(/\/Date\((\d+)([+-]\d+)?\)\//);
  return match ? new Date(Number(match[1])) : null;
}
function parsePhoneFromName(name) {
  const match = String(name || '').match(/(\d{10,11})\s*$/);
  return match ? match[1] : '';
}
function netDateNow() { return `/Date(${Date.now()}+0300)/`; }
function upsertState(states, sn, value) {
  const idx = states.findIndex(item => item && item.SN === sn);
  if (idx === -1) { states.push({ D: netDateNow(), S: value, SN: sn, SV: '' }); }
  else { states[idx] = { ...states[idx], D: netDateNow(), S: value }; }
}
function sqlEsc(value) { return String(value).replace(/'/g, "''"); }

/* Siparişin kaynağı (Trendyol/Getir/Migros/Yemeksepeti mi, yoksa restoranın kendi
   telefon/masa siparişi mi) - kullanıcı isteği (15.09.2026): "bilelim". SambaPOS'ta
   BUNUN İÇİN tek/standart bir alan YOK - her restoran platform entegrasyonunu farklı
   şekilde kurar. BU restoranda GERÇEK bir ipucu bulundu: Users tablosunda "Getir",
   "Trendyol", "Yemeksepeti" adında ayrı hesaplar var (PIN'li, Admin rolünde) - bu,
   platform siparişlerini SambaPOS'a aktaran entegrasyon köprüsünün HER platform için
   ayrı bir kullanıcı olarak giriş yapıp adisyon açtığı, çok yaygın bir kurulum deseni.
   Bu yüzden Tickets.CreatedUserName/LastModifiedUserName EN GÜVENİLİR sinyal - ayrıca
   yedek olarak adisyon tipi adı/not/müşteri adında da aynı kelimeler aranır (entegrasyon
   farklı kurulmuş bir restoranda da çalışsın diye). Hiçbiri eşleşmezse "Restoran
   (Telefon/Masa)" döner - bu restoranın az önceki tek test adisyonunda olduğu gibi. */
const SOURCE_PATTERNS = [
  { key: 'yemeksepeti', label: 'Yemeksepeti' },
  { key: 'trendyol', label: 'Trendyol Go' },
  { key: 'getir', label: 'Getir' },
  { key: 'migros', label: 'Migros Yemek' }
];
function detectOrderSource(createdUserName, ...otherFields) {
  // En guvenilir alan (entegrasyon koprusunun kendi kullanicisi) ONCE tek basina
  // kontrol edilir - musteri adi gibi daha "gevsek" alanlarda rastlantisal bir alt
  // metin eslesmesiyle (ör. "Getirsin Ahmet") yanlis etiketlenmesin diye.
  const created = String(createdUserName || '').toLowerCase();
  const primary = SOURCE_PATTERNS.find(p => created.includes(p.key));
  if (primary) return primary.label;
  const haystack = otherFields.filter(Boolean).join(' ').toLowerCase();
  const found = SOURCE_PATTERNS.find(p => haystack.includes(p.key));
  return found ? found.label : 'Restoran (Telefon/Masa)';
}

async function couriers() {
  const roleId = await courierRoleId();
  const query = `SET NOCOUNT ON; SELECT Id, Name, PinCode FROM Users WHERE UserRole_Id=${roleId} ORDER BY Name;`;
  const users = rows(await sqlWide(query), ['id', 'name', 'pin']);
  return users.map(u => ({ id: +u.id, name: u.name, pin: u.pin }));
}

async function courierByPin(pin) {
  if (!/^\d+$/.test(String(pin || ''))) return null;
  const roleId = await courierRoleId();
  const query = `SET NOCOUNT ON; SELECT Id, Name FROM Users WHERE UserRole_Id=${roleId} AND PinCode=N'${sqlEsc(pin)}';`;
  const found = rows(await sqlWide(query), ['id', 'name'])[0];
  return found ? { id: +found.id, name: found.name } : null;
}

async function adminValidByPin(pin) {
  if (!/^\d+$/.test(String(pin || ''))) return false;
  const roleId = await adminRoleId();
  const query = `SET NOCOUNT ON; SELECT 1 FROM Users WHERE UserRole_Id=${roleId} AND PinCode=N'${sqlEsc(pin)}';`;
  return !!(await sqlWide(query)).trim();
}

/* Kuryenin SambaPOS Entities tablosundaki karsiligi (Name eslesmesiyle). TicketEntities'e
   "gercek" bir kayit yazabilmek icin (SambaPOS'un kendi Paketci Raporu'nun da guvenip
   kullandigi EntityId alani ile) bu lookup gerekli - sadece isim yazmak yetersiz. */
async function courierEntityByName(name) {
  const entityType = await courierEntityTypeId();
  const query = `SET NOCOUNT ON; SELECT TOP 1 Id, Name, COALESCE(AccountId,0) FROM Entities WHERE EntityTypeId=${entityType} AND Name=N'${sqlEsc(name)}';`;
  const found = rows(await sqlWide(query), ['id', 'name', 'accountId'])[0];
  return found ? { id: +found.id, name: found.name, accountId: +found.accountId } : null;
}

/* SambaPOS'ta GERCEKTEN tanimli odeme turleri - hicbir ID SABIT VARSAYILMAZ.
   (Onceki hatali varsayim: PaymentTypeId=1 her zaman "Nakit"dir - bu restorandan
   restorana degisebilir, bu yuzden burada SQL'den canli okunuyor.) */
async function paymentTypes() {
  const query = `SET NOCOUNT ON; SELECT Id, Name FROM PaymentTypes ORDER BY Id;`;
  return rows(await sqlWide(query), ['id', 'name']).map(r => ({ id: +r.id, name: r.name }));
}

/* Acik + bir kuryeye atanmis adisyonlar (kuryenin "uzerimdekiler" sekmesi icin). */
async function activeCourierOrders() {
  const courierType = await courierEntityTypeId();
  const customerTypes = await customerEntityTypeIds();
  const query = `SET NOCOUNT ON;
    SELECT t.Id, COALESCE(t.TicketNumber,''), CONVERT(varchar(19),t.Date,120), COALESCE(t.TotalAmount,0),
      COALESCE(t.RemainingAmount,0), COALESCE(t.TicketStates,'[]'), COALESCE(tt.Name,''), COALESCE(t.Note,''), COALESCE(t.CreatedUserName,''),
      COALESCE(cur.Name,''),
      COALESCE(cust.Name,''), COALESCE(cust.CustomData,'')
    FROM Tickets t
    LEFT JOIN TicketTypes tt ON tt.Id = t.TicketTypeId
    OUTER APPLY (SELECT TOP 1 EntityName AS Name FROM TicketEntities WHERE Ticket_Id=t.Id AND EntityTypeId=${courierType} ORDER BY Id DESC) cur
    OUTER APPLY (SELECT TOP 1 EntityName AS Name, EntityCustomData AS CustomData FROM TicketEntities WHERE Ticket_Id=t.Id AND EntityTypeId IN (${customerTypes}) ORDER BY Id DESC) cust
    WHERE t.IsClosed=0 AND cur.Name IS NOT NULL AND cur.Name <> ''
    ORDER BY t.Date DESC;`;
  const text = await sqlWide(query);
  return rows(text, ['id', 'number', 'date', 'total', 'remaining', 'states', 'ticketTypeName', 'note', 'createdUser', 'courierName', 'customerEntity', 'customerData'])
    .map(row => {
      const customer = parseCustomData(row.customerData);
      let states = [];
      try { states = JSON.parse(row.states); if (!Array.isArray(states)) states = []; } catch { states = []; }
      const packState = states.find(s => s && s.SN === 'Paket');
      const customerName = customer['Müşteri Adı'] || row.customerEntity || 'Bilinmeyen';
      return {
        id: +row.id,
        number: row.number,
        date: row.date,
        total: +row.total,
        remaining: +row.remaining,
        packageStatus: packState ? packState.S : '',
        courierName: row.courierName,
        customerName,
        address: customer['Adres'] || '',
        phone: parsePhoneFromName(row.customerEntity),
        source: detectOrderSource(row.createdUser, row.ticketTypeName, row.note, customerName)
      };
    });
}

/* Acik, paket tipi, HENUZ kuryeye atanmamis adisyonlar - "bekleyen paketler" sekmesi. */
async function unassignedPackages() {
  const courierType = await courierEntityTypeId();
  const customerTypes = await customerEntityTypeIds();
  const query = `SET NOCOUNT ON;
    SELECT t.Id, COALESCE(t.TicketNumber,''), CONVERT(varchar(19),t.Date,120), COALESCE(t.TotalAmount,0),
      COALESCE(tt.Name,''), COALESCE(t.Note,''), COALESCE(t.CreatedUserName,''),
      COALESCE(cust.Name,''), COALESCE(cust.CustomData,'')
    FROM Tickets t
    JOIN TicketTypes tt ON tt.Id = t.TicketTypeId
    OUTER APPLY (SELECT TOP 1 EntityName AS Name FROM TicketEntities WHERE Ticket_Id=t.Id AND EntityTypeId=${courierType} ORDER BY Id DESC) cur
    OUTER APPLY (SELECT TOP 1 EntityName AS Name, EntityCustomData AS CustomData FROM TicketEntities WHERE Ticket_Id=t.Id AND EntityTypeId IN (${customerTypes}) ORDER BY Id DESC) cust
    WHERE t.IsClosed=0 AND (cur.Name IS NULL OR cur.Name='')
      AND (LOWER(tt.Name) LIKE N'%paket%' OR LOWER(t.TicketStates) LIKE N'%paket%')
    ORDER BY t.Date DESC;`;
  const text = await sqlWide(query);
  return rows(text, ['id', 'number', 'date', 'total', 'ticketTypeName', 'note', 'createdUser', 'customerEntity', 'customerData']).map(row => {
    const customer = parseCustomData(row.customerData);
    const customerName = customer['Müşteri Adı'] || row.customerEntity || 'Bilinmeyen';
    return {
      id: +row.id,
      number: row.number,
      date: row.date,
      total: +row.total,
      customerName,
      address: customer['Adres'] || '',
      phone: parsePhoneFromName(row.customerEntity),
      source: detectOrderSource(row.createdUser, row.ticketTypeName, row.note, customerName)
    };
  });
}

/* Kurye "bu paket bende" dedigi an calisir. ATOMIK: Tickets satirini UPDLOCK+ROWLOCK ile
   kilitleyip HALA kuryesiz oldugunu dogruladiktan SONRA yazar - iki kurye ayni paketi ayni
   anda "al" derse SADECE biri basarili olur, digeri acik/net bir hata alir (yaris durumu yok). */
async function claimPackage(ticketId, courierName) {
  if (!/^\d+$/.test(String(ticketId))) throw new Error('Geçersiz sipariş numarası.');
  const id = Number(ticketId);
  const entityType = await courierEntityTypeId();
  const accountTypeId = await courierAccountTypeId();
  const entity = await courierEntityByName(courierName);

  const readQuery = `SET NOCOUNT ON;
    BEGIN TRANSACTION;
    DECLARE @already nvarchar(200);
    SELECT @already = cur.Name
      FROM Tickets t WITH (UPDLOCK, ROWLOCK)
      OUTER APPLY (SELECT TOP 1 EntityName AS Name FROM TicketEntities WHERE Ticket_Id=t.Id AND EntityTypeId=${entityType} ORDER BY Id DESC) cur
      WHERE t.Id=${id};
    IF @already IS NULL OR @already = ''
    BEGIN
      INSERT INTO TicketEntities (Ticket_Id, EntityId, EntityTypeId, EntityName, EntityCustomData, AccountId, AccountTypeId)
        VALUES (${id}, ${entity ? entity.id : 0}, ${entityType}, N'${sqlEsc(courierName)}', N'[]', ${entity ? entity.accountId : 0}, ${accountTypeId});
    END
    COMMIT TRANSACTION;
    SELECT COALESCE(@already,''), (SELECT TicketStates FROM Tickets WHERE Id=${id});`;
  const result = rows(await sqlWide(readQuery), ['already', 'states'])[0];
  if (!result) throw new Error('Sipariş bulunamadı.');
  if (result.already) throw new Error(result.already === courierName ? 'Bu paket zaten sizde.' : `Bu paket zaten ${result.already} tarafından alınmış.`);

  let states;
  try { states = JSON.parse(result.states || '[]'); if (!Array.isArray(states)) states = []; } catch { states = []; }
  upsertState(states, 'Paketçi Adı', courierName);
  upsertState(states, 'Paket', 'Yolda');
  const json = JSON.stringify(states).replace(/'/g, "''");
  await sqlWide(`SET NOCOUNT ON; UPDATE Tickets SET TicketStates=N'${json}' WHERE Id=${id};`);
  return { ok: true };
}

/* Musteri takip linkini SambaPOS'un KENDI adisyon kaydina (TicketStates) yazar -
   "Kurye Takip Linki" adiyla, mevcut 'Paket'/'Paketçi Adı' state'leriyle AYNI
   mekanizma. Boylece restoran, kendi mesaj/otomasyon sablonunda (qrentegra vb.)
   {TICKET STATE:Kurye Takip Linki} gibi bir alan varsa, o sablona EKLEYEREK
   linki otomatik siparis mesajina tasiyabilir - bu tamamen SambaPOS/ucuncu parti
   tarafin desteklemesine bagli, biz sadece degeri yaziyoruz (28.09.2026). */
async function writeTicketTrackingState(ticketId, url) {
  if (!/^\d+$/.test(String(ticketId))) throw new Error('Geçersiz sipariş numarası.');
  const id = Number(ticketId);
  const readRow = rows(await sqlWide(`SET NOCOUNT ON; SELECT TicketStates FROM Tickets WHERE Id=${id};`), ['states'])[0];
  if (!readRow) throw new Error('Sipariş bulunamadı.');
  let states;
  try { states = JSON.parse(readRow.states || '[]'); if (!Array.isArray(states)) states = []; } catch { states = []; }
  upsertState(states, 'Kurye Takip Linki', url);
  const json = JSON.stringify(states).replace(/'/g, "''");
  await sqlWide(`SET NOCOUNT ON; UPDATE Tickets SET TicketStates=N'${json}' WHERE Id=${id};`);
}

/* Musteri takip sayfasinin (server.js /takip/:token) HER ACILISTA taze SQL'e
   baktigi bilgi: adisyon gercekten kapandi mi (kapandiysa link bir daha HICBIR
   sey gostermez - kullanici karari, 28.09.2026) ve 'Paket' durumu ne (Hazirlaniyor/
   Yolda/Teslim Edildi). Kendi delivery_events log'umuza degil, DOGRUDAN SambaPOS'a
   bakar - boylece adisyon SambaPOS'un baska bir yerinden (elle) kapatilsa bile
   dogru sonuc verir. */
async function ticketTrackingInfo(ticketId) {
  if (!/^\d+$/.test(String(ticketId))) return null;
  const id = Number(ticketId);
  const courierType = await courierEntityTypeId();
  const query = `SET NOCOUNT ON;
    SELECT t.IsClosed, COALESCE(t.TicketStates,'[]'), COALESCE(cur.Name,'')
    FROM Tickets t
    OUTER APPLY (SELECT TOP 1 EntityName AS Name FROM TicketEntities WHERE Ticket_Id=t.Id AND EntityTypeId=${courierType} ORDER BY Id DESC) cur
    WHERE t.Id=${id};`;
  const row = rows(await sqlWide(query), ['isClosed', 'states', 'courierName'])[0];
  if (!row) return null;
  let states = [];
  try { states = JSON.parse(row.states); if (!Array.isArray(states)) states = []; } catch { states = []; }
  const packState = states.find(s => s && s.SN === 'Paket');
  return {
    isClosed: row.isClosed === '1',
    courierName: row.courierName || '',
    packageStatus: packState ? packState.S : ''
  };
}

async function orderContent(ticketId) {
  if (!/^\d+$/.test(String(ticketId))) throw new Error('Geçersiz sipariş numarası.');
  const query = `SET NOCOUNT ON; SELECT COALESCE(NULLIF(o.MenuItemName,''),'Bilinmeyen'),COALESCE(o.Quantity,0),COALESCE(o.Price,0) FROM Orders o WHERE o.TicketId=${Number(ticketId)} ORDER BY o.OrderNumber,o.Id;`;
  return rows(await sql(query), ['name', 'quantity', 'price']).map(row => ({ ...row, quantity: +row.quantity, price: +row.price }));
}

/* Odeme kaydi (Payments) icin Terminal/Kullanici - dosyanin basindaki KURAL'a
   (hicbir ID sabit varsayilmaz) aykiri sekilde bu ikisi ONCEDEN 1 olarak sabit
   kodlanmisti - kendi sanal kurulumumuzda calisiyordu (Terminals/Users Id=1
   gercekten var) ama GERCEK bir musteride (OZ URFA) ayni ID'ler baska/eksik
   bir seye karsilik gelebilir (13.09.2026, "odeme secince istek hatasi"
   sikayeti sonrasi fark edildi). DepartmentId ise artik adisyonun KENDI
   Departmanindan okunuyor (Tickets.DepartmentId) - o zaten dogru/var olan
   bir deger, tahmin etmeye hic gerek yok. */
let cachedTerminalId = null;
async function defaultTerminalId() {
  if (cachedTerminalId !== null) return cachedTerminalId;
  const found = rows(await sqlWide(`SET NOCOUNT ON; SELECT TOP 1 Id FROM Terminals ORDER BY Id;`), ['id'])[0];
  cachedTerminalId = found ? +found.id : 1;
  return cachedTerminalId;
}
let cachedAdminUserId = null;
async function defaultAdminUserId() {
  if (cachedAdminUserId !== null) return cachedAdminUserId;
  const roleId = await adminRoleId();
  const found = rows(await sqlWide(`SET NOCOUNT ON; SELECT TOP 1 Id FROM Users WHERE UserRole_Id=${roleId} ORDER BY Id;`), ['id'])[0];
  cachedAdminUserId = found ? +found.id : 1;
  return cachedAdminUserId;
}

/* Kurye "Teslim Edildi" dedigi anda calisir.
   - paymentTypeId: kuryenin ekranda SECTIGI, SambaPOS'ta GERCEKTEN tanimli odeme turu
     (bkz. paymentTypes() - artik sabit "1=Nakit" varsayimi YOK).
   - noPayment=true ise ("ödeme alınmadı"): odeme kaydi ACILMAZ, adisyon KAPATILMAZ,
     sadece paket durumu "Teslim Edildi (Ödeme Bekliyor)" olarak isaretlenir - restoran
     bunu acik adisyonlarinda gorup sonradan tahsil edebilir. TICKET ASLA odemesiz kapatilmaz.
   - ATOMIKLIK: okuma+yazma TEK bir SQL toplu isinde, acik TRANSACTION + UPDLOCK/ROWLOCK ile
     yapilir - cift tiklama/cift istek ile cift tahsilat OLUSAMAZ (ikinci istek adisyonun
     zaten kapali oldugunu gorup sessizce/guvenle durur). */
async function markDelivered(ticketId, paymentTypeId, noPayment, courierUserId, tenderedAmount) {
  if (!/^\d+$/.test(String(ticketId))) throw new Error('Geçersiz sipariş numarası.');
  const id = Number(ticketId);
  const skipPayment = !!noPayment;
  const payTypeId = skipPayment ? null : Number(paymentTypeId);
  if (!skipPayment && !(payTypeId > 0)) throw new Error('Geçerli bir ödeme türü seçilmedi.');
  /* "Para üstü": kurye nakitte musteriden tutardan FAZLA aldiysa (ör. adisyon 47 TL,
     musteri 50 TL verdi) fark musteriye geri verilir - SambaPOS'a HER ZAMAN adisyonun
     GERCEK kalan tutari (remaining) Payments olarak yazilir (fazlasi restoranin
     hesabina karismaz), fark sadece kendi raporumuzda "para üstü" olarak GORUNUR.
     tenderedAmount verilmezse (kart/online gibi tam tutar turlerinde anlamsiz) para
     ustu hesaplanmaz. */
  const tendered = tenderedAmount != null && Number.isFinite(Number(tenderedAmount)) ? Number(tenderedAmount) : null;

  const readRow = rows(await sqlWide(`SET NOCOUNT ON; SELECT TicketStates, DepartmentId FROM Tickets WHERE Id=${id};`), ['states', 'departmentId'])[0];
  if (!readRow) throw new Error('Sipariş bulunamadı.');
  let states;
  try { states = JSON.parse(readRow.states || '[]'); } catch { throw new Error('Sipariş durumu okunamadı.'); }
  if (!Array.isArray(states)) throw new Error('Sipariş durumu beklenmeyen formatta.');
  /* Payments.Name alanina ONCEDEN sabit "Kurye Tahsilati" yaziliyordu - SambaPOS'un
     kendi raporlari (P.Name) bu alani GERCEK odeme turu adi (Nakit/Kredi Karti/
     Getir Online vb.) olarak beklidigi icin, kuryenin GERCEKTEN sectigi tur ne
     olursa olsun raporda hep ayni tek satir/etiket olarak gorunuyordu - kuryenin
     "hangi odeme turunden ne kadar tahsil ettigini" hic gosteremiyordu (13.09.2026,
     canli tespit edildi, "Paketçi Ödeme Türü Raporu" test edilirken fark edildi).
     Artik gercek PaymentTypes.Name burada kullaniliyor - kurye uygulamasinin
     KENDISI (ekran/akis) hic degismedi, sadece SambaPOS'a yazilan etiket dogru.
     AYRICA ayni ad, TicketStates'e "Ödeme Türü" olarak da yaziliyor - SambaPOS'ta
     kurulacak Varlik Ekrani widget'lari {TICKET STATE:Ödeme Türü} ile bunu
     DOGRUDAN gosterebilsin diye (13.09.2026, "kurye nasil odeme almis, nakit
     gibi belirgin olsun" istegi icin eklendi). */
  const payTypeNameRaw = skipPayment ? '' : ((rows(await sqlWide(`SET NOCOUNT ON; SELECT Name FROM PaymentTypes WHERE Id=${payTypeId};`), ['name'])[0] || {}).name || 'Kurye Tahsilatı');
  /* payTypeName SADECE ham SQL INSERT icine gomulurken kacislanir (asagida) - states
     dizisine RAW halde yazilir, cunku states zaten TOPTAN (asagida bir kez) JSON'a
     cevrilip kacislanacak; iki kez kacislarsak (cift tirnak) yanlis olurdu. */
  const payTypeName = sqlEsc(payTypeNameRaw);
  upsertState(states, 'Paket', skipPayment ? 'Teslim Edildi (Ödeme Bekliyor)' : 'Teslim Edildi');
  if (!skipPayment) {
    upsertState(states, 'Durum', 'Ödendi');
    upsertState(states, 'Ödeme Türü', payTypeNameRaw);
  }
  const json = JSON.stringify(states).replace(/'/g, "''");
  const departmentId = +readRow.departmentId || 1;
  const userId = (Number(courierUserId) > 0) ? Number(courierUserId) : await defaultAdminUserId();
  const terminalId = await defaultTerminalId();

  const query = `SET NOCOUNT ON;
    BEGIN TRANSACTION;
    DECLARE @remaining money, @closed bit, @already bit = 0;
    SELECT @remaining = COALESCE(RemainingAmount,0), @closed = IsClosed FROM Tickets WITH (UPDLOCK, ROWLOCK) WHERE Id=${id};
    IF @closed = 1
    BEGIN
      SET @already = 1;
    END
    ELSE
    BEGIN
      ${skipPayment ? '' : `IF @remaining > 0
      BEGIN
        INSERT INTO Payments (TicketId, PaymentTypeId, DepartmentId, Name, Description, Date, AccountTransactionId, Amount, TenderedAmount, UserId, TerminalId, ExchangeRate, CanAdjustTip)
          VALUES (${id}, ${payTypeId}, ${departmentId}, N'${payTypeName}', N'Kurye teslimat tahsilatı', GETDATE(), 0, @remaining, @remaining, ${userId}, ${terminalId}, 1, 0);
      END`}
      UPDATE Tickets SET TicketStates=N'${json}', IsClosed=${skipPayment ? 0 : 1}, RemainingAmount=${skipPayment ? '@remaining' : '0'} WHERE Id=${id};
    END
    COMMIT TRANSACTION;
    SELECT @already, @remaining;`;
  const resultRow = rows(await sqlWide(query), ['already', 'remaining'])[0];
  if (!resultRow) throw new Error('Sunucudan yanıt alınamadı.');
  if (resultRow.already === '1') throw new Error('Bu sipariş zaten başka bir istekle teslim edilmiş/kapatılmış.');
  const remaining = +resultRow.remaining || 0;
  const changeAmount = (tendered != null && !skipPayment && tendered > remaining) ? +(tendered - remaining).toFixed(2) : 0;
  return {
    paymentInserted: !skipPayment && remaining > 0,
    amountCollected: skipPayment ? 0 : remaining,
    closed: !skipPayment,
    paymentTypeId: skipPayment ? null : payTypeId,
    paymentTypeName: skipPayment ? null : payTypeNameRaw,
    tenderedAmount: tendered,
    changeAmount
  };
}

/* GECICI TESHIS: hangi rol ID'sinin gercekten "Paketciler" oldugunu ve o rol altindaki
   kullanici/PIN eslesmelerini gosterir - COURIER_USER_ROLE sabitinin bu restoranda
   dogru olup olmadigini kontrol etmek icin. */
async function debugRolesAndUsers() {
  const query = `SET NOCOUNT ON;
    SELECT ur.Id, ur.Name, u.Id, u.Name, u.PinCode
    FROM Users u JOIN UserRoles ur ON ur.Id = u.UserRole_Id
    ORDER BY ur.Id, u.Name;`;
  return rows(await sqlWide(query), ['roleId', 'roleName', 'userId', 'userName', 'pin']);
}

module.exports = { couriers, courierByPin, adminValidByPin, paymentTypes, activeCourierOrders, unassignedPackages, claimPackage, orderContent, markDelivered, debugRolesAndUsers, writeTicketTrackingState, ticketTrackingInfo };
