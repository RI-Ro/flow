// Оформление в инженерной эстетике balun.courses: тёмная база, один
// яркий неоновый акцент плюс вторичный для градиентов и подсветки,
// hairline-рамки, мягкое свечение вокруг акцентных элементов.
//
// Ровно 10 тем: 5 тёмных и 5 светлых. Balun — по умолчанию.
//
// accent2 и glow — дополнение к базовой палитре: первый идёт в
// градиенты и вторичные акценты, второй в тени акцентных кнопок.
// success/warning/danger подобраны под каждую тему отдельно, а не взяты
// общими: на кислотном лайме и на пастельной розе один и тот же
// зелёный читается по-разному.
export const THEMES = {
  // ── тёмные ────────────────────────────────────────────────────────
  balun: {
    name: "Balun", dark: true,
    bg: "#0a0a0c", surface: "#131318", surfaceAlt: "#1c1c23", border: "#26262f",
    text: "#f2f2f5", textMuted: "#8b8b96",
    accent: "#c8ff2d", accentText: "#0a0a0c", accent2: "#7c5cff",
    glow: "rgba(200,255,45,.18)",
    success: "#7ee787", warning: "#ffd166", danger: "#ff6b81", info: "#7c5cff",
  },
  midnight: {
    name: "Midnight", dark: true,
    bg: "#0a0e1a", surface: "#111826", surfaceAlt: "#182238", border: "#20293d",
    text: "#e6ecf7", textMuted: "#7e8ba6",
    accent: "#4f8cff", accentText: "#ffffff", accent2: "#38e8c8",
    glow: "rgba(79,140,255,.2)",
    success: "#38e8c8", warning: "#f0b429", danger: "#ff6b81", info: "#4f8cff",
  },
  carbon: {
    name: "Carbon", dark: true,
    bg: "#000000", surface: "#0c0d0f", surfaceAlt: "#14171b", border: "#20242a",
    text: "#e8f0f2", textMuted: "#7f8b93",
    accent: "#22d3ee", accentText: "#001417", accent2: "#34d399",
    glow: "rgba(34,211,238,.2)",
    success: "#34d399", warning: "#fbbf24", danger: "#fb7185", info: "#22d3ee",
  },
  graphite: {
    name: "Graphite", dark: true,
    bg: "#101012", surface: "#1a1a1e", surfaceAlt: "#232329", border: "#2c2c33",
    text: "#eceaf0", textMuted: "#8f8b98",
    accent: "#a78bfa", accentText: "#12101a", accent2: "#f472b6",
    glow: "rgba(167,139,250,.2)",
    success: "#6ee7b7", warning: "#fcd34d", danger: "#f472b6", info: "#a78bfa",
  },
  ember: {
    name: "Ember", dark: true,
    bg: "#120c0a", surface: "#1d1512", surfaceAlt: "#281c17", border: "#372823",
    text: "#f5ece7", textMuted: "#a68b7f",
    accent: "#ff7849", accentText: "#1a0d07", accent2: "#ffd166",
    glow: "rgba(255,120,73,.2)",
    success: "#86efac", warning: "#ffd166", danger: "#ff5c5c", info: "#ff7849",
  },

  // ── светлые ───────────────────────────────────────────────────────
  light: {
    name: "Light", dark: false,
    bg: "#f5f6f8", surface: "#ffffff", surfaceAlt: "#eef1f6", border: "#e4e7ec",
    text: "#15171c", textMuted: "#6b7280",
    accent: "#4f46e5", accentText: "#ffffff", accent2: "#0ea5e9",
    glow: "rgba(79,70,229,.14)",
    success: "#059669", warning: "#b45309", danger: "#dc2626", info: "#4f46e5",
  },
  paper: {
    name: "Paper", dark: false,
    bg: "#f5f1e8", surface: "#fffdf8", surfaceAlt: "#efe8d8", border: "#e6ddc9",
    text: "#2a2419", textMuted: "#8a7d63",
    accent: "#b45309", accentText: "#fffdf8", accent2: "#0f766e",
    glow: "rgba(180,83,9,.14)",
    success: "#0f766e", warning: "#a16207", danger: "#b91c1c", info: "#b45309",
  },
  mint: {
    name: "Mint", dark: false,
    bg: "#eef5f1", surface: "#ffffff", surfaceAlt: "#e3efe8", border: "#d6e6dd",
    text: "#12241b", textMuted: "#5f7a68",
    accent: "#059669", accentText: "#ffffff", accent2: "#0d9488",
    glow: "rgba(5,150,105,.14)",
    success: "#059669", warning: "#b45309", danger: "#be123c", info: "#0d9488",
  },
  frost: {
    name: "Frost", dark: false,
    bg: "#eef3f8", surface: "#ffffff", surfaceAlt: "#e5eef6", border: "#dae6f0",
    text: "#10202e", textMuted: "#5f7590",
    accent: "#0284c7", accentText: "#ffffff", accent2: "#6366f1",
    glow: "rgba(2,132,199,.14)",
    success: "#047857", warning: "#b45309", danger: "#be123c", info: "#0284c7",
  },
  rose: {
    name: "Rose", dark: false,
    bg: "#faf0f4", surface: "#ffffff", surfaceAlt: "#f5e5ed", border: "#f0dbe4",
    text: "#2a1620", textMuted: "#8a6b78",
    accent: "#db2777", accentText: "#ffffff", accent2: "#7c3aed",
    glow: "rgba(219,39,119,.14)",
    success: "#047857", warning: "#b45309", danger: "#be123c", info: "#7c3aed",
  },
};

