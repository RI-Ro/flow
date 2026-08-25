let ctx = null;

// AudioContext нельзя создать до первого жеста пользователя — браузеры
// блокируют автозапуск звука. Поэтому создаём лениво, при первом
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

// Подготовка звука при первом действии пользователя.
//
// Браузеры разрешают запуск звука только из обработчика жеста. События
// же приходят по WebSocket — то есть не из жеста вовсе, — и созданный
// в этот момент AudioContext остаётся в состоянии suspended: звонок
// «отыгрывается» в тишину без единой ошибки в консоли. Именно поэтому
// уведомления могли молчать до тех пор, пока человек не открывал
// настройки и не нажимал «прослушать».
//
// Поэтому контекст создаётся и разблокируется заранее, на первом же
// клике или нажатии клавиши в приложении, и дальше готов к работе.
export function primeAudio() {
  const unlock = () => {
    const c = context();
    if (c && c.state === "suspended") c.resume().catch(() => {});
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });
}

const SETTINGS_KEY = "kanban.sound";

// Что звучит по умолчанию.
//
// Перемещение задач между колонками намеренно выключено: на активной
// доске карточки двигаются постоянно, и звук на каждое перетаскивание
// превращается в трещотку — после чего человек отключает звук целиком,
// вместе с действительно важными сигналами.
const DEFAULTS = {
  enabled: true,
  volume: 0.16,
  events: {
    notification: true,   // личное уведомление
    comment: true,        // новый комментарий
    taskCreated: true,    // новая задача на доске
    taskMoved: false,     // перемещение между колонками
    taskDone: true,       // задача сдана или завершена
  },
};

export function loadSoundSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return {
      ...DEFAULTS,
      ...saved,
      events: { ...DEFAULTS.events, ...(saved.events || {}) },
    };
  } catch {
    return { ...DEFAULTS, events: { ...DEFAULTS.events } };
  }
}

export function saveSoundSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

// Партитуры сигналов.
//
// Различаются высотой и направлением, а не длиной: нисходящий сигнал
// воспринимается как «что-то закрылось», восходящий — как «появилось
// новое». Это позволяет понять смысл события, не глядя на экран, в чём
// и состоит смысл звукового уведомления.
const TONES = {
  notification: [
    { freq: 740, start: 0, dur: 0.09 },
    { freq: 988, start: 0.09, dur: 0.14 },
  ],
  // Одиночный мягкий тон — «кто-то написал», менее навязчиво.
  comment: [{ freq: 660, start: 0, dur: 0.11 }],
  taskCreated: [
    { freq: 523, start: 0, dur: 0.08 },
    { freq: 784, start: 0.08, dur: 0.13 },
  ],
  // Короткий щелчок — «карточка переехала».
  taskMoved: [{ freq: 520, start: 0, dur: 0.06 }],
  // Нисходящая пара — «работа закрыта».
  taskDone: [
    { freq: 880, start: 0, dur: 0.09 },
    { freq: 587, start: 0.09, dur: 0.16 },
  ],
};

// Защита от лавины: при массовом событии (перенос десятка задач,
// групповая правка) сигналы наложились бы в неразборчивый гул.
let lastPlayed = 0;
const MIN_GAP_MS = 220;

export function playEventSound(kind, settingsOverride) {
  const settings = settingsOverride || loadSoundSettings();
  if (!settings.enabled) return;
  if (settings.events && settings.events[kind] === false) return;

  const tones = TONES[kind];
  if (!tones) return;

  const now = Date.now();
  if (now - lastPlayed < MIN_GAP_MS) return;
  lastPlayed = now;

  const c = context();
  if (!c) return;

  const volume = typeof settings.volume === "number" ? settings.volume : DEFAULTS.volume;

  for (const t of tones) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.value = t.freq;

    const startAt = c.currentTime + t.start;
    const endAt = startAt + t.dur;

    // Плавное нарастание и экспоненциальное затухание: резкий обрыв
    // синусоиды даёт щелчок, слышный отчётливее самого сигнала.
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(volume, startAt + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, endAt);

    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(startAt);
    osc.stop(endAt + 0.02);
  }
}

// Прежнее имя сохранено: на него уже есть вызовы.
export function playNotificationSound() {
  playEventSound("notification");
}

export const SOUND_EVENT_LABELS = {
  notification: "Личные уведомления",
  comment: "Новые комментарии",
  taskCreated: "Новые задачи",
  taskMoved: "Перемещение задач",
  taskDone: "Сдача и завершение",
};
