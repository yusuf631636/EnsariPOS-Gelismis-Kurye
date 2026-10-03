const { sql, rows } = require('./sql');
const sambapos = require('./sambapos');
(async () => {
  console.log('--- adminValidByPin(1111) sonucu ---');
  console.log(await sambapos.adminValidByPin('1111'));

  console.log('--- ham SQL, tam esitlik ---');
  console.log(await sql("SET NOCOUNT ON; SELECT Id, Name, PinCode, LEN(PinCode) AS PinLen, DATALENGTH(PinCode) AS PinBytes FROM Users WHERE UserRole_Id=1 AND PinCode=N'1111';", { wide: true }));

  console.log('--- Administrator satiri tek basina ---');
  console.log(await sql("SET NOCOUNT ON; SELECT Id, Name, PinCode, LEN(PinCode) AS PinLen, DATALENGTH(PinCode) AS PinBytes, UserRole_Id FROM Users WHERE Name=N'Administrator';", { wide: true }));
})().catch(e => console.error('HATA:', e.message));