// Порядок в переключателе: сначала тёмные, потом светлые.
export const THEME_ORDER = [
  "balun", "midnight", "carbon", "graphite", "ember",
  "light", "paper", "mint", "frost", "rose",
];

const preset = (base, ...spots) => [...spots, base].join(", ");

export const BG_PRESETS = [
  { id: "none", label: "Без фона", css: null },
  { id: "dune", label: "Дюны", css: preset("linear-gradient(135deg,#E8B4A0 0%,#C97B63 45%,#7A4A3A 100%)",
      "radial-gradient(60% 45% at 20% 25%, rgba(255,226,199,.85), transparent 70%)",
      "radial-gradient(45% 40% at 78% 70%, rgba(110,58,40,.65), transparent 70%)") },
  { id: "deep", label: "Глубина", css: preset("linear-gradient(160deg,#1B3A5C 0%,#2E6E8E 55%,#5FC9C0 100%)",
      "radial-gradient(55% 45% at 75% 20%, rgba(150,235,230,.7), transparent 70%)",
      "radial-gradient(50% 50% at 15% 80%, rgba(10,30,55,.75), transparent 70%)") },
  { id: "grove", label: "Роща", css: preset("linear-gradient(140deg,#2F5233 0%,#6B9B54 50%,#C9D98A 100%)",
      "radial-gradient(50% 45% at 25% 30%, rgba(215,240,170,.7), transparent 70%)",
      "radial-gradient(45% 45% at 80% 75%, rgba(25,55,30,.6), transparent 70%)") },
  { id: "haze", label: "Дымка", css: preset("linear-gradient(150deg,#6B5B95 0%,#B198C9 50%,#E8D8F0 100%)",
      "radial-gradient(55% 50% at 70% 25%, rgba(255,245,255,.8), transparent 70%)",
      "radial-gradient(45% 45% at 20% 80%, rgba(70,50,110,.6), transparent 70%)") },
  { id: "steel", label: "Сталь", css: preset("linear-gradient(135deg,#3A3F47 0%,#6E7681 50%,#B8BFC7 100%)",
      "radial-gradient(50% 45% at 30% 20%, rgba(225,232,240,.65), transparent 70%)",
      "radial-gradient(50% 50% at 85% 80%, rgba(25,30,38,.7), transparent 70%)") },
  { id: "coral", label: "Коралл", css: preset("linear-gradient(145deg,#FF8A6B 0%,#E2506B 55%,#8E2A5B 100%)",
      "radial-gradient(55% 45% at 25% 25%, rgba(255,215,190,.8), transparent 70%)",
      "radial-gradient(45% 45% at 80% 75%, rgba(90,20,70,.65), transparent 70%)") },
  { id: "aurora", label: "Сияние", css: preset("linear-gradient(150deg,#0F2A3F 0%,#2C7A6B 45%,#8FD98A 100%)",
      "radial-gradient(60% 40% at 70% 15%, rgba(160,255,215,.65), transparent 70%)",
      "radial-gradient(50% 50% at 20% 85%, rgba(8,25,40,.8), transparent 70%)") },
  { id: "sand", label: "Песок", css: preset("linear-gradient(135deg,#F3E3C8 0%,#D9BE92 50%,#A8875C 100%)",
      "radial-gradient(55% 50% at 30% 25%, rgba(255,250,235,.85), transparent 70%)",
      "radial-gradient(45% 45% at 80% 80%, rgba(130,100,60,.55), transparent 70%)") },
  { id: "ink", label: "Чернила", css: preset("linear-gradient(140deg,#12141C 0%,#232838 55%,#414B68 100%)",
      "radial-gradient(50% 45% at 75% 25%, rgba(120,140,200,.5), transparent 70%)",
      "radial-gradient(55% 50% at 20% 80%, rgba(5,7,12,.9), transparent 70%)") },
  { id: "mint", label: "Мята", css: preset("linear-gradient(150deg,#E4F7F0 0%,#A6DFD0 55%,#5CAFA0 100%)",
      "radial-gradient(55% 45% at 25% 25%, rgba(255,255,255,.9), transparent 70%)",
      "radial-gradient(45% 45% at 80% 80%, rgba(50,120,110,.5), transparent 70%)") },
  { id: "plum", label: "Слива", css: preset("linear-gradient(140deg,#2B1B3D 0%,#5C3A78 50%,#A87BC4 100%)",
      "radial-gradient(50% 45% at 78% 22%, rgba(220,180,245,.6), transparent 70%)",
      "radial-gradient(50% 50% at 18% 82%, rgba(20,10,30,.8), transparent 70%)") },
  { id: "clay", label: "Глина", css: preset("linear-gradient(135deg,#C9714F 0%,#8E4B3B 50%,#4E2A26 100%)",
      "radial-gradient(55% 45% at 28% 25%, rgba(245,190,155,.7), transparent 70%)",
      "radial-gradient(45% 45% at 80% 78%, rgba(40,18,16,.7), transparent 70%)") },
];


