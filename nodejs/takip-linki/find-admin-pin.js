/* Bu restoranin GERCEK SambaPOS admin PIN'ini bulur - "restoran/sahip" ekranina
   giris icin hangi PIN'i kullanmaniz gerektigini gosterir. Sadece OKUR, hicbir
   sey degistirmez. Kurulu uygulamanin KENDI config.json'unu (SQL baglantisini)
   kullanir - ek bir bilgi girmenize gerek yok. */
const { sql, rows } = require('./sql');

(async () => {
  const query = `SET NOCOUNT ON;
    SELECT u.Name, u.PinCode, ur.Name
    FROM Users u JOIN UserRoles ur ON ur.Id = u.UserRole_Id
    WHERE LOWER(ur.Name) LIKE N'%admin%' OR LOWER(ur.Name) LIKE N'%yonetici%' OR LOWER(ur.Name) LIKE N'%yönetici%'
    ORDER BY u.Name;`;
  const result = rows(await sql(query, { wide: true }), ['userName', 'pin', 'roleName']);
  if (!result.length) {
    console.log('Hiç "Admin/Yönetici" rolünde kullanıcı bulunamadı. SambaPOS\'ta rol adınız farklı olabilir.');
  } else {
    console.log('Restoran/sahip ekranına girerken kullanmanız gereken PIN(ler):');
    result.forEach(r => console.log(`  ${r.userName}  ->  PIN: ${r.pin}  (rol: ${r.roleName})`));
  }
})().catch(e => console.error('Hata:', e.message));
