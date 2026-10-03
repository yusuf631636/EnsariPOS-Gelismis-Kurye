const { sql, rows } = require('./sql');
(async () => {
  const roles = rows(await sql('SET NOCOUNT ON; SELECT Id, Name FROM UserRoles ORDER BY Id;', { wide: true }), ['id', 'name']);
  console.log('--- ROLLER ---');
  roles.forEach(r => console.log('Id=' + r.id, 'Name=' + r.name));

  const users = rows(await sql('SET NOCOUNT ON; SELECT Name, PinCode, UserRole_Id FROM Users ORDER BY Name;', { wide: true }), ['name', 'pin', 'roleId']);
  console.log('--- KULLANICILAR ---');
  users.forEach(u => console.log('Name=' + u.name, 'PIN=' + u.pin, 'UserRole_Id=' + u.roleId));
})().catch(e => console.error('HATA:', e.message));
