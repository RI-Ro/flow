import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  LayoutGrid, Search, Filter, Bell, Plus, ChevronDown, Palette, Settings, Eye, EyeOff,
  Inbox, UserPlus, LogOut, Check, Link2, ShieldCheck, FileSpreadsheet, UserCheck, Volume2, VolumeX, Zap,
} from "lucide-react";

import { api, hasSession, onAuthLost } from "./lib/api.js";
import { realtimeConnect, realtimeDisconnect, onRealtimeMessage, onRealtimeStatus } from "./lib/realtime.js";
import { playEventSound, primeAudio, loadSoundSettings, saveSoundSettings, SOUND_EVENT_LABELS } from "./lib/sound.js";
import { exportTasksToExcel } from "./lib/excel.js";
import { THEMES, THEME_ORDER, ALL_BACKGROUNDS, bgById, PRIORITIES, ROLE_LABEL, isOverdue, resolveUser, bgImageUrl, fmtDate } from "./lib/theme.js";
import { Avatar, Chip, ConfirmDialog, Field, Modal, ModalHeader, Toggle, Toast, Spinner, UserCard, RealtimeDot, inputStyle } from "./lib/ui.jsx";

import Login from "./components/Login.jsx";
import { BoardView, InboxView } from "./components/Board.jsx";
import TaskModal from "./components/TaskModal.jsx";
import TaskDetail from "./components/TaskDetail.jsx";
import BoardSettings from "./components/BoardSettings.jsx";
import Team from "./components/Team.jsx";
import Notifications from "./components/Notifications.jsx";
import Admin from "./components/Admin.jsx";
import Delegation from "./components/Delegation.jsx";
import Dashboard from "./components/Dashboard.jsx";
import Calendar from "./components/Calendar.jsx";
import Templates from "./components/Templates.jsx";
import ProjectTree from "./components/ProjectTree.jsx";
import ColumnView from "./components/ColumnView.jsx";

const INBOX = "inbox";
const DASHBOARD = "dashboard";
const CALENDAR = "calendar";
const THEME_KEY = "kanban.theme";
const HIDE_DONE_KEY = "kanban.hideCompleted";
const FILTERS_KEY = "kanban.filters";
const SORT_KEY = "kanban.boardSort";

function readRoute() {
  const match = window.location.pathname.match(/^\/b\/([0-9a-f-]{36})/i);
  if (match) return { view: "board", boardId: match[1] };
  if (window.location.pathname.startsWith("/inbox")) return { view: INBOX, boardId: null };
  if (window.location.pathname.startsWith("/dashboard")) return { view: DASHBOARD, boardId: null };
  if (window.location.pathname.startsWith("/calendar")) return { view: CALENDAR, boardId: null };
  return { view: "none", boardId: null };
}

function pushRoute(route, replace = false) {
  const path = route.view === INBOX ? "/inbox"
    : route.view === DASHBOARD ? "/dashboard"
    : route.view === CALENDAR ? "/calendar"
    : route.view === "board" ? `/b/${route.boardId}` : "/";
  if (window.location.pathname === path) return;
  window.history[replace ? "replaceState" : "pushState"]({}, "", path);
}

