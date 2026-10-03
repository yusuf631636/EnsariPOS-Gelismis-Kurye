/* Sesli alarm motoru - "bekleyen sipariş geldiğinde yüksek sesli alarm, sipariş
   görülene kadar tekrarlanabilir" + "kurye üzerine atama olduğunda da yüksek sesli
   bildirim, örn. Yeni sipariş atandı" (kullanıcı isteği, 15.09.2026).

   Web Audio API ile KENDİ sirenimizi üretiyoruz (dışarıdan ses dosyası YOK) - hem
   lisans derdi yok hem de GainNode ile ses seviyesi kullanıcı ayarına göre kontrol
   edilebiliyor. İki alarm birbirinden KULAKLA ayırt edilsin diye farklı desenler:
   - "bekleyen": iki ton arasında hızlı geçiş yapan klasik siren (acil/dikkat çekici).
   - "atandi": kısa "ding-dong" ikilisi (daha yumuşak ama yine yüksek sesli).

   DÜRÜST SINIR: telefonun FİZİKSEL sessiz/vibrasyon anahtarını bir web sayfası
   ASLA geçersiz kılamaz (bu iOS/Android'in kendi kısıtı, hiçbir web uygulaması
   bunu aşamaz - native uygulamalar bile app-store kurallarıyla sınırlıdır).
   Yapılabilecek EN İYİ şey budur: cihaz sessizde DEĞİLSE mümkün olan en yüksek/dikkat
   çekici sesi çalmak, HER durumda titreşimi de tetiklemek. */

const AlarmSettings = (() => {
  const KEY = 'gks-alarm-settings';
  const DEFAULTS = { volume: 0.9, repeat: 'until-dismissed', type: 'sound-vibrate', pendingAlarmEnabled: true }; // repeat: 'once' | 'x3' | 'until-dismissed'
  function get() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
  }
  function set(patch) {
    const next = { ...get(), ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
    return next;
  }
  return { get, set };
})();

let audioCtx = null;
function ensureAudioCtx() {
  if (audioCtx) return audioCtx;
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { audioCtx = null; }
  return audioCtx;
}
/* Giriş ekranındaki dokunuşta context'i erkenden açıyoruz - tarayıcılar kullanıcı
   jesti olmadan ses başlatmayı engelliyor (autoplay policy); daha sonra arka planda
   tetiklenen alarmların "sessiz kalması" ihtimalini böyle azaltıyoruz. */
document.addEventListener('click', () => { const ctx = ensureAudioCtx(); if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); }, { once: true, capture: true });

function beepPattern(ctx, gainNode, pattern) {
  // pattern: [{freq, dur, gap}]
  let t = ctx.currentTime;
  pattern.forEach(step => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(step.freq, t);
    osc.connect(gainNode);
    osc.start(t);
    osc.stop(t + step.dur);
    t += step.dur + (step.gap || 0);
  });
  return t; // sonraki tekrarın başlayabileceği zaman
}

function sirenPattern() {
  const steps = [];
  for (let i = 0; i < 3; i++) { steps.push({ freq: 880, dur: 0.28, gap: 0.02 }); steps.push({ freq: 660, dur: 0.28, gap: 0.02 }); }
  return steps;
}
function assignPattern() {
  return [{ freq: 784, dur: 0.18, gap: 0.05 }, { freq: 988, dur: 0.32, gap: 0.15 }, { freq: 784, dur: 0.18, gap: 0.05 }, { freq: 988, dur: 0.32, gap: 0 }];
}

let activeLoop = null; // { timer } - devam eden alarmı durdurabilmek için
function stopAlarm() {
  if (activeLoop) { clearTimeout(activeLoop.timer); activeLoop = null; }
}

function repeatCountFor(mode) {
  if (mode === 'once') return 1;
  if (mode === 'x3') return 3;
  return Infinity; // 'until-dismissed'
}

function playAlarm(kind) {
  stopAlarm();
  const settings = AlarmSettings.get();
  const vibratePattern = kind === 'atandi' ? [300, 100, 300, 100, 300] : [400, 150, 400, 150, 400, 150, 400];
  const maxRepeats = repeatCountFor(settings.repeat);
  let count = 0;

  function vibrateOnly() { try { navigator.vibrate && navigator.vibrate(vibratePattern); } catch {} }

  function once() {
    count++;
    if (settings.type !== 'visual-only') vibrateOnly();
    if (settings.type === 'sound-vibrate') {
      const ctx = ensureAudioCtx();
      if (ctx) {
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const gainNode = ctx.createGain();
        gainNode.gain.value = Math.max(0, Math.min(1, settings.volume));
        gainNode.connect(ctx.destination);
        beepPattern(ctx, gainNode, kind === 'atandi' ? assignPattern() : sirenPattern());
      }
    }
    if (count >= maxRepeats) { activeLoop = null; return; }
    activeLoop = { timer: setTimeout(once, kind === 'atandi' ? 3500 : 2600) };
  }
  once();
}

window.GksAlarm = { play: playAlarm, stop: stopAlarm, settings: AlarmSettings };