// ---------------------------------------------------------------------
// Готовые фоновые изображения, доступные всем пользователям.
//
// Это не ссылки на внешние картинки и не файлы в репозитории, а SVG-узоры,
// встроенные прямо в CSS как data-URI. Причины такого выбора:
// изображение не зависит от внешнего хостинга и работает офлайн, весит
// сотни байт вместо сотен килобайт, масштабируется без потери резкости
// на любом экране и не требует раздачи через сервер с проверкой прав.
//
// Узор кладётся поверх градиента полупрозрачными штрихами, поэтому один
// и тот же рисунок уместно смотрится и в светлой, и в тёмной теме.
// Плитка повторяется, поэтому у таких фонов size = "auto", а не "cover":
// растянуть плитку на весь экран означало бы показать один гигантский
// фрагмент узора.
// ---------------------------------------------------------------------
const svg = (body, w, h) =>
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'%3E${body}%3C/svg%3E")`;

const stroke = (d, op = "0.14", sw = "1.5") =>
  `%3Cpath d='${d}' fill='none' stroke='%23ffffff' stroke-opacity='${op}' stroke-width='${sw}'/%3E`;

export const BG_IMAGES = [
  {
    id: "img-hex", label: "Соты", size: "auto",
    css: svg(stroke("M28 66L0 50L0 16L28 0L56 16L56 50L28 66L28 100") +
             stroke("M28 0L28 34L0 50L0 84L28 100L56 84L56 50L28 34"), 56, 100) +
         ", linear-gradient(135deg,#2E5A7A 0%,#3D7A8E 50%,#5FA8A0 100%)",
  },
  {
    id: "img-topo", label: "Рельеф", size: "auto",
    css: svg(stroke("M0 40 Q 30 10 60 40 T 120 40", "0.16") +
             stroke("M0 60 Q 30 30 60 60 T 120 60", "0.12") +
             stroke("M0 80 Q 30 50 60 80 T 120 80", "0.08"), 120, 120) +
         ", linear-gradient(150deg,#2F5233 0%,#5C8A4A 55%,#A8C97F 100%)",
  },
  {
    id: "img-waves", label: "Волны", size: "auto",
    css: svg(stroke("M0 20 Q 20 0 40 20 T 80 20", "0.18", "2") +
             stroke("M0 45 Q 20 25 40 45 T 80 45", "0.12", "2"), 80, 60) +
         ", linear-gradient(160deg,#1B3A5C 0%,#2E6E8E 55%,#6FC9C0 100%)",
  },
  {
    id: "img-dots", label: "Горошек", size: "auto",
    css: svg("%3Ccircle cx='12' cy='12' r='2.5' fill='%23ffffff' fill-opacity='0.18'/%3E" +
             "%3Ccircle cx='36' cy='36' r='2.5' fill='%23ffffff' fill-opacity='0.18'/%3E", 48, 48) +
         ", linear-gradient(140deg,#6B5B95 0%,#9B84BE 50%,#D8C8E8 100%)",
  },
  {
    id: "img-grid", label: "Клетка", size: "auto",
    css: svg(stroke("M0 0 L 0 40 M 0 0 L 40 0", "0.14", "1") +
             stroke("M0 20 L 40 20 M 20 0 L 20 40", "0.07", "1"), 40, 40) +
         ", linear-gradient(135deg,#3A3F47 0%,#5E6875 50%,#98A2AE 100%)",
  },
  {
    id: "img-tri", label: "Грани", size: "auto",
    css: svg(stroke("M0 60 L 30 0 L 60 60 Z", "0.13") +
             stroke("M30 60 L 60 0 L 90 60 Z", "0.09"), 60, 60) +
         ", linear-gradient(145deg,#C2603F 0%,#8E3B4B 55%,#4E2A46 100%)",
  },
  {
    id: "img-diag", label: "Диагонали", size: "auto",
    css: svg(stroke("M-10 30 L 30 -10 M 0 40 L 40 0 M 10 50 L 50 10", "0.13", "3"), 40, 40) +
         ", linear-gradient(135deg,#B8874A 0%,#8A6136 50%,#4E3A22 100%)",
  },
  {
    id: "img-bubbles", label: "Пузыри", size: "auto",
    css: svg("%3Ccircle cx='20' cy='20' r='14' fill='none' stroke='%23ffffff' stroke-opacity='0.13' stroke-width='1.5'/%3E" +
             "%3Ccircle cx='60' cy='55' r='9' fill='none' stroke='%23ffffff' stroke-opacity='0.11' stroke-width='1.5'/%3E" +
             "%3Ccircle cx='68' cy='14' r='5' fill='none' stroke='%23ffffff' stroke-opacity='0.15' stroke-width='1.5'/%3E", 80, 80) +
         ", linear-gradient(150deg,#0F3A4F 0%,#2C7A7B 50%,#7FD4B8 100%)",
  },
  {
    id: "img-chevron", label: "Зигзаг", size: "auto",
    css: svg(stroke("M0 20 L 15 5 L 30 20 L 45 5 L 60 20", "0.15", "2") +
             stroke("M0 40 L 15 25 L 30 40 L 45 25 L 60 40", "0.10", "2"), 60, 45) +
         ", linear-gradient(140deg,#2B1B3D 0%,#5C3A78 50%,#A87BC4 100%)",
  },
  {
    id: "img-cross", label: "Плетение", size: "auto",
    css: svg(stroke("M10 4 L 10 16 M 4 10 L 16 10", "0.16", "1.5") +
             stroke("M30 24 L 30 36 M 24 30 L 36 30", "0.16", "1.5"), 40, 40) +
         ", linear-gradient(135deg,#8E4B3B 0%,#C9714F 45%,#F0B48A 100%)",
  },
  {
    id: "img-rain", label: "Штрихи", size: "auto",
    css: svg(stroke("M8 0 L 4 14 M 24 6 L 20 20 M 40 0 L 36 14 M 16 22 L 12 36 M 32 26 L 28 40", "0.14", "1.5"), 48, 48) +
         ", linear-gradient(160deg,#12141C 0%,#2A3350 55%,#4E5F8A 100%)",
  },
];

