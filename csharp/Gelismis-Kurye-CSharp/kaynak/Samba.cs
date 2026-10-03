using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Alfa;

namespace GKurye
{
    // sambapos.js karsiligi - SQL'ler birebir ayni. Hicbir Rol/EntityType ID'si sabit varsayilmaz.
    public static class Samba
    {
        static long? _courierRoleId, _adminRoleId, _courierEntityTypeId, _courierAccountTypeId, _terminalId, _adminUserId;
        static string _customerTypes;
        static List<object[]> Q(string sql) { return Db.Query(sql); }

        static long CourierRoleId()
        {
            if (_courierRoleId.HasValue) return _courierRoleId.Value;
            var r = Q("SET NOCOUNT ON; SELECT TOP 1 Id FROM UserRoles WHERE LOWER(Name) LIKE N'%paket%' OR LOWER(Name) LIKE N'%kurye%' ORDER BY Id;");
            if (r.Count == 0) throw new Exception("SambaPOS'ta kurye rolü bulunamadı (\"Paketçiler\" gibi bir Kullanıcı Rolü tanımlı olmalı).");
            return (_courierRoleId = Db.I(r[0][0])).Value;
        }
        static long AdminRoleId()
        {
            if (_adminRoleId.HasValue) return _adminRoleId.Value;
            var r = Q("SET NOCOUNT ON; SELECT TOP 1 Id FROM UserRoles WHERE LOWER(Name) LIKE N'%admin%' ORDER BY Id;");
            return (_adminRoleId = r.Count > 0 ? Db.I(r[0][0]) : 1).Value;
        }
        static long CourierEntityTypeId()
        {
            if (_courierEntityTypeId.HasValue) return _courierEntityTypeId.Value;
            var r = Q("SET NOCOUNT ON; SELECT TOP 1 Id FROM EntityTypes WHERE LOWER(Name) LIKE N'%paket%' OR LOWER(Name) LIKE N'%kurye%' ORDER BY Id;");
            if (r.Count == 0) throw new Exception("SambaPOS'ta kurye varlık tipi bulunamadı (\"Paketçiler\" gibi bir Müşteri/Varlık Tipi tanımlı olmalı).");
            return (_courierEntityTypeId = Db.I(r[0][0])).Value;
        }
        static long CourierAccountTypeId()
        {
            if (_courierAccountTypeId.HasValue) return _courierAccountTypeId.Value;
            long et = CourierEntityTypeId();
            var r = Q("SET NOCOUNT ON; SELECT AccountTypeId FROM EntityTypes WHERE Id=" + et + ";");
            return (_courierAccountTypeId = r.Count > 0 ? Db.I(r[0][0]) : 0).Value;
        }
        static string CustomerEntityTypeIds()
        {
            if (_customerTypes != null) return _customerTypes;
            long ct = CourierEntityTypeId();
            var r = Q("SET NOCOUNT ON; SELECT Id FROM EntityTypes WHERE Id <> " + ct + ";");
            return _customerTypes = r.Count > 0 ? string.Join(",", r.Select(x => Db.S(x[0]))) : "-1";
        }

