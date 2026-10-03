using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Alfa
{
    // node:sqlite (DatabaseSync) karsiligi - AYNI veritabani dosyasini kullanir (veri gocu yok).
    // Kurulumla gelen resmi sqlite3.dll (sqlite3-x64.dll / sqlite3-x86.dll, sqlite.org 3.53.4) yuklenir;
    // bulunamazsa Windows 10+'in kendi winsqlite3.dll'i denenir.
    public class Sqlite : IDisposable
    {
        const int SQLITE_OK = 0, SQLITE_ROW = 100, SQLITE_DONE = 101;
        const int SQLITE_INTEGER = 1, SQLITE_FLOAT = 2, SQLITE_TEXT = 3, SQLITE_BLOB = 4, SQLITE_NULL = 5;
        static readonly IntPtr SQLITE_TRANSIENT = new IntPtr(-1);

        [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr LoadLibrary(string path);
        [DllImport("kernel32", CharSet = CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr h, string name);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int D_open_v2(byte[] filename, out IntPtr db, int flags, IntPtr vfs);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int D_close_v2(IntPtr db);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int D_prepare_v2(IntPtr db, byte[] sql, int n, out IntPtr stmt, IntPtr tail);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int D_step(IntPtr stmt);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int D_finalize(IntPtr stmt);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int D_column_count(IntPtr stmt);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate IntPtr D_column_name(IntPtr stmt, int i);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int D_column_type(IntPtr stmt, int i);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate long D_column_int64(IntPtr stmt, int i);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate double D_column_double(IntPtr stmt, int i);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate IntPtr D_column_text(IntPtr stmt, int i);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int D_column_bytes(IntPtr stmt, int i);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int D_bind_null(IntPtr stmt, int i);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int D_bind_int64(IntPtr stmt, int i, long v);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int D_bind_double(IntPtr stmt, int i, double v);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int D_bind_text(IntPtr stmt, int i, byte[] v, int n, IntPtr destructor);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int D_prepare_ptr(IntPtr db, IntPtr sql, int n, out IntPtr stmt, out IntPtr tail);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate IntPtr D_errmsg(IntPtr db);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int D_busy_timeout(IntPtr db, int ms);

        static D_open_v2 _open; static D_close_v2 _close; static D_prepare_v2 _prepare; static D_step _step; static D_finalize _finalize;
        static D_column_count _colCount; static D_column_name _colName; static D_column_type _colType; static D_column_int64 _colInt64;
        static D_column_double _colDouble; static D_column_text _colText; static D_column_bytes _colBytes;
        static D_bind_null _bindNull; static D_bind_int64 _bindInt64; static D_bind_double _bindDouble; static D_bind_text _bindText;
        static D_errmsg _errmsg; static D_busy_timeout _busy; static D_prepare_ptr _preparePtr;
        static readonly object _loadLock = new object();
        public static string LoadedFrom;

        static T F<T>(IntPtr lib, string name) where T : class
        {
            IntPtr p = GetProcAddress(lib, name);
            if (p == IntPtr.Zero) throw new Exception("SQLite fonksiyonu bulunamadı: " + name);
            return Marshal.GetDelegateForFunctionPointer(p, typeof(T)) as T;
        }

        static void EnsureLoaded(string baseDir)
        {
            lock (_loadLock)
            {
                if (_open != null) return;
                string arch = IntPtr.Size == 8 ? "x64" : "x86";
                var candidates = new List<string> {
                    Path.Combine(baseDir, "sqlite3-" + arch + ".dll"), Path.Combine(baseDir, "kur", "sqlite3-" + arch + ".dll"),
                    Path.Combine(baseDir, "sqlite3.dll"), "winsqlite3.dll" };
                IntPtr lib = IntPtr.Zero; string prefix = "sqlite3_";
                foreach (var c in candidates)
                {
                    if (c.Contains("\\") && !File.Exists(c)) continue;
                    lib = LoadLibrary(c);
                    if (lib != IntPtr.Zero) { LoadedFrom = c; break; }
                }
                if (lib == IntPtr.Zero) throw new Exception("SQLite kütüphanesi (sqlite3-" + arch + ".dll) bulunamadı.");
                // winsqlite3 ayni isimleri kullanir (stdcall degil, cdecl - x64'te fark yok; x86'da winsqlite3 __stdcall!)
                bool win = LoadedFrom == "winsqlite3.dll";
                if (win && IntPtr.Size == 4) throw new Exception("32 bit winsqlite3 desteklenmiyor; sqlite3-x86.dll gerekli.");
                _open = F<D_open_v2>(lib, prefix + "open_v2"); _close = F<D_close_v2>(lib, prefix + "close_v2");
                _prepare = F<D_prepare_v2>(lib, prefix + "prepare_v2"); _preparePtr = F<D_prepare_ptr>(lib, prefix + "prepare_v2"); _step = F<D_step>(lib, prefix + "step"); _finalize = F<D_finalize>(lib, prefix + "finalize");
                _colCount = F<D_column_count>(lib, prefix + "column_count"); _colName = F<D_column_name>(lib, prefix + "column_name");
                _colType = F<D_column_type>(lib, prefix + "column_type"); _colInt64 = F<D_column_int64>(lib, prefix + "column_int64");
                _colDouble = F<D_column_double>(lib, prefix + "column_double"); _colText = F<D_column_text>(lib, prefix + "column_text");
                _colBytes = F<D_column_bytes>(lib, prefix + "column_bytes");
                _bindNull = F<D_bind_null>(lib, prefix + "bind_null"); _bindInt64 = F<D_bind_int64>(lib, prefix + "bind_int64");
                _bindDouble = F<D_bind_double>(lib, prefix + "bind_double"); _bindText = F<D_bind_text>(lib, prefix + "bind_text");
                _errmsg = F<D_errmsg>(lib, prefix + "errmsg"); _busy = F<D_busy_timeout>(lib, prefix + "busy_timeout");
            }
        }

        IntPtr _db;
        readonly object _lock = new object();

        public Sqlite(string file, string baseDir)
        {
            EnsureLoaded(baseDir);
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            // SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
            int rc = _open(Z(file), out _db, 0x02 | 0x04 | 0x10000, IntPtr.Zero);
            if (rc != SQLITE_OK) throw new Exception("SQLite açılamadı: " + file + " (" + rc + ")");
            _busy(_db, 5000);
        }

        static byte[] Z(string s) { var b = Encoding.UTF8.GetBytes(s ?? ""); var z = new byte[b.Length + 1]; Array.Copy(b, z, b.Length); return z; }
        static string Utf8(IntPtr p, int len) { if (p == IntPtr.Zero) return null; var b = new byte[len]; Marshal.Copy(p, b, 0, len); return Encoding.UTF8.GetString(b); }
        static string Utf8Z(IntPtr p)
        {
            if (p == IntPtr.Zero) return null;
            int len = 0; while (Marshal.ReadByte(p, len) != 0) len++;
            return Utf8(p, len);
        }
        string Err() { return Utf8Z(_errmsg(_db)); }

        public void Exec(string sql)
        {
            lock (_lock)
            {
                var bytes = Z(sql);
                var h = GCHandle.Alloc(bytes, GCHandleType.Pinned);
                try
                {
                    IntPtr cur = h.AddrOfPinnedObject();
                    long end = cur.ToInt64() + bytes.Length - 1;   // sondaki 0 haric
                    while (cur.ToInt64() < end)
                    {
                        IntPtr stmt, tail;
                        int rc = _preparePtr(_db, cur, -1, out stmt, out tail);
                        if (rc != SQLITE_OK) throw new Exception("SQLite: " + Err());
                        if (stmt != IntPtr.Zero)
                        {
                            try { int s; while ((s = _step(stmt)) == SQLITE_ROW) { } if (s != SQLITE_DONE) throw new Exception("SQLite: " + Err()); }
                            finally { _finalize(stmt); }
                        }
                        if (tail == IntPtr.Zero || tail.ToInt64() <= cur.ToInt64()) break;
                        cur = tail;
                    }
                }
                finally { h.Free(); }
            }
        }
        IntPtr Prepare(string sql, object[] args)
        {
            IntPtr stmt;
            var b = Encoding.UTF8.GetBytes(sql);
            int rc = _prepare(_db, b, b.Length, out stmt, IntPtr.Zero);
            if (rc != SQLITE_OK) throw new Exception("SQLite: " + Err());
            for (int i = 0; args != null && i < args.Length; i++)
            {
                object a = args[i];
                if (a == null) _bindNull(stmt, i + 1);
                else if (a is bool) _bindInt64(stmt, i + 1, (bool)a ? 1 : 0);
                else if (a is int || a is long || a is short || a is byte) _bindInt64(stmt, i + 1, Convert.ToInt64(a));
                else if (a is double || a is float || a is decimal)
                {
                    double d = Convert.ToDouble(a);
                    // node:sqlite tam sayi degerli JS sayilarini INTEGER olarak baglar
                    if (d == Math.Floor(d) && Math.Abs(d) < 9e15) _bindInt64(stmt, i + 1, (long)d); else _bindDouble(stmt, i + 1, d);
                }
                else { var t = Encoding.UTF8.GetBytes(Convert.ToString(a, System.Globalization.CultureInfo.InvariantCulture)); _bindText(stmt, i + 1, t, t.Length, SQLITE_TRANSIENT); }
            }
            return stmt;
        }

        public List<Dictionary<string, object>> All(string sql, params object[] args)
        {
            lock (_lock)
            {
                var list = new List<Dictionary<string, object>>();
                IntPtr stmt = Prepare(sql, args);
                try
                {
                    int n = _colCount(stmt), rc;
                    var names = new string[n];
                    for (int i = 0; i < n; i++) names[i] = Utf8Z(_colName(stmt, i));
                    while ((rc = _step(stmt)) == SQLITE_ROW)
                    {
                        var row = new Dictionary<string, object>();
                        for (int i = 0; i < n; i++)
                        {
                            switch (_colType(stmt, i))
                            {
                                case SQLITE_INTEGER: row[names[i]] = _colInt64(stmt, i); break;
                                case SQLITE_FLOAT: row[names[i]] = _colDouble(stmt, i); break;
                                case SQLITE_NULL: row[names[i]] = null; break;
                                default: row[names[i]] = Utf8(_colText(stmt, i), _colBytes(stmt, i)); break;
                            }
                        }
                        list.Add(row);
                    }
                    if (rc != SQLITE_DONE) throw new Exception("SQLite: " + Err());
                }
                finally { _finalize(stmt); }
                return list;
            }
        }
        public Dictionary<string, object> Get(string sql, params object[] args) { var l = All(sql, args); return l.Count > 0 ? l[0] : null; }
        public void Run(string sql, params object[] args) { All(sql, args); }

        public void Dispose() { lock (_lock) { if (_db != IntPtr.Zero) { _close(_db); _db = IntPtr.Zero; } } }
    }
}
