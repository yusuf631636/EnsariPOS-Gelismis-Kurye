/* Paylaşılan tema mantığı (courier + restoran). <head> içinde, render'dan ÖNCE
   senkron çalışacak şekilde eklenir - "önce koyu çizilip sonra açığa zıplama"
   (flash) olmasın diye. localStorage: 'gks-theme' = 'system' | 'light' | 'dark'. */
(function () {
  function apply(pref) {
    var root = document.documentElement;
    if (pref === 'light' || pref === 'dark') root.setAttribute('data-theme', pref);
    else root.removeAttribute('data-theme');
  }
  var saved = 'system';
  try { saved = localStorage.getItem('gks-theme') || 'system'; } catch {}
  apply(saved);
  window.gksTheme = {
    get: function () { try { return localStorage.getItem('gks-theme') || 'system'; } catch { return 'system'; } },
    set: function (pref) {
      try { localStorage.setItem('gks-theme', pref); } catch {}
      apply(pref);
    }
  };
})();