        static Dictionary<string, string> ParseCustomData(string json)
        {
            var d = new Dictionary<string, string>();
            try
            {
                foreach (var it in J.LL(J.Parse(string.IsNullOrEmpty(json) ? "[]" : json)).Select(J.D))
                    if (it != null && J.Truthy(J.Get(it, "Name"))) d[J.S(it, "Name")] = J.Get(it, "Value") == null ? null : J.S(it, "Value");
            }
            catch { }
            return d;
        }
        static string Cd(Dictionary<string, string> d, string k) { string v; return d.TryGetValue(k, out v) && !string.IsNullOrEmpty(v) ? v : null; }
        static string PhoneFromName(string name) { var m = Regex.Match(name ?? "", @"(\d{10,11})\s*$"); return m.Success ? m.Groups[1].Value : ""; }
        static string NetDateNow() { return "/Date(" + J.NowMs() + "+0300)/"; }
        static void UpsertState(List<object> states, string sn, string value)
        {
            int idx = states.FindIndex(x => { var d = J.D(x); return d != null && J.S(d, "SN") == sn; });
            if (idx == -1) states.Add(J.Obj("D", NetDateNow(), "S", value, "SN", sn, "SV", ""));
            else { var cur = new Dictionary<string, object>(J.D(states[idx])); cur["D"] = NetDateNow(); cur["S"] = value; states[idx] = cur; }
        }
        static readonly string[][] SourcePatterns = { new[] { "yemeksepeti", "Yemeksepeti" }, new[] { "trendyol", "Trendyol Go" }, new[] { "getir", "Getir" }, new[] { "migros", "Migros Yemek" } };
        // JS toLowerCase (dil bagimsiz) karsiligi
        static string Lo(string s) { return (s ?? "").ToLowerInvariant(); }
        static string DetectSource(string createdUser, params string[] other)
        {
            string created = Lo(createdUser);
            var p = SourcePatterns.FirstOrDefault(x => created.Contains(x[0]));
            if (p != null) return p[1];
            string hay = Lo(string.Join(" ", other.Where(s => !string.IsNullOrEmpty(s))));
            var f = SourcePatterns.FirstOrDefault(x => hay.Contains(x[0]));
            return f != null ? f[1] : "Restoran (Telefon/Masa)";
        }

        public static List<object> Couriers()
        {
            long role = CourierRoleId();
            return Q("SET NOCOUNT ON; SELECT Id, Name, PinCode FROM Users WHERE UserRole_Id=" + role + " ORDER BY Name;")
                .Select(u => (object)J.Obj("id", Db.I(u[0]), "name", Db.S(u[1]), "pin", Db.S(u[2]))).ToList();
        }
        public static Dictionary<string, object> CourierByPin(string pin)
        {
            if (!Regex.IsMatch(pin ?? "", @"^\d+$")) return null;
            long role = CourierRoleId();
            var r = Q("SET NOCOUNT ON; SELECT Id, Name FROM Users WHERE UserRole_Id=" + role + " AND PinCode=N'" + Db.Esc(pin) + "';");
            return r.Count > 0 ? J.Obj("id", Db.I(r[0][0]), "name", Db.S(r[0][1])) : null;
        }
        public static bool AdminValidByPin(string pin)
        {
            if (!Regex.IsMatch(pin ?? "", @"^\d+$")) return false;
            long role = AdminRoleId();
            return Q("SET NOCOUNT ON; SELECT 1 FROM Users WHERE UserRole_Id=" + role + " AND PinCode=N'" + Db.Esc(pin) + "';").Count > 0;
        }
        static long[] CourierEntityByName(string name)
        {
            long et = CourierEntityTypeId();
            var r = Q("SET NOCOUNT ON; SELECT TOP 1 Id, Name, COALESCE(AccountId,0) FROM Entities WHERE EntityTypeId=" + et + " AND Name=N'" + Db.Esc(name) + "';");
            return r.Count > 0 ? new[] { Db.I(r[0][0]), Db.I(r[0][2]) } : null;
        }
        public static List<object> PaymentTypes()
        {
            return Q("SET NOCOUNT ON; SELECT Id, Name FROM PaymentTypes ORDER BY Id;").Select(r => (object)J.Obj("id", Db.I(r[0]), "name", Db.S(r[1]))).ToList();
        }