// Полный список для выбора фона: сначала однотонные градиенты, затем
// узорные изображения. Компоненты работают с этим списком, поэтому
// добавление нового фона не требует правок в интерфейсе.
export const BG_PHOTOS = [
  { id: "img:dunes",  label: "Дюны" },
  { id: "img:deep",   label: "Глубина" },
  { id: "img:grove",  label: "Роща" },
  { id: "img:haze",   label: "Дымка" },
  { id: "img:steel",  label: "Сталь" },
  { id: "img:coral",  label: "Коралл" },
  { id: "img:aurora", label: "Сияние" },
  { id: "img:sand",   label: "Песок" },
  { id: "img:ink",    label: "Чернила" },
  { id: "img:mint",   label: "Мята" },
  { id: "img:plum",   label: "Слива" },
  { id: "img:clay",   label: "Глина" },

  // Пейзажи городов и природы России.
  //
  // Это СТИЛИЗАЦИИ, а не фотографии: изображения построены
  // алгоритмически (силуэты рельефа и застройки под градиентным небом),
  // потому что подобрать настоящие снимки с подходящей лицензией в
  // ходе сборки было нечем. Пропорции и палитра подобраны под каждое
  // место, но узнаваемых видов там нет.
  //
  // Чтобы поставить настоящие фотографии, замените одноимённые файлы в
  // frontend/public/backgrounds/ (полный кадр 1920×1200 и уменьшённая
  // копия <имя>-thumb.jpg 320×200). Код менять не нужно.
  { id: "img:gorod-belgorod",   label: "Белгород" },
  { id: "img:gorod-spb",        label: "Санкт-Петербург" },
  { id: "img:gorod-moskva",     label: "Москва" },
  { id: "img:gorod-kislovodsk", label: "Кисловодск" },
  { id: "img:gorod-sochi",      label: "Сочи" },
  { id: "img:gorod-simferopol", label: "Симферополь" },
  { id: "img:gorod-volgograd",  label: "Волгоград" },
  { id: "img:priroda-uschelye", label: "Берёзовское ущелье" },
  { id: "img:priroda-dagestan", label: "Дагестан" },
  { id: "img:priroda-elbrus",   label: "Эльбрус" },
  { id: "img:priroda-baikal",   label: "Байкал" },
  { id: "img:priroda-altay",    label: "Алтай" },
];