export default function App() {
  const [themeId, setThemeId] = useState(() => localStorage.getItem(THEME_KEY) || "balun");
  const theme = THEMES[themeId] || THEMES.balun;

  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);

  const [directory, setDirectory] = useState([]);
  const [team, setTeam] = useState([]);
  const [boards, setBoards] = useState([]);

  const [route, setRoute] = useState(readRoute);
  const [board, setBoard] = useState(null);
  const [columns, setColumns] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [loadingBoard, setLoadingBoard] = useState(false);

  const [search, setSearch] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Фильтры переживают перезагрузку: человек настроил вид доски под
  // себя, и терять эту настройку при каждом обновлении страницы
  // раздражает. Set в JSON не сериализуется — храним массивами.
  const [filters, setFilters] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(FILTERS_KEY) || "{}");
      return {
        priority: new Set(saved.priority || []),
        assignee: new Set(saved.assignee || []),
        tag: new Set(saved.tag || []),
        overdue: Boolean(saved.overdue),
        // Диапазон срока исполнения: пустые поля означают «без
        // ограничения», а не «сегодня» — иначе после первого открытия
        // фильтр молча спрятал бы часть задач.
        dueFrom: saved.dueFrom || "",
        dueTo: saved.dueTo || "",
      };
    } catch {
      return { priority: new Set(), assignee: new Set(), tag: new Set(),
               overdue: false, dueFrom: "", dueTo: "" };
    }
  });

  // Порядок сортировки внутри проекта. Хранится отдельно от фильтров:
  // это настройка вида, а не отбора, и сбрасывать её вместе с фильтрами
  // было бы неожиданно.
  const [boardSort, setBoardSort] = useState(() => localStorage.getItem(SORT_KEY) || "position");
  useEffect(() => { localStorage.setItem(SORT_KEY, boardSort); }, [boardSort]);

  useEffect(() => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({
      priority: [...filters.priority],
      assignee: [...filters.assignee],
      tag: [...filters.tag],
      overdue: filters.overdue,
      dueFrom: filters.dueFrom,
      dueTo: filters.dueTo,
    }));
  }, [filters]);
  const [hideCompleted, setHideCompleted] = useState(() => localStorage.getItem(HIDE_DONE_KEY) === "true");

  const [menu, setMenu] = useState(null);
  const [unread, setUnread] = useState(0);
  const [wsStatus, setWsStatus] = useState("disconnected");
  const [toast, setToast] = useState(null);

  const [taskModal, setTaskModal] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newBoardOpen, setNewBoardOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [delegationOpen, setDelegationOpen] = useState(false);
  const [soundOpen, setSoundOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [openColumn, setOpenColumn] = useState(null);
  // Задача для подробного вида, догруженная отдельно: в дашборде и
  // календаре список задач доски не загружен, и без этого нажатие на
  // задачу не открывало ничего.
  const [fetchedTask, setFetchedTask] = useState(null);
  // Действующие замещения по всем сотрудникам — для карточки человека.
  const [activeDelegations, setActiveDelegations] = useState([]);
  // Настройки звука держим в состоянии, а не читаем из localStorage на
  // каждое событие: обработчики срабатывают часто, а чтение и разбор
  // JSON на каждый чужой комментарий — лишняя работа.
  const [sound, setSound] = useState(loadSoundSettings);

  // Подсветка изменившихся карточек: id → { color }. Гаснет сама через
  // несколько секунд, а также при открытии задачи — если человек уже
  // посмотрел, помечать её как «новую» незачем.
  const [highlights, setHighlights] = useState({});
  const highlightTimers = React.useRef({});

  // Ссылка на flashTask: upsertTask объявлена выше по файлу и не может
  // сослаться на неё напрямую, а менять порядок объявлений ради этого
  // значило бы тянуть за собой половину компонента.
  const flashTaskRef = React.useRef(null);

  const flashTask = useCallback((taskId, color) => {
    setHighlights((prev) => ({ ...prev, [taskId]: { color } }));
    clearTimeout(highlightTimers.current[taskId]);
    highlightTimers.current[taskId] = setTimeout(() => {
      setHighlights((prev) => {
        const next = { ...prev };
        delete next[taskId];
        return next;
      });
      delete highlightTimers.current[taskId];
    }, 6000);
  }, []);

  useEffect(() => { flashTaskRef.current = flashTask; }, [flashTask]);

  // Таймеры переживают размонтирование, если их не убрать: обновление
  // состояния после ухода со страницы бессмысленно и шумит в консоли.
  useEffect(() => () => {
    Object.values(highlightTimers.current).forEach(clearTimeout);
  }, []);

  // Недавно изменившиеся задачи. Подсветка спокойная — тонкая полоса
  // слева у карточки, гаснущая сама. Мигание на доске из полусотни
  // карточек превращается в гирлянду, и его начинают игнорировать
  // вместе с важными событиями.
  const [recent, setRecent] = useState({});   // taskId -> тип изменения

  // Каждая отметка живёт 12 секунд: этого хватает, чтобы заметить
  // изменение, вернувшись к экрану, но не настолько долго, чтобы к
  // концу дня подсвеченной оказалась вся доска.
  const markRecent = useCallback((taskId, kind) => {
    if (!taskId) return;
    setRecent((prev) => ({ ...prev, [taskId]: kind }));
    setTimeout(() => {
      setRecent((prev) => {
        if (prev[taskId] !== kind) return prev;   // успело смениться на другое
        const next = { ...prev };
        delete next[taskId];
        return next;
      });
    }, 12000);
  }, []);

  useEffect(() => { saveSoundSettings(sound); }, [sound]);

  // Разблокировать звук на первом жесте: события приходят по сети, а
  // не из клика, и без этого браузер держит аудио выключенным.
  useEffect(() => { primeAudio(); }, []);
  const [userCard, setUserCard] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [bgStamp, setBgStamp] = useState(Date.now());

  const showError = useCallback((message) => setToast({ message, kind: "error" }), []);
  const showInfo = useCallback((message) => setToast({ message, kind: "ok" }), []);

  /* ------------------------------------------------------------ сессия */

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!hasSession()) { setBooting(false); return; }
      try {
        const restored = await api.restore();
        if (alive) setUser(restored);
      } catch {
        // сессия истекла — покажем экран входа
      } finally {
        if (alive) setBooting(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => onAuthLost(() => setUser(null)), []);
  useEffect(() => { localStorage.setItem(THEME_KEY, themeId); }, [themeId]);
  useEffect(() => { localStorage.setItem(HIDE_DONE_KEY, String(hideCompleted)); }, [hideCompleted]);

  useEffect(() => {
    const onPop = () => setRoute(readRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // WebSocket живёт весь сеанс, пока пользователь вошёл — не привязан
  // к конкретной открытой доске, потому что уведомления и события
  // «Входящих» нужны независимо от того, какой проект сейчас открыт.
  useEffect(() => {
    if (!user) { realtimeDisconnect(); return; }
    realtimeConnect();
    return () => realtimeDisconnect();
  }, [user]);

  useEffect(() => onRealtimeStatus(setWsStatus), []);

  /* ------------------------------------------------- справочники и доски */

  const reloadBoards = useCallback(async () => {
    const list = await api.boards();
    setBoards(list);
    return list;
  }, []);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    (async () => {
      try {
        const [dir, teamIds, boardList] = await Promise.all([api.directory(), api.team(), api.boards()]);
        if (!alive) return;
        setDirectory(dir);
        setTeam(teamIds);
        setBoards(boardList);

        const current = readRoute();
        if (current.view === "board" && boardList.some((b) => b.id === current.boardId)) {
          setRoute(current);
        } else if (current.view === INBOX) {
          setRoute(current);
        } else if (boardList.length > 0) {
          const next = { view: "board", boardId: boardList[0].id };
          setRoute(next);
          pushRoute(next, true);
        } else {
          setRoute({ view: INBOX, boardId: null });
          pushRoute({ view: INBOX }, true);
        }
      } catch (e) {
        showError(e.message);
      }
    })();
    return () => { alive = false; };
  }, [user, showError]);

  // Счётчик непрочитанных подгружается один раз при входе, дальше живёт
  // от WebSocket-событий — это то самое «в фоне», не только при открытии
  // колокольчика.
  useEffect(() => {
    if (!user) return;
    api.notifications({ limit: 1, includeRead: false }).then((d) => setUnread(d.unread)).catch(() => {});
    api.activeDelegations().then(setActiveDelegations).catch(() => {});
  }, [user]);

  /* ------------------------------------------------ загрузка содержимого */

  const loadBoardData = useCallback(async () => {
    if (!user) return;

    if (route.view === INBOX) {
      setLoadingBoard(true);
      try {
        const list = await api.inbox();
        setBoard(null);
        setColumns([]);
        setTasks(list);
      } catch (e) {
        showError(e.message);
      } finally {
        setLoadingBoard(false);
      }
      return;
    }
    if (route.view === DASHBOARD || route.view === CALENDAR) {
      // Сводка грузит данные сама: ей нужны агрегаты по всем проектам,
      // а не задачи одной доски.
      setBoard(null);
      setColumns([]);
      setTasks([]);
      setLoadingBoard(false);
      return;
    }
    if (route.view !== "board" || !route.boardId) return;

    setLoadingBoard(true);
    try {
      const [b, cols, list] = await Promise.all([api.board(route.boardId), api.columns(route.boardId), api.tasks(route.boardId)]);
      setBoard(b);
      setColumns(cols);
      setTasks(list);
    } catch (e) {
      if (e.status === 404 || e.status === 403) {
        showError("Проект недоступен или удалён");
        const list = await reloadBoards();
        const next = list.length ? { view: "board", boardId: list[0].id } : { view: INBOX, boardId: null };
        setRoute(next);
        pushRoute(next, true);
      } else {
        showError(e.message);
      }
    } finally {
      setLoadingBoard(false);
    }
  }, [user, route, showError, reloadBoards]);

  useEffect(() => { loadBoardData(); }, [loadBoardData]);

  const goto = (next) => { setRoute(next); pushRoute(next); setMenu(null); };

  /* --------------------------------------------- события реального времени
     Единая точка входа: любое изменение — своё или чужое — приходит сюда
     и патчит уже загруженное состояние точечно, без похода за всем
     проектом заново. Именно это убирает дёргание экрана при каждом
     комментарии или отметке чек-листа и держит все открытые у всех
     участников вкладки в одном состоянии. */

  // task.access — уровень доступа для конкретного зрителя (edit / contribute
  // / read), а не свойство самой задачи. Сервер вычисляет его на основе
  // того, кто прислал REST-запрос, вызвавший рассылку, — то есть в событии
  // приходит access ОТПРАВИТЕЛЯ действия, не получателя. Если довериться
  // этому полю напрямую, читатель после чужого редактирования увидит в
  // своём интерфейсе чужой уровень доступа (например, кнопки правки,
  // которые при нажатии получат 403 от RLS). Поэтому для уже известных
  // задач access сохраняется локальным, а для по-настоящему новых —
  // выясняется отдельным запросом от своего имени.
  // Что именно изменилось в задаче — по сравнению с тем, что мы о ней
  // знали. Возвращает цвет подсветки или null.
  //
  // Сравнение вынесено сюда, а не привязано к типам WebSocket-событий:
  // так подсветка одинаково работает и для чужих изменений, пришедших
  // по сети, и для своих, применённых прямо из карточки. Раньше она
  // зависела только от событий, и любое изменение, применённое
  // локально, проходило незамеченным.
  const changeColor = useCallback((prev, next) => {
    if (!prev) return null;
    if (Boolean(prev.completedAt) !== Boolean(next.completedAt)) return theme.success;
    if ((prev.assigneesDone || []).length !== (next.assigneesDone || []).length) return theme.success;
    if (prev.commentCount !== next.commentCount) return theme.accent2;
    if (prev.attachmentCount !== next.attachmentCount) return theme.accent2;
    if (prev.columnId !== next.columnId) return theme.accent2;
    const steps = (x) => (x.steps || []).filter((s) => s.done).length;
    if (steps(prev) !== steps(next)) return theme.success;
    if (prev.title !== next.title || prev.dueDate !== next.dueDate
        || prev.priority !== next.priority || prev.description !== next.description) {
      return theme.info;
    }
    return null;
  }, [theme]);

  const upsertTask = useCallback((t) => {
    // Догруженная карточка (дашборд, календарь) живёт вне списка задач
    // доски — её надо обновлять отдельно, иначе правки в открытом окне
    // не видны до его закрытия.
    setFetchedTask((prev) => (prev && prev.id === t.id ? { ...t, access: prev.access } : prev));
    setTasks((prev) => {
      const i = prev.findIndex((x) => x.id === t.id);
      if (i === -1) {
        if (route.view === "board" && t.boardId !== route.boardId) return prev;
        return [...prev, t];
      }
      const colour = changeColor(prev[i], t);
      if (colour) flashTaskRef.current?.(t.id, colour);
      const next = [...prev];
      next[i] = { ...t, access: prev[i].access };
      return next;
    });
  }, [route, changeColor]);


  // Вызывается только для задач, которых раньше не было в локальном
  // состоянии вообще (см. обработчик события "task" ниже) — там
  // подставить старый access неоткуда, поэтому переспрашиваем сервер
  // от имени текущей сессии.
  const fetchOwnTaskView = useCallback(async (taskId) => {
    try {
      const t = await api.task(taskId);
      setTasks((prev) => (prev.some((x) => x.id === t.id) ? prev : [...prev, t]));
    } catch {
      // Задача уже могла стать недоступной или удалиться — не страшно,
      // просто не появится в списке.
    }
  }, []);

  // Актуальный список задач в ref: обработчик события ниже должен знать,
  // видели ли мы уже эту задачу, но включать `tasks` в зависимости самого
  // useEffect означало бы пересоздавать подписку на каждое изменение
  // хотя бы одной задачи — а меняются они как раз событиями из этой же
  // подписки.
  const tasksRef = React.useRef(tasks);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);

  useEffect(() => {
    if (!user) return;

    const offTask = onRealtimeMessage("task", (e) => {
      if (e.action === "deleted") {
        setTasks((prev) => prev.filter((t) => t.id !== e.payload.id));
        if (detailId === e.payload.id) setDetailId(null);
        return;
      }
      // Звук зависит от того, что именно произошло: появление новой
      // задачи, её переезд между колонками и закрытие — три разных
      // события, и различать их на слух полезнее, чем слышать один
      // и тот же сигнал на любое изменение.
      const known = tasksRef.current.find((t) => t.id === e.payload.id);
      if (e.action === "created" && !known) {
        playEventSound("taskCreated", sound);
        flashTask(e.payload.id, theme.accent);
      } else if (e.action === "moved") {
        playEventSound("taskMoved", sound);
        flashTask(e.payload.id, theme.accent2);
      } else if (known && !known.completedAt && e.payload.completedAt) {
        playEventSound("taskDone", sound);
        flashTask(e.payload.id, theme.success);
      } else if (known && (known.assigneesDone || []).length <
                 (e.payload.assigneesDone || []).length) {
        // Исполнитель сдал свою часть — то же по смыслу «готово».
        playEventSound("taskDone", sound);
        flashTask(e.payload.id, theme.success);
      } else if (known) {
        // Прочие правки: смена срока, приоритета, описания.
        flashTask(e.payload.id, theme.info);
      }

      const isNew = !tasksRef.current.some((t) => t.id === e.payload.id);
      const belongsHere = route.view === INBOX || e.payload.boardId === route.boardId;
      // Во «Входящих» карточки сгруппированы по названию проекта. Если
      // в событии его нет, задача попала бы в группу «Без проекта» и
      // оставалась там до перезагрузки — в таком случае запрашиваем
      // задачу целиком от своего имени.
      if (route.view === INBOX && !e.payload.boardTitle) {
        fetchOwnTaskView(e.payload.id);
        return;
      }
      if (isNew && belongsHere) {
        fetchOwnTaskView(e.payload.id);
      } else {
        upsertTask(e.payload);
      }
    });

    const offStep = onRealtimeMessage("step", (e) => {
      const { taskId, step } = e.payload;
      setTasks((prev) => prev.map((t) => {
        if (t.id !== taskId) return t;
        if (e.action === "deleted") return { ...t, steps: t.steps.filter((s) => s.id !== step.id) };
        const i = t.steps.findIndex((s) => s.id === step.id);
        const steps = i === -1 ? [...t.steps, step] : t.steps.map((s) => (s.id === step.id ? step : s));
        return { ...t, steps };
      }));
    });

    const offComment = onRealtimeMessage("comment", (e) => {
      const taskId = e.payload.taskId;
      // Только на чужие: звук на собственное сообщение бессмыслен.
      if (e.action === "created" && e.payload.authorId !== user.id) {
        playEventSound("comment", sound);
        // Цвет отличается от правки самой задачи: обсуждение и
        // изменение условий — разные поводы вернуться к карточке.
        flashTask(taskId, theme.accent2);
      }
      setTasks((prev) => prev.map((t) => {
        if (t.id !== taskId) return t;
        if (e.action === "created") return { ...t, commentCount: t.commentCount + 1 };
        if (e.action === "deleted") return { ...t, commentCount: Math.max(0, t.commentCount - 1) };
        return t;
      }));
    });

    const offAttachment = onRealtimeMessage("attachment", (e) => {
      const taskId = e.payload.taskId;
      if (e.action === "created" && e.payload.authorId !== user.id) {
        flashTask(taskId, theme.accent2);
      }
      setTasks((prev) => prev.map((t) => {
        if (t.id !== taskId) return t;
        if (e.action === "created") return { ...t, attachmentCount: t.attachmentCount + 1 };
        if (e.action === "deleted") return { ...t, attachmentCount: Math.max(0, t.attachmentCount - 1) };
        return t;
      }));
    });

    const offColumns = onRealtimeMessage("columns", (e) => {
      if (route.view === "board" && e.payload.boardId === route.boardId) setColumns(e.payload.columns);
    });

    const offBoard = onRealtimeMessage("board", (e) => {
      if (e.action === "deleted") {
        setBoards((prev) => prev.filter((b) => b.id !== e.payload.id));
        if (route.view === "board" && route.boardId === e.payload.id) {
          showError("Проект удалён владельцем");
          goto({ view: INBOX, boardId: null });
        }
        return;
      }
      if (e.action === "member_added") {
        reloadBoards();
        return;
      }
      reloadBoards();
      if (route.view === "board" && route.boardId === e.payload.id) {
        // myRole в payload вычислен на сервере для того пользователя, чьё
        // действие вызвало рассылку, а не для текущего получателя — так
        // читатель, увидевший чужое редактирование, не должен получить
        // в интерфейсе чужую роль «владелец». Берём из события только
        // содержимое доски, а роль оставляем ту, что знаем по себе.
        setBoard((prev) => (prev ? { ...e.payload, myRole: prev.myRole } : e.payload));
        setBgStamp(Date.now());
      }
    });

    // Новое уведомление обновляет бейдж и проигрывает звук независимо от
    // того, открыта ли панель — раньше это происходило только при клике
    // на колокольчик, когда список подгружался заново.
    // Отзыв доступа к проекту. Событие адресное — приходит только тому,
    // кого сняли. Обрабатывать обязательно: RLS не даст ему изменить
    // данные, но без этого обработчика интерфейс продолжал бы показывать
    // чужой проект со всем содержимым до перезагрузки страницы, а любое
    // действие молча упиралось бы в отказ сервера.
    const offAccess = onRealtimeMessage("access", (e) => {
      // Отозвали точечный доступ к одной задаче: сам проект человеку
      // и так не принадлежит, закрывать нужно только эту карточку.
      if (e.action === "task_revoked") {
        const lostTaskId = e.payload.taskId;
        setTasks((prev) => prev.filter((t) => t.id !== lostTaskId));
        if (detailId === lostTaskId) setDetailId(null);
        setTaskModal((m) => (m?.task?.id === lostTaskId ? null : m));
        showError(e.payload.reason || "Доступ к задаче отозван");
        return;
      }

      if (e.action !== "revoked") return;
      const lostBoardId = e.payload.boardId;

      // Убираем проект из списка и выбрасываем его задачи из памяти —
      // иначе они остались бы видны в текущем представлении.
      setBoards((prev) => prev.filter((b) => b.id !== lostBoardId));
      setTasks((prev) => prev.filter((t) => t.boardId !== lostBoardId));

      const lookingAtIt = route.view === "board" && route.boardId === lostBoardId;
      const detailFromIt = detailId && tasksRef.current.some(
        (t) => t.id === detailId && t.boardId === lostBoardId
      );

      if (lookingAtIt || detailFromIt) {
        // Закрываем всё, что могло остаться открытым поверх проекта:
        // карточку задачи, форму, настройки. Иначе пользователь остался
        // бы в модальном окне задачи, к которой уже нет доступа.
        setDetailId(null);
        setTaskModal(null);
        setSettingsOpen(false);
        setConfirm(null);
      }

      if (lookingAtIt) {
        setBoard(null);
        setColumns([]);
        goto({ view: INBOX, boardId: null });
      }

      showError(e.payload.reason || "Доступ к проекту закрыт");
    });

    const offNotif = onRealtimeMessage("notification", () => {
      setUnread((n) => n + 1);
      playEventSound("notification", sound);
    });

    return () => { offTask(); offStep(); offComment(); offAttachment(); offColumns(); offBoard(); offAccess(); offNotif(); };
  }, [user, route, detailId, upsertTask, fetchOwnTaskView, reloadBoards, showError, sound, flashTask, theme]);

  /* ---------------------------------------------------------- фильтрация */

  const allTags = useMemo(() => [...new Set(tasks.flatMap((t) => t.tags || []))].sort(), [tasks]);

  const visibleTasks = useMemo(() => tasks.filter((t) => {
    const q = search.trim().toLowerCase();
    if (q && !(`${t.title} ${t.description}`.toLowerCase().includes(q))) return false;
    if (filters.priority.size && !filters.priority.has(t.priority)) return false;
    if (filters.assignee.size && !t.assignees.some((a) => filters.assignee.has(a))) return false;
    if (filters.tag.size && !(t.tags || []).some((tag) => filters.tag.has(tag))) return false;
    if (filters.overdue && !isOverdue(t.dueDate, Boolean(t.completedAt))) return false;
    if (filters.dueFrom && (!t.dueDate || t.dueDate < filters.dueFrom)) return false;
    if (filters.dueTo && (!t.dueDate || t.dueDate > filters.dueTo)) return false;
    return true;
  }), [tasks, search, filters]);

  // Отсортированный список отдаётся доске: сама доска раскладывает
  // задачи по колонкам, но порядок внутри колонки задаётся здесь —
  // чтобы он был общим и для доски, и для разворота колонки.
  const sortedTasks = useMemo(() => {
    const list = [...visibleTasks];
    switch (boardSort) {
      case "due":
        return list.sort((a, b) => {
          if (!a.dueDate && !b.dueDate) return 0;
          if (!a.dueDate) return 1;   // без срока — в конец
          if (!b.dueDate) return -1;
          return a.dueDate.localeCompare(b.dueDate);
        });
      case "created":
        return list.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      case "priority":
        return list.sort((a, b) =>
          (PRIORITIES[b.priority]?.order || 0) - (PRIORITIES[a.priority]?.order || 0));
      case "title":
        return list.sort((a, b) => a.title.localeCompare(b.title, "ru"));
      default:
        return list.sort((a, b) => a.position - b.position);
    }
  }, [visibleTasks, boardSort]);

  const activeSortLabel = {
    position: "как на доске", due: "по сроку",
    created: "по дате", priority: "по приоритету", title: "по названию",
  }[boardSort];

  const toggleFilter = (kind, value) => setFilters((f) => {
    const next = new Set(f[kind]);
    next.has(value) ? next.delete(value) : next.add(value);
    return { ...f, [kind]: next };
  });

  const activeFilters = filters.priority.size + filters.assignee.size + filters.tag.size
    + (filters.overdue ? 1 : 0) + (filters.dueFrom ? 1 : 0) + (filters.dueTo ? 1 : 0);

  /* ------------------------------------------------- операции с задачами */

  const myRole = board?.myRole || "";
  const canEdit = ["owner", "editor"].includes(myRole);
  const canManage = myRole === "owner";
  const isInbox = route.view === INBOX;

  // Перетаскивание отрисовывается сразу (оптимистично), а окончательное
  // состояние — и своё, и соседей по колонке — приходит events'ом "task"
  // следом за REST-ответом: бэкенд рассылает всех, чья позиция сдвинулась
  // при уплотнении нумерации, не только перетащенную карточку.
  const moveTask = async (taskId, columnId, position) => {
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, columnId, position } : t)));
    try {
      await api.moveTask(taskId, columnId, position);
    } catch (e) {
      showError(e.message);
      loadBoardData();
    }
  };

  const saveTask = async (form) => {
    try {
      const payload = {
        title: form.title, description: form.description, priority: form.priority,
        // color обязателен в списке: форма его выставляла, но сюда он не
        // попадал — выбор цвета молча терялся при сохранении.
        color: form.color || "none",
        // Реквизиты документа передавались в форму, но не отправлялись
        // обратно — правка входящего номера молча терялась.
        incomingNumber: form.incomingNumber || "",
        incomingDate: form.incomingDate || null,
        columnId: form.columnId, dueDate: form.dueDate || null, tags: form.tags, assignees: form.assignees,
      };
      const saved = form.id ? await api.updateTask(form.id, payload) : await api.createTask(route.boardId, payload);
      upsertTask(saved);
      setTaskModal(null);
    } catch (e) {
      showError(e.message);
    }
  };

  const requestDeleteTask = (taskId) => {
    const t = tasks.find((x) => x.id === taskId);
    setConfirm({
      title: "Удалить задачу?",
      message: `Задача «${t?.title}» будет удалена вместе с комментариями, файлами и историей. Отменить это действие нельзя.`,
      confirmLabel: "Удалить задачу",
      onConfirm: async () => {
        setConfirm(null);
        setTaskModal(null);
        setDetailId(null);
        try {
          await api.deleteTask(taskId);
          setTasks((prev) => prev.filter((x) => x.id !== taskId));
        } catch (e) {
          showError(e.message);
        }
      },
    });
  };

  const requestDeleteBoard = () => {
    setConfirm({
      title: "Удалить проект?",
      message: `Проект «${board.title}» будет удалён вместе с колонками, задачами, файлами и историей. Участники потеряют доступ. Действие необратимо.`,
      confirmLabel: "Удалить проект",
      onConfirm: async () => {
        setConfirm(null);
        setSettingsOpen(false);
        try {
          await api.deleteBoard(board.id);
          const list = await reloadBoards();
          const next = list.length ? { view: "board", boardId: list[0].id } : { view: INBOX, boardId: null };
          setRoute(next);
          pushRoute(next, true);
        } catch (e) {
          showError(e.message);
        }
      },
    });
  };

  // Перетаскивание проекта: и вложение, и порядок внутри уровня.
  // parentId передаётся всегда, в том числе null — на сервере это
  // различается двойным указателем и означает «вынести в корень».
  const moveBoard = async (boardId, target) => {
    try {
      await api.updateBoard(boardId, {
        parentId: target.parentId ?? null,
        ...(target.position !== undefined ? { position: target.position } : {}),
      });
      await reloadBoards();
    } catch (e) {
      showError(e.message);
    }
  };

  const createBoard = async (payload) => {
    try {
      const { id } = await api.createBoard(payload);
      await reloadBoards();
      setNewBoardOpen(false);
      goto({ view: "board", boardId: id });
    } catch (e) {
      showError(e.message);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      showInfo("Ссылка на проект скопирована");
    } catch {
      showError("Не удалось скопировать ссылку");
    }
  };

  // Открыл — значит увидел: держать подсветку дальше незачем.
  useEffect(() => {
    if (!detailId) return;
    setHighlights((prev) => {
      if (!prev[detailId]) return prev;
      const next = { ...prev };
      delete next[detailId];
      return next;
    });
  }, [detailId]);

  useEffect(() => {
    if (!detailId) { setFetchedTask(null); return; }
    if (tasksRef.current.some((t) => t.id === detailId)) return;
    let alive = true;
    api.task(detailId)
      .then((t) => alive && setFetchedTask(t))
      .catch((e) => { showError(e.message); setDetailId(null); });
    return () => { alive = false; };
  }, [detailId, showError]);

  const detailTask = tasks.find((t) => t.id === detailId)
    || (fetchedTask?.id === detailId ? fetchedTask : null);

  /* ------------------------------------------------------------- рендер */

  if (booting) {
    return <div style={{ background: theme.bg, minHeight: "100vh" }} className="flex items-center justify-center"><Spinner theme={theme} label="Загружаем…" /></div>;
  }
  if (!user) {
    return <Login theme={theme} onSuccess={setUser} />;
  }

  const preset = bgById(board?.bgPreset);
  const isCustom = board?.bgPreset === "custom" && board?.bgFileId;
  // Готовые изображения лежат в статике сервера и одинаковы у всех —
  // в отличие от «custom», который загружает каждый владелец сам.
  const readyImage = bgImageUrl(board?.bgPreset);
  const bgImage = isCustom
    ? `url(${api.backgroundUrl(board.id, bgStamp)})`
    : readyImage
    ? `url(${readyImage})`
    : preset?.css || null;
  // Узорные фоны мостятся плиткой: растянуть плитку на весь экран
  // означало бы показать один её гигантский фрагмент. Градиенты и
  // загруженные фотографии, наоборот, должны заполнять область целиком.
  const bgSize = isCustom || readyImage ? "cover" : preset?.size || "cover";

  return (
    <div style={{ background: theme.bg, minHeight: "100vh" }} className="flex flex-col">
      <header style={{ borderColor: theme.border, background: theme.surface }} className="border-b px-4 py-2.5 flex items-center gap-2.5 flex-wrap relative z-40">
        <div style={{ color: theme.text, fontFamily: "Manrope, sans-serif" }} className="flex items-center gap-1.5 font-bold text-[15px]">
          <LayoutGrid size={18} style={{ color: theme.accent }} />
          Команда
          <span className="mono text-[10px] font-normal ml-0.5 hidden sm:inline"
            style={{ color: theme.textMuted }}>// задачи</span>
        </div>

        <div className="relative">
          <button onClick={() => setMenu(menu === "board" ? null : "board")} style={{ background: theme.surfaceAlt, color: theme.text, border: `1px solid ${theme.border}` }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium max-w-[240px]">
            {isInbox && <Inbox size={14} />}
            <span className="truncate">{route.view === CALENDAR ? "Календарь" : route.view === DASHBOARD ? "Сводка" : isInbox ? "Входящие" : board?.title || "Проект"}</span>
            <ChevronDown size={14} />
          </button>

          {menu === "board" && (
            <div style={{ background: theme.surface, border: `1px solid ${theme.border}` }}
              className="absolute top-full mt-1 left-0 rounded-xl shadow-xl z-30 w-[360px] max-h-[70vh] overflow-y-auto">
              <ProjectTree
                theme={theme} boards={boards} directory={directory}
                activeId={route.boardId}
                isInbox={isInbox} isDashboard={route.view === DASHBOARD}
                isCalendar={route.view === CALENDAR}
                onSelect={(id) => goto({ view: "board", boardId: id })}
                onSelectInbox={() => goto({ view: INBOX, boardId: null })}
                onSelectDashboard={() => goto({ view: DASHBOARD, boardId: null })}
                onSelectCalendar={() => goto({ view: CALENDAR, boardId: null })}
                onCreate={() => { setNewBoardOpen(true); setMenu(null); }}
                onMove={moveBoard}
                canReorder />
              <div style={{ borderColor: theme.border }} className="border-t p-1.5">
                <button onClick={() => { setTeamOpen(true); setMenu(null); }} style={{ color: theme.text }}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[13px]">
                  <UserPlus size={14} /> Моя команда ({team.length})
                </button>
              </div>
            </div>
          )}
        </div>

        {!isInbox && board && (
          <>
            <button onClick={copyLink} style={{ color: theme.textMuted }} className="p-1.5" title="Скопировать ссылку на проект"><Link2 size={16} /></button>
            <button
              onClick={() => {
                // Выгружается отфильтрованный список — то, что человек
                // видит на экране, а не вся доска целиком.
                const n = exportTasksToExcel(sortedTasks, {
                  directory, columns, boardTitle: board?.title,
                });
                showInfo(`Выгружено задач: ${n}`);
              }}
              style={{ color: theme.textMuted }} className="p-1.5"
              title="Выгрузить задачи в Excel (с учётом фильтров)">
              <FileSpreadsheet size={16} />
            </button>
            {canEdit && (
              <button onClick={() => setTemplatesOpen(true)} style={{ color: theme.textMuted }}
                className="p-1.5" title="Шаблоны задач">
                <Zap size={16} />
              </button>
            )}
            {canManage && <button onClick={() => setSettingsOpen(true)} style={{ color: theme.textMuted }} className="p-1.5" title="Настройки проекта"><Settings size={17} /></button>}
            {!canEdit && (
              <span style={{ background: theme.surfaceAlt, color: theme.textMuted }} className="flex items-center gap-1 text-[11.5px] px-2 py-1 rounded-lg">
                <Eye size={12} /> Только чтение
              </span>
            )}
          </>
        )}

        <div className="relative flex-1 min-w-[150px] max-w-xs"
          style={{ visibility: route.view === DASHBOARD ? "hidden" : "visible" }}>
          <Search size={14} style={{ color: theme.textMuted }} className="absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск задач" style={inputStyle(theme)} className="w-full pl-8 pr-2.5 py-1.5 rounded-lg text-[13px] outline-none" />
        </div>

        {/* В сводке и календаре свои фильтры, а этот на состав их
            данных не влияет — показывать его там значит обещать
            действие, которого не произойдёт. */}
        {route.view !== DASHBOARD && route.view !== CALENDAR && (
        <button onClick={() => setFiltersOpen((v) => !v)} style={{ background: activeFilters ? theme.accent : theme.surfaceAlt, color: activeFilters ? theme.accentText : theme.text, border: `1px solid ${theme.border}` }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium">
          <Filter size={13} /> Фильтры{activeFilters > 0 && ` (${activeFilters})`}
        </button>
        )}

        {/* Скрытие завершённых относится к раскладке доски: в сводке и
            календаре оно ни на что не влияет. */}
        {!isInbox && route.view !== DASHBOARD && route.view !== CALENDAR && (
          <button onClick={() => setHideCompleted((v) => !v)} style={{ background: hideCompleted ? theme.accent : theme.surfaceAlt, color: hideCompleted ? theme.accentText : theme.text, border: `1px solid ${theme.border}` }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium" title={hideCompleted ? "Показать завершённые" : "Скрыть завершённые"}>
            {hideCompleted ? <EyeOff size={13} /> : <Eye size={13} />}<span className="hidden sm:inline">Завершённые</span>
          </button>
        )}

        {canEdit && !isInbox && (
          <button onClick={() => setTaskModal({ mode: "create", columnId: columns[0]?.id })}
            style={{ background: theme.accent, color: theme.accentText, "--glow-color": theme.glow }}
            className="glow flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-semibold ml-auto">
            <Plus size={14} /> Новая задача
          </button>
        )}

        <div className={`relative ${canEdit && !isInbox ? "" : "ml-auto"}`}>
          <button onClick={() => setMenu(menu === "notif" ? null : "notif")} style={{ color: theme.textMuted }} className="relative p-1.5" title="Уведомления">
            <Bell size={18} />
            {unread > 0 && (
              <span style={{ background: theme.danger }} className="absolute top-0 right-0 min-w-[16px] h-4 px-1 rounded-full text-white text-[9px] flex items-center justify-center font-bold">
                {unread}
              </span>
            )}
          </button>
          {menu === "notif" && (
            <Notifications theme={theme} onCountChange={setUnread} onOpenTask={(n) => {
              if (n.boardId) goto({ view: "board", boardId: n.boardId });
              setDetailId(n.taskId);
              setMenu(null);
            }} />
          )}
        </div>

        <div className="flex items-center gap-1 px-1" title={wsStatus === "connected" ? "Обновления в реальном времени включены" : "Переподключение к серверу…"}>
          <RealtimeDot theme={theme} status={wsStatus} />
        </div>

        <div className="relative">
          <button onClick={() => setMenu(menu === "theme" ? null : "theme")} style={{ color: theme.textMuted }} className="p-1.5" title="Оформление"><Palette size={18} /></button>
          {menu === "theme" && (
            <div style={{ background: theme.surface, border: `1px solid ${theme.border}` }}
              className="absolute top-full mt-1 right-0 rounded-xl shadow-xl p-1.5 z-30 w-56 max-h-[70vh] overflow-y-auto">
              <div className="mono px-2.5 pt-1 pb-2 text-[10px] uppercase tracking-wider"
                style={{ color: theme.textMuted }}>
                // 5 dark · 5 light
              </div>
              {THEME_ORDER.map((id) => {
                const t = THEMES[id];
                if (!t) return null;
                return (
                  <button key={id} onClick={() => { setThemeId(id); setMenu(null); }}
                    style={{ color: theme.text, background: id === themeId ? theme.surfaceAlt : "transparent" }}
                    className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[12.5px]">
                    {/* Свотч показывает саму тему: фон и оба акцента —
                        по названию «Graphite» или «Frost» угадать
                        палитру невозможно. */}
                    <span style={{ background: t.bg, border: `1px solid ${theme.border}` }}
                      className="w-7 h-5 rounded flex items-center justify-center gap-0.5 shrink-0">
                      <span style={{ background: t.accent }} className="w-1.5 h-2.5 rounded-sm" />
                      <span style={{ background: t.accent2 }} className="w-1.5 h-2.5 rounded-sm" />
                    </span>
                    <span className="flex-1 text-left">{t.name}</span>
                    <span className="mono text-[9.5px] uppercase" style={{ color: theme.textMuted }}>
                      {t.dark ? "dark" : "light"}
                    </span>
                    {id === themeId && <Check size={12} style={{ color: theme.accent }} />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="relative">
          <button onClick={() => setMenu(menu === "user" ? null : "user")}><Avatar user={user} size={28} theme={theme} /></button>
          {menu === "user" && (
            <div style={{ background: theme.surface, border: `1px solid ${theme.border}` }} className="absolute top-full mt-1 right-0 rounded-xl shadow-xl p-1.5 z-30 w-56">
              <div className="px-2.5 py-2">
                <div style={{ color: theme.text }} className="text-[13px] font-semibold truncate">{user.fullName}</div>
                <div style={{ color: theme.textMuted }} className="text-[11.5px] truncate">{user.position || user.email}</div>
              </div>
              <button onClick={() => { setSoundOpen(true); setMenu(null); }} style={{ color: theme.text }}
                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[13px]">
                {sound.enabled
                  ? <Volume2 size={14} style={{ color: theme.accent }} />
                  : <VolumeX size={14} style={{ color: theme.textMuted }} />}
                Звуковые уведомления
              </button>
              <button onClick={() => { setDelegationOpen(true); setMenu(null); }} style={{ color: theme.text }}
                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[13px]">
                <UserCheck size={14} style={{ color: theme.accent }} /> Замещение
              </button>
              {user.role === "admin" && (
                <button onClick={() => { setAdminOpen(true); setMenu(null); }} style={{ color: theme.text }}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[13px]">
                  <ShieldCheck size={14} style={{ color: theme.accent }} /> Пользователи
                </button>
              )}
              <button onClick={async () => { await api.logout(); setUser(null); setMenu(null); }} style={{ color: theme.danger }} className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[13px] font-medium">
                <LogOut size={14} /> Выйти
              </button>
            </div>
          )}
        </div>
      </header>

      {filtersOpen && route.view !== DASHBOARD && route.view !== CALENDAR && (
        <div style={{ borderColor: theme.border, background: theme.surface }} className="border-b px-4 py-3 flex flex-wrap gap-4 relative z-30">
          <FilterGroup theme={theme} label="Приоритет">
            {Object.entries(PRIORITIES).map(([k, v]) => (
              <Chip key={k} theme={theme} active={filters.priority.has(k)} onClick={() => toggleFilter("priority", k)}>{v.label}</Chip>
            ))}
          </FilterGroup>
          <FilterGroup theme={theme} label="Исполнитель">
            {team.map((id) => {
              const u = resolveUser(directory, id);
              return <Chip key={id} theme={theme} active={filters.assignee.has(id)} onClick={() => toggleFilter("assignee", id)}>{u.fullName.split(" ")[0]}</Chip>;
            })}
          </FilterGroup>
          {allTags.length > 0 && (
            <FilterGroup theme={theme} label="Теги">
              {allTags.map((t) => <Chip key={t} theme={theme} active={filters.tag.has(t)} onClick={() => toggleFilter("tag", t)}>#{t}</Chip>)}
            </FilterGroup>
          )}
          <FilterGroup theme={theme} label="Срок исполнения">
            <div className="flex items-center gap-1.5">
              <input type="date" value={filters.dueFrom}
                onChange={(e) => setFilters((f) => ({ ...f, dueFrom: e.target.value }))}
                style={inputStyle(theme)} className="rounded-lg px-2 py-1 text-[11.5px] outline-none"
                title="Срок не раньше" />
              <span style={{ color: theme.textMuted }} className="text-[11px]">—</span>
              <input type="date" value={filters.dueTo}
                onChange={(e) => setFilters((f) => ({ ...f, dueTo: e.target.value }))}
                style={inputStyle(theme)} className="rounded-lg px-2 py-1 text-[11.5px] outline-none"
                title="Срок не позже" />
            </div>
          </FilterGroup>

          <FilterGroup theme={theme} label={`Сортировка · ${activeSortLabel}`}>
            {[["position", "Как на доске"], ["due", "По сроку"], ["priority", "По приоритету"],
              ["created", "По дате"], ["title", "По названию"]].map(([id, label]) => (
              <Chip key={id} theme={theme} active={boardSort === id} onClick={() => setBoardSort(id)}>
                {label}
              </Chip>
            ))}
          </FilterGroup>

          <FilterGroup theme={theme} label="Прочее">
            <Chip theme={theme} active={filters.overdue} onClick={() => setFilters((f) => ({ ...f, overdue: !f.overdue }))}>Только просроченные</Chip>
          </FilterGroup>
          {activeFilters > 0 && (
            <button onClick={() => setFilters({ priority: new Set(), assignee: new Set(), tag: new Set(), overdue: false, dueFrom: "", dueTo: "" })} style={{ color: theme.danger }} className="text-[12px] font-medium self-center">
              Сбросить всё
            </button>
          )}
        </div>
      )}

      <main className="flex-1 relative overflow-hidden">
        {bgImage && (
          <div aria-hidden style={{
            backgroundImage: bgImage, backgroundSize: bgSize, backgroundPosition: "center",
            filter: board?.bgBlur ? "blur(22px)" : "none", transform: board?.bgBlur ? "scale(1.12)" : "none",
            opacity: theme.dark ? 0.42 : 0.6,
          }} className="absolute inset-0 pointer-events-none" />
        )}

        <div className="relative h-full overflow-x-auto p-4">
          {loadingBoard ? (
            <Spinner theme={theme} label="Загружаем данные…" />
          ) : route.view === CALENDAR ? (
            <Calendar theme={theme} directory={directory} boards={boards} currentUser={user}
              onError={showError} onInfo={showInfo} onOpenTask={setDetailId}
              onTaskCreated={upsertTask} />
          ) : route.view === DASHBOARD ? (
            <Dashboard theme={theme} directory={directory} boards={boards} currentUser={user}
              onError={showError} onOpenTask={setDetailId} />
          ) : isInbox ? (
            <InboxView tasks={sortedTasks} theme={theme} directory={directory} onOpenTask={setDetailId}
              highlights={highlights} currentUserId={user.id} onOpenUser={setUserCard} />
          ) : board ? (
            <BoardView columns={columns} tasks={sortedTasks} theme={theme} directory={directory} canEdit={canEdit} canManage={canManage}
              hideCompleted={hideCompleted} onOpenTask={setDetailId} onMove={moveTask}
              onQuickAdd={(columnId) => setTaskModal({ mode: "create", columnId })} onSettings={() => setSettingsOpen(true)}
              onExpandColumn={(col) => setOpenColumn(col)}
              currentUserId={user.id} onOpenUser={setUserCard}
              highlights={highlights}
              onShowCompleted={() => setHideCompleted(false)} />
          ) : (
            <div className="max-w-md mx-auto text-center py-16">
              <LayoutGrid size={30} style={{ color: theme.textMuted }} className="mx-auto mb-3" />
              <h3 style={{ color: theme.text, fontFamily: "Manrope, sans-serif" }} className="font-semibold text-[16px] mb-1.5">Проектов пока нет</h3>
              <p style={{ color: theme.textMuted }} className="text-[13px] mb-4">Создайте первый проект — колонки и доска появятся сразу.</p>
              <button onClick={() => setNewBoardOpen(true)} style={{ background: theme.accent, color: theme.accentText }} className="rounded-lg px-4 py-2.5 text-[13px] font-semibold">Создать проект</button>
            </div>
          )}
        </div>
      </main>

      {taskModal && (
        <TaskModal theme={theme} directory={directory} team={team}
          boardMemberIds={(board?.members || []).map((m) => m.userId)} columns={columns}
          initial={taskModal.mode === "edit" ? taskModal.task : { columnId: taskModal.columnId }}
          onClose={() => setTaskModal(null)} onSave={saveTask} onRequestDelete={requestDeleteTask} />
      )}

      {detailTask && (
        <TaskDetail theme={theme} task={detailTask} directory={directory} currentUser={user}
          onClose={() => setDetailId(null)}
          onEdit={(t) => { setDetailId(null); setTaskModal({ mode: "edit", task: t }); }}
          onTaskPatched={upsertTask}
          onRequestDelete={requestDeleteTask} onError={showError} onOpenUser={setUserCard}
          onOpenTask={setDetailId} />
      )}

      {settingsOpen && board && (
        <BoardSettings theme={theme} board={board} columns={columns} tasks={tasks} directory={directory}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => { setBgStamp(Date.now()); reloadBoards(); loadBoardData(); }}
          onRequestDeleteBoard={requestDeleteBoard} onError={showError} />
      )}

      {newBoardOpen && <NewBoardModal theme={theme} onClose={() => setNewBoardOpen(false)} onCreate={createBoard} />}

      {teamOpen && (
        <Team theme={theme} directory={directory} team={team} currentUser={user} onClose={() => setTeamOpen(false)} onOpenUser={setUserCard}
          onSave={async (ids) => {
            try { await api.saveTeam(ids); setTeam(ids); setTeamOpen(false); }
            catch (e) { showError(e.message); }
          }} />
      )}

      {adminOpen && (
        <Admin theme={theme} currentUser={user} onClose={() => setAdminOpen(false)}
          onError={showError} onInfo={showInfo}
          onDirectoryChanged={() => api.directory().then(setDirectory).catch(() => {})} />
      )}

      {delegationOpen && (
        <Delegation theme={theme} directory={directory} currentUser={user}
          onClose={() => setDelegationOpen(false)}
          onError={showError} onInfo={showInfo} />
      )}

      {openColumn && (
        <ColumnView theme={theme} column={openColumn} directory={directory}
          tasks={sortedTasks.filter((t) => t.columnId === openColumn.id)}
          onClose={() => setOpenColumn(null)}
          onOpenTask={(id) => { setOpenColumn(null); setDetailId(id); }} />
      )}

      {templatesOpen && (
        <Templates theme={theme} directory={directory} team={team}
          boardId={route.boardId} boardTitle={board?.title} columns={columns}
          onClose={() => setTemplatesOpen(false)}
          onError={showError} onInfo={showInfo}
          onCreated={(task) => upsertTask(task)} />
      )}

      {soundOpen && (
        <Modal theme={theme} onClose={() => setSoundOpen(false)} width="max-w-sm">
          <ModalHeader theme={theme} title="Звуковые уведомления"
            subtitle="Разные события звучат по-разному, чтобы понимать их не глядя на экран"
            onClose={() => setSoundOpen(false)} />

          <button onClick={() => setSound((s) => ({ ...s, enabled: !s.enabled }))}
            style={{
              background: sound.enabled ? theme.accent : theme.surfaceAlt,
              color: sound.enabled ? theme.accentText : theme.text,
              border: `1px solid ${theme.border}`,
            }}
            className="w-full rounded-lg py-2.5 text-[13px] font-semibold flex items-center justify-center gap-2 mb-3">
            {sound.enabled ? <Volume2 size={15} /> : <VolumeX size={15} />}
            {sound.enabled ? "Звук включён" : "Звук выключен"}
          </button>

          <div style={{ opacity: sound.enabled ? 1 : 0.45 }}>
            <div className="mono text-[10px] uppercase tracking-wider mb-1.5"
              style={{ color: theme.textMuted }}>// громкость</div>
            <input type="range" min="0.02" max="0.5" step="0.02" value={sound.volume}
              disabled={!sound.enabled}
              onChange={(e) => {
                const v = Number(e.target.value);
                setSound((s) => ({ ...s, volume: v }));
                // Проигрываем сразу: подбирать громкость вслепую,
                // ползунком без отклика, неудобно.
                playEventSound("notification", { ...sound, volume: v, enabled: true });
              }}
              className="w-full mb-4" style={{ accentColor: theme.accent }} />

            <div className="mono text-[10px] uppercase tracking-wider mb-1.5"
              style={{ color: theme.textMuted }}>// какие события</div>
            {Object.entries(SOUND_EVENT_LABELS).map(([key, label]) => (
              <div key={key} className="flex items-center justify-between gap-2 mb-1.5">
                <Toggle theme={theme} checked={sound.events[key] !== false}
                  label={label}
                  onChange={(next) => setSound((s) => ({
                    ...s, events: { ...s.events, [key]: next },
                  }))} />
                <button
                  onClick={() => playEventSound(key, { ...sound, enabled: true, events: { [key]: true } })}
                  style={{ color: theme.accent }} className="mono text-[10px] shrink-0"
                  title="Прослушать">
                  play
                </button>
              </div>
            ))}

            <p style={{ color: theme.textMuted }} className="text-[11.5px] mt-3 leading-relaxed">
              Перемещение задач выключено по умолчанию: на активной доске карточки
              двигаются постоянно, и звук на каждое перетаскивание быстро надоедает.
            </p>
          </div>
        </Modal>
      )}

      {userCard && (
        <UserCard theme={theme} user={userCard} directory={directory}
          onClose={() => setUserCard(null)}
          delegation={(() => {
            const d = activeDelegations.find((x) => x.grantorId === userCard.id);
            if (!d) return null;
            return {
              deputyName: resolveUser(directory, d.deputyId).fullName,
              note: d.note,
              endsAtLabel: fmtDate(d.endsAt),
            };
          })()} />
      )}
      {confirm && <ConfirmDialog theme={theme} {...confirm} onCancel={() => setConfirm(null)} />}
      {toast && <Toast theme={theme} message={toast.message} kind={toast.kind} onDismiss={() => setToast(null)} />}
    </div>
  );
}

function FilterGroup({ theme, label, children }) {
  return (
    <div>
      <div style={{ color: theme.textMuted }} className="text-[11px] font-medium uppercase tracking-wide mb-1">{label}</div>
      <div className="flex flex-wrap gap-1.5 max-w-sm">{children}</div>
    </div>
  );
}

function NewBoardModal({ theme, onClose, onCreate }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [bgPreset, setBgPreset] = useState("none");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    await onCreate({ title: title.trim(), description, bgPreset, bgBlur: true });
    setBusy(false);
  };

  return (
    <Modal theme={theme} onClose={onClose} width="max-w-sm">
      <ModalHeader theme={theme} title="Новый проект" onClose={onClose} />
      <Field label="Название" theme={theme}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} autoFocus
          placeholder="Например, «Инфраструктура API»" style={inputStyle(theme)} className="w-full rounded-lg px-3 py-2 text-[13.5px] outline-none" />
      </Field>
      <Field label="Описание" theme={theme}>
        <input value={description} onChange={(e) => setDescription(e.target.value)} style={inputStyle(theme)} className="w-full rounded-lg px-3 py-2 text-[13px] outline-none" />
      </Field>
      <Field label="Фон" theme={theme} hint="Своё изображение можно загрузить в настройках проекта">
        <div className="grid grid-cols-4 gap-2">
          {ALL_BACKGROUNDS.map((p) => (
            <button key={p.id} onClick={() => setBgPreset(p.id)}
              style={{
                background: p.css || theme.surfaceAlt,
                backgroundSize: p.size || "cover",
                border: `2px solid ${bgPreset === p.id ? theme.accent : theme.border}`,
              }}
              className="h-11 rounded-lg" title={p.label} />
          ))}
        </div>
      </Field>
      <button onClick={submit} disabled={!title.trim() || busy} style={{ background: theme.accent, color: theme.accentText }} className="w-full rounded-lg py-2.5 text-[13.5px] font-semibold disabled:opacity-40 mt-2">
        {busy ? "Создаём…" : "Создать проект"}
      </button>
      <p style={{ color: theme.textMuted }} className="text-[11.5px] mt-2.5">Проект создаётся со стандартным набором колонок — их можно изменить в настройках.</p>
    </Modal>
  );
}