        public static List<Dictionary<string, object>> ActiveCourierOrders()
        {
            long ct = CourierEntityTypeId(); string cust = CustomerEntityTypeIds();
            var rows = Q(@"SET NOCOUNT ON;
    SELECT t.Id, COALESCE(t.TicketNumber,''), CONVERT(varchar(19),t.Date,120), COALESCE(t.TotalAmount,0),
      COALESCE(t.RemainingAmount,0), COALESCE(t.TicketStates,'[]'),
      COALESCE(cur.Name,''),
      COALESCE(cust.Name,''), COALESCE(cust.CustomData,'')
    FROM Tickets t
    OUTER APPLY (SELECT TOP 1 EntityName AS Name FROM TicketEntities WHERE Ticket_Id=t.Id AND EntityTypeId=" + ct + @" ORDER BY Id DESC) cur
    OUTER APPLY (SELECT TOP 1 EntityName AS Name, EntityCustomData AS CustomData FROM TicketEntities WHERE Ticket_Id=t.Id AND EntityTypeId IN (" + cust + @") ORDER BY Id DESC) cust
    WHERE t.IsClosed=0 AND cur.Name IS NOT NULL AND cur.Name <> ''
    ORDER BY t.Date DESC;");
            return rows.Select(r =>
            {
                var customer = ParseCustomData(Db.S(r[8]));
                List<object> states;
                try { states = J.L(J.Parse(Db.S(r[5]))) ?? new List<object>(); } catch { states = new List<object>(); }
                var pack = states.Select(J.D).FirstOrDefault(s => s != null && J.S(s, "SN") == "Paket");
                return J.Obj("id", Db.I(r[0]), "number", Db.S(r[1]), "date", Db.S(r[2]), "total", J.NumVal(Db.N(r[3])), "remaining", J.NumVal(Db.N(r[4])),
                    "packageStatus", pack != null ? J.S(pack, "S") : "", "courierName", Db.S(r[6]),
                    "customerName", Cd(customer, "Müşteri Adı") ?? (Db.S(r[7]).Length > 0 ? Db.S(r[7]) : "Bilinmeyen"),
                    "address", Cd(customer, "Adres") ?? "", "phone", PhoneFromName(Db.S(r[7])));
            }).ToList();
        }

        public static List<Dictionary<string, object>> UnassignedPackages()
        {
            long ct = CourierEntityTypeId(); string cust = CustomerEntityTypeIds();
            var rows = Q(@"SET NOCOUNT ON;
    SELECT t.Id, COALESCE(t.TicketNumber,''), CONVERT(varchar(19),t.Date,120), COALESCE(t.TotalAmount,0),
      COALESCE(cust.Name,''), COALESCE(cust.CustomData,'')
    FROM Tickets t
    JOIN TicketTypes tt ON tt.Id = t.TicketTypeId
    OUTER APPLY (SELECT TOP 1 EntityName AS Name FROM TicketEntities WHERE Ticket_Id=t.Id AND EntityTypeId=" + ct + @" ORDER BY Id DESC) cur
    OUTER APPLY (SELECT TOP 1 EntityName AS Name, EntityCustomData AS CustomData FROM TicketEntities WHERE Ticket_Id=t.Id AND EntityTypeId IN (" + cust + @") ORDER BY Id DESC) cust
    WHERE t.IsClosed=0 AND (cur.Name IS NULL OR cur.Name='')
      AND (LOWER(tt.Name) LIKE N'%paket%' OR LOWER(t.TicketStates) LIKE N'%paket%')
    ORDER BY t.Date DESC;");
            return rows.Select(r =>
            {
                var customer = ParseCustomData(Db.S(r[5]));
                return J.Obj("id", Db.I(r[0]), "number", Db.S(r[1]), "date", Db.S(r[2]), "total", J.NumVal(Db.N(r[3])),
                    "customerName", Cd(customer, "Müşteri Adı") ?? (Db.S(r[4]).Length > 0 ? Db.S(r[4]) : "Bilinmeyen"),
                    "address", Cd(customer, "Adres") ?? "", "phone", PhoneFromName(Db.S(r[4])));
            }).ToList();
        }

        public static void ClaimPackage(string ticketId, string courierName)
        {
            if (!Regex.IsMatch(ticketId ?? "", @"^\d+$")) throw new Exception("Geçersiz sipariş numarası.");
            long id = long.Parse(ticketId);
            long et = CourierEntityTypeId(), acc = CourierAccountTypeId();
            var ent = CourierEntityByName(courierName);
            var r = Q(@"SET NOCOUNT ON;
    BEGIN TRANSACTION;
    DECLARE @already nvarchar(200);
    SELECT @already = cur.Name
      FROM Tickets t WITH (UPDLOCK, ROWLOCK)
      OUTER APPLY (SELECT TOP 1 EntityName AS Name FROM TicketEntities WHERE Ticket_Id=t.Id AND EntityTypeId=" + et + @" ORDER BY Id DESC) cur
      WHERE t.Id=" + id + @";
    IF @already IS NULL OR @already = ''
    BEGIN
      INSERT INTO TicketEntities (Ticket_Id, EntityId, EntityTypeId, EntityName, EntityCustomData, AccountId, AccountTypeId)
        VALUES (" + id + ", " + (ent != null ? ent[0] : 0) + ", " + et + ", N'" + Db.Esc(courierName) + "', N'[]', " + (ent != null ? ent[1] : 0) + ", " + acc + @");
    END
    COMMIT TRANSACTION;
    SELECT COALESCE(@already,''), (SELECT TicketStates FROM Tickets WHERE Id=" + id + ");");
            if (r.Count == 0) throw new Exception("Sipariş bulunamadı.");
            string already = Db.S(r[0][0]);
            if (already.Length > 0) throw new Exception(already == courierName ? "Bu paket zaten sizde." : "Bu paket zaten " + already + " tarafından alınmış.");
            List<object> states;
            try { states = J.L(J.Parse(string.IsNullOrEmpty(Db.S(r[0][1])) ? "[]" : Db.S(r[0][1]))) ?? new List<object>(); } catch { states = new List<object>(); }
            UpsertState(states, "Paketçi Adı", courierName);
            UpsertState(states, "Paket", "Yolda");
            Q("SET NOCOUNT ON; UPDATE Tickets SET TicketStates=N'" + J.Str(states).Replace("'", "''") + "' WHERE Id=" + id + ";");
        }

        public static List<object> OrderContent(string ticketId)
        {
            if (!Regex.IsMatch(ticketId ?? "", @"^\d+$")) throw new Exception("Geçersiz sipariş numarası.");
            return Q("SET NOCOUNT ON; SELECT COALESCE(NULLIF(o.MenuItemName,''),'Bilinmeyen'),COALESCE(o.Quantity,0),COALESCE(o.Price,0) FROM Orders o WHERE o.TicketId=" + long.Parse(ticketId) + " ORDER BY o.OrderNumber,o.Id;")
                .Select(r => (object)J.Obj("name", Db.S(r[0]), "quantity", J.NumVal(Db.N(r[1])), "price", J.NumVal(Db.N(r[2])))).ToList();
        }

        static long DefaultTerminalId()
        {
            if (_terminalId.HasValue) return _terminalId.Value;
            var r = Q("SET NOCOUNT ON; SELECT TOP 1 Id FROM Terminals ORDER BY Id;");
            return (_terminalId = r.Count > 0 ? Db.I(r[0][0]) : 1).Value;
        }
        static long DefaultAdminUserId()
        {
            if (_adminUserId.HasValue) return _adminUserId.Value;
            long role = AdminRoleId();
            var r = Q("SET NOCOUNT ON; SELECT TOP 1 Id FROM Users WHERE UserRole_Id=" + role + " ORDER BY Id;");
            return (_adminUserId = r.Count > 0 ? Db.I(r[0][0]) : 1).Value;
        }

        public static Dictionary<string, object> MarkDelivered(string ticketId, object paymentTypeId, bool noPayment, object courierUserId, object tenderedAmount)
        {
            if (!Regex.IsMatch(ticketId ?? "", @"^\d+$")) throw new Exception("Geçersiz sipariş numarası.");
            long id = long.Parse(ticketId);
            bool skip = noPayment;
            double payTypeD = skip ? double.NaN : J.Num(paymentTypeId);
            if (!skip && !(payTypeD > 0)) throw new Exception("Geçerli bir ödeme türü seçilmedi.");
            long payTypeId = skip ? 0 : (long)payTypeD;
            double? tendered = null;
            if (tenderedAmount != null && J.Finite(J.Num(tenderedAmount))) tendered = J.Num(tenderedAmount);

            var rr = Q("SET NOCOUNT ON; SELECT TicketStates, DepartmentId FROM Tickets WHERE Id=" + id + ";");
            if (rr.Count == 0) throw new Exception("Sipariş bulunamadı.");
            List<object> states;
            object parsed;
            try { parsed = J.Parse(string.IsNullOrEmpty(Db.S(rr[0][0])) ? "[]" : Db.S(rr[0][0])); } catch { throw new Exception("Sipariş durumu okunamadı."); }
            states = J.L(parsed);
            if (states == null) throw new Exception("Sipariş durumu beklenmeyen formatta.");
            string payTypeNameRaw = "";
            if (!skip)
            {
                var pn = Q("SET NOCOUNT ON; SELECT Name FROM PaymentTypes WHERE Id=" + payTypeId + ";");
                payTypeNameRaw = pn.Count > 0 && Db.S(pn[0][0]).Length > 0 ? Db.S(pn[0][0]) : "Kurye Tahsilatı";
            }
            string payTypeName = Db.Esc(payTypeNameRaw);
            UpsertState(states, "Paket", skip ? "Teslim Edildi (Ödeme Bekliyor)" : "Teslim Edildi");
            if (!skip) { UpsertState(states, "Durum", "Ödendi"); UpsertState(states, "Ödeme Türü", payTypeNameRaw); }
            string json = J.Str(states).Replace("'", "''");
            long dep = Db.I(rr[0][1]); if (dep == 0) dep = 1;
            double cu = J.Num(courierUserId);
            long userId = cu > 0 ? (long)cu : DefaultAdminUserId();
            long terminalId = DefaultTerminalId();
            string payIns = skip ? "" : @"IF @remaining > 0
      BEGIN
        INSERT INTO Payments (TicketId, PaymentTypeId, DepartmentId, Name, Description, Date, AccountTransactionId, Amount, TenderedAmount, UserId, TerminalId, ExchangeRate, CanAdjustTip)
          VALUES (" + id + ", " + payTypeId + ", " + dep + ", N'" + payTypeName + "', N'Kurye teslimat tahsilatı', GETDATE(), 0, @remaining, @remaining, " + userId + ", " + terminalId + @", 1, 0);
      END";
            var res = Q(@"SET NOCOUNT ON;
    BEGIN TRANSACTION;
    DECLARE @remaining money, @closed bit, @already bit = 0;
    SELECT @remaining = COALESCE(RemainingAmount,0), @closed = IsClosed FROM Tickets WITH (UPDLOCK, ROWLOCK) WHERE Id=" + id + @";
    IF @closed = 1
    BEGIN
      SET @already = 1;
    END
    ELSE
    BEGIN
      " + payIns + @"
      UPDATE Tickets SET TicketStates=N'" + json + "', IsClosed=" + (skip ? "0" : "1") + ", RemainingAmount=" + (skip ? "@remaining" : "0") + " WHERE Id=" + id + @";
    END
    COMMIT TRANSACTION;
    SELECT @already, @remaining;");
            if (res.Count == 0) throw new Exception("Sunucudan yanıt alınamadı.");
            if (Db.S(res[0][0]) == "1") throw new Exception("Bu sipariş zaten başka bir istekle teslim edilmiş/kapatılmış.");
            double remaining = Db.N(res[0][1]);
            return J.Obj("paymentInserted", !skip && remaining > 0, "amountCollected", J.NumVal(skip ? 0 : remaining), "closed", !skip);
        }

        public static List<object> DebugRolesAndUsers()
        {
            return Q(@"SET NOCOUNT ON;
    SELECT ur.Id, ur.Name, u.Id, u.Name, u.PinCode
    FROM Users u JOIN UserRoles ur ON ur.Id = u.UserRole_Id
    ORDER BY ur.Id, u.Name;").Select(r => (object)J.Obj("roleId", Db.S(r[0]), "roleName", Db.S(r[1]), "userId", Db.S(r[2]), "userName", Db.S(r[3]), "pin", Db.S(r[4]))).ToList();
        }
    }
}