// Три набора: однотонные градиенты, CSS-узоры и настоящие фотографии
// из статики сервера. Порядок определяет вид сетки выбора в настройках.
export const ALL_BACKGROUNDS = [...BG_PRESETS, ...BG_PHOTOS, ...BG_IMAGES];

export const bgById = (id) => ALL_BACKGROUNDS.find((b) => b.id === id) || null;

// Готовые изображения, лежащие на сервере (frontend/public/backgrounds,
// после сборки — в статике). В отличие от пресетов-градиентов выше это
// настоящие jpg: они одинаковы у всех пользователей и не требуют, чтобы
// каждый загружал своё.
//
// В базе, как и у градиентов, хранится идентификатор, а не путь: если
// каталог со статикой переедет, менять записи в таблице не придётся.

const imageName = (presetId) =>
  typeof presetId === "string" && presetId.startsWith("img:") ? presetId.slice(4) : null;

export const bgImageUrl = (presetId) => {
  const name = imageName(presetId);
  return name ? `/backgrounds/${name}.jpg` : null;
};

export const bgThumbUrl = (presetId) => {
  const name = imageName(presetId);
  return name ? `/backgrounds/${name}-thumb.jpg` : null;
};

export const PRIORITIES = {
  normal:      { label: "Обычный",       color: "info",    order: 0 },
  dated:       { label: "Установлен срок", color: "info",  order: 1, requiresDate: true },
  prompt:      { label: "Оперативно",    color: "warning", order: 2 },
  urgent:      { label: "Срочно",        color: "danger",  order: 3 },
  very_urgent: { label: "Весьма срочно", color: "danger",  order: 4 },
};

