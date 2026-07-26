let ctx = null;

// AudioContext нельзя создать до первого жеста пользователя (браузеры
// блокируют автозапуск звука) — поэтому лениво создаём его при первом
// реальном вызове, а не при загрузке модуля.
function context() {
  if (!ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

// Два коротких тона по восходящей — узнаваемый, но ненавязчивый сигнал,
// без необходимости тащить в репозиторий бинарный mp3/wav.
export function playNotificationSound() {
  const c = context();
  if (!c) return;

  const tones = [
    { freq: 740, start: 0, dur: 0.09 },
    { freq: 988, start: 0.09, dur: 0.14 },
  ];

  for (const t of tones) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.value = t.freq;

    const startAt = c.currentTime + t.start;
    const endAt = startAt + t.dur;
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(0.16, startAt + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, endAt);

    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(startAt);
    osc.stop(endAt + 0.02);
  }
}
