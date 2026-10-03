using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Alfa;

namespace GKurye
{
    // Gelistirici testi: GelismisKuryeSrv.exe /sqltest:<senaryo.json>
    // SambaPOS'a HICBIR sey yazmadan (sahte veritabani) paket alma / teslim SQL'lerini yazdirir.
    public static class SqlTest
    {
        public static void Run(string file)
        {
            var log = new StringBuilder();
            var sc = J.ParseObj(File.ReadAllText(file, Encoding.UTF8));
            string states = J.S(sc, "states");
            Db.Mock = sql =>
            {
                log.Append("---SQL---\n").Append(sql.Trim()).Append('\n');
                Func<object, List<object[]>> one = v => new List<object[]> { new object[] { v } };
                if (sql.Contains("FROM UserRoles WHERE LOWER(Name) LIKE N'%paket%'")) return one(3L);
                if (sql.Contains("FROM UserRoles WHERE LOWER(Name) LIKE N'%admin%'")) return one(1L);
                if (sql.Contains("FROM EntityTypes WHERE LOWER(Name) LIKE N'%paket%'")) return one(3L);
                if (sql.Contains("SELECT AccountTypeId FROM EntityTypes")) return one(4L);
                if (sql.Contains("FROM Entities WHERE EntityTypeId=3 AND Name=")) return new List<object[]> { new object[] { 21L, "Kurye Ali", 9L } };
                if (sql.Contains("SELECT COALESCE(@already,'')")) return new List<object[]> { new object[] { "", states } };
                if (sql.Contains("SELECT TicketStates, DepartmentId FROM Tickets")) return new List<object[]> { new object[] { states, 2 } };
                if (sql.Contains("SELECT Name FROM PaymentTypes WHERE Id=")) return one("Nakit");
                if (sql.Contains("SELECT TOP 1 Id FROM Terminals")) return one(1L);
                if (sql.Contains("SELECT @already, @remaining")) return new List<object[]> { new object[] { false, 47.5m } };
                return new List<object[]>();
            };
            string action = J.S(sc, "action");
            if (action == "claim") Samba.ClaimPackage(J.S(sc, "ticketId"), J.S(sc, "courierName"));
            else
            {
                var r = Samba.MarkDelivered(J.S(sc, "ticketId"), J.Get(sc, "paymentTypeId"), J.IsTrue(sc, "noPayment"), J.Get(sc, "courierUserId"), J.Get(sc, "tenderedAmount"));
                log.Append("---RESULT---\n").Append(J.Str(r)).Append('\n');
            }
            var o = Console.OpenStandardOutput();
            var b = new UTF8Encoding(false).GetBytes(log.ToString());
            o.Write(b, 0, b.Length);
        }
    }
}