// Цвет срока исполнения по остатку времени. Ступени намеренно грубые:
// точное число дней человек и так видит рядом, а цвет нужен, чтобы
// оценить состояние доски одним взглядом.
export const DUE_LEVELS = [
  { id: "overdue", label: "Просрочено",        maxDays: -1,   light: "#B3000F", dark: "#FF5C6E" },
  { id: "week1",   label: "Меньше недели",     maxDays: 7,    light: "#C2410C", dark: "#FF8A4C" },
  { id: "week2",   label: "Меньше двух недель", maxDays: 14,  light: "#B45309", dark: "#F0B429" },
  { id: "week3",   label: "Меньше трёх недель", maxDays: 21,  light: "#4D7C0F", dark: "#A3D45E" },
  { id: "week4",   label: "Больше трёх недель", maxDays: 9999, light: "#15803D", dark: "#4ADE80" },
];

export function dueLevel(dueDate, completed) {
  if (!dueDate || completed) return null;
  const today = new Date(new Date().toDateString());
  const due = new Date(dueDate);
  const days = Math.round((due - today) / 86400000);
  return DUE_LEVELS.find((l) => days <= l.maxDays) || DUE_LEVELS[DUE_LEVELS.length - 1];
}

export function dueColor(dueDate, completed, theme) {
  const level = dueLevel(dueDate, completed);
  if (!level) return null;
  return theme.dark ? level.dark : level.light;
}

// Полупрозрачные заливки карточек. Значения намеренно с альфа-каналом:
// карточка должна оставаться читаемой поверх любого фона доски и в
// любой теме, а сплошной цвет перекрывал бы текст. Для тёмных тем
// прозрачность выше — на тёмном фоне те же оттенки выглядят ярче.
export const TASK_COLORS = [
  { id: "none",    label: "Без цвета", light: "transparent",            dark: "transparent" },
  { id: "amber",   label: "Янтарь",    light: "rgba(232,164,60,.22)",   dark: "rgba(232,176,75,.20)" },
  { id: "rose",    label: "Роза",      light: "rgba(224,90,110,.20)",   dark: "rgba(242,104,124,.20)" },
  { id: "violet",  label: "Фиалка",    light: "rgba(139,107,177,.22)",  dark: "rgba(160,130,200,.22)" },
  { id: "sky",     label: "Небо",      light: "rgba(70,140,200,.20)",   dark: "rgba(90,165,225,.20)" },
  { id: "emerald", label: "Изумруд",   light: "rgba(60,150,110,.20)",   dark: "rgba(75,180,130,.20)" },
  { id: "orange",  label: "Апельсин",  light: "rgba(232,115,74,.22)",   dark: "rgba(240,135,95,.20)" },
  { id: "slate",   label: "Графит",    light: "rgba(100,116,139,.20)",  dark: "rgba(140,155,180,.18)" },
  { id: "teal",    label: "Бирюза",    light: "rgba(45,160,155,.20)",   dark: "rgba(70,190,185,.20)" },
  { id: "crimson", label: "Багрянец",  light: "rgba(190,50,70,.22)",    dark: "rgba(225,75,95,.20)" },
];

export function taskColorFill(colorId, theme) {
  const c = TASK_COLORS.find((x) => x.id === colorId);
  if (!c || c.id === "none") return null;
  return theme.dark ? c.dark : c.light;
}

// Телефоны всех участников задачи для групповой конференции.
// Формат callto://n1&n2 — так его понимают корпоративные телефонные
// клиенты, регистрирующие обработчик схемы callto.
// Список имён для подписи: себя показываем как «Вы» и всегда первым —
// так сразу видно, что вызов включает и тебя.
export function conferenceNames(users, currentUserId) {
  const me = users.some((u) => u.id === currentUserId) ? ["Вы"] : [];
  const others = users
    .filter((u) => u.id !== currentUserId)
    .map((u) => u.fullName);
  return [...me, ...others].join(", ");
}

export function conferenceLink(users, excludeUserId) {
  const numbers = users
    .filter((u) => u && !u.deleted && u.phone && u.id !== excludeUserId)
    .map((u) => u.phone.replace(/[^\d+]/g, ""))
    .filter(Boolean);
  const unique = [...new Set(numbers)];
  // Формат клиента телефонии: команда, признак видео и список номеров
  // через запятую в одном параметре.
  return unique.length > 0
    ? `callto://make_conference_call#video=1#number=${unique.join(",")}`
    : null;
}

// Одиночный видеовызов. Схема та же, но команда другая — клиент
// различает вызов и конференцию именно по ней, а не по числу номеров.
export function videoCallLink(user) {
  if (!user || user.deleted || !user.phone) return null;
  const number = user.phone.replace(/[^\d+]/g, "");
  return number ? `callto://make_call#video=1#number=${number}` : null;
}

// Письмо с заготовленной темой и текстом. mailto требует процентного
// кодирования: без него перенос строки и кавычки в теме ломают ссылку.
export function taskMailLink(users, taskTitle, excludeUserId) {
  const addresses = users
    .filter((u) => u && !u.deleted && u.email && u.id !== excludeUserId)
    .map((u) => u.email);
  const unique = [...new Set(addresses)];
  if (unique.length === 0) return null;

  const subject = `Вопрос по задаче "${taskTitle}"`;
  const body =
    `Уважаемые коллеги!\n\nПрошу уточнить состояние задачи "${taskTitle}".`;
  return `mailto:${unique.join(",")}?subject=${encodeURIComponent(subject)}` +
         `&body=${encodeURIComponent(body)}`;
}

export const ROLE_LABEL = { owner: "Владелец", editor: "Редактор", reader: "Читатель" };
export const GRANT_LABEL = { read: "Только просмотр", contribute: "Участие" };

export const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" }) : "—";

export const fmtDateTime = (iso) =>
  iso ? new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

export function fmtRelative(iso) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "только что";
  if (diff < 3600) return `${Math.floor(diff / 60)} мин назад`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} ч назад`;
  if (diff < 604800) return `${Math.floor(diff / 86400)} дн назад`;
  return fmtDate(iso);
}

export function fmtSize(bytes) {
  if (!bytes) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export const isOverdue = (dueDate, completed) =>
  Boolean(dueDate) && !completed && new Date(dueDate) < new Date(new Date().toDateString());

export function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

export const DELETED_USER = {
  fullName: "Пользователь удалён", position: "", phone: "", avatarColor: "#8E8E8E", deleted: true,
};

export const resolveUser = (directory, id) =>
  directory.find((u) => u.id === id) || { ...DELETED_USER, id };

export const initials = (name) =>
  (name || "?").split(" ").filter(Boolean).slice(0, 2).map((n) => n[0]).join("").toUpperCase();

// Ссылка на письмо с заполненными темой и текстом.
//
// Разделители по RFC 6068: первый параметр отделяется «?», последующие
// «&». Значения обязаны быть закодированы — иначе пробелы, кавычки и
// перевод строки оборвут ссылку на первом же символе.
export function mailtoLink(addresses, taskTitle) {
  const list = (Array.isArray(addresses) ? addresses : [addresses])
    .filter(Boolean);
  if (list.length === 0) return null;

  const subject = `Вопрос по задаче "${taskTitle}"`;
  const body =
    `Уважаемые коллеги!\n\n` +
    `Прошу уточнить состояние задачи "${taskTitle}".`;

  return `mailto:${list.join(",")}` +
    `?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`;
}

// Адреса всех участников задачи, кроме себя: письмо самому себе в
// массовой рассылке не нужно.
export function taskMailRecipients(users, currentUserId) {
  return users
    .filter((u) => u && !u.deleted && u.email && u.id !== currentUserId)
    .map((u) => u.email);
}
