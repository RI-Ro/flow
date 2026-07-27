import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  LayoutGrid, Search, Filter, Bell, Plus, ChevronDown, Palette, Settings, Eye, EyeOff,
  Inbox, UserPlus, LogOut, Check, Link2, ShieldCheck,
} from "lucide-react";

import { api, hasSession, onAuthLost } from "./lib/api.js";
import { realtimeConnect, realtimeDisconnect, onRealtimeMessage, onRealtimeStatus } from "./lib/realtime.js";
import { playNotificationSound } from "./lib/sound.js";
import { THEMES, ALL_BACKGROUNDS, bgById, PRIORITIES, ROLE_LABEL, isOverdue, resolveUser, bgImageUrl } from "./lib/theme.js";
import { Avatar, Chip, ConfirmDialog, Field, Modal, ModalHeader, Toast, Spinner, UserCard, RealtimeDot, inputStyle } from "./lib/ui.jsx";

import Login from "./components/Login.jsx";
import { BoardView, InboxView } from "./components/Board.jsx";
import TaskModal from "./components/TaskModal.jsx";
import TaskDetail from "./components/TaskDetail.jsx";
import BoardSettings from "./components/BoardSettings.jsx";
import Team from "./components/Team.jsx";
import Notifications from "./components/Notifications.jsx";
import Admin from "./components/Admin.jsx";

const INBOX = "inbox";
const THEME_KEY = "kanban.theme";
const HIDE_DONE_KEY = "kanban.hideCompleted";

function readRoute() {
  const match = window.location.pathname.match(/^\/b\/([0-9a-f-]{36})/i);
  if (match) return { view: "board", boardId: match[1] };
  if (window.location.pathname.startsWith("/inbox")) return { view: INBOX, boardId: null };
  return { view: "none", boardId: null };
}

function pushRoute(route, replace = false) {
  const path = route.view === INBOX ? "/inbox" : route.view === "board" ? `/b/${route.boardId}` : "/";
  if (window.location.pathname === path) return;
  window.history[replace ? "replaceState" : "pushState"]({}, "", path);
}

export default function App() {
  const [themeId, setThemeId] = useState(() => localStorage.getItem(THEME_KEY) || "daylight");
  const theme = THEMES[themeId] || THEMES.daylight;

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
  const [filters, setFilters] = useState({ priority: new Set(), assignee: new Set(), tag: new Set(), overdue: false });
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
  const upsertTask = useCallback((t) => {
    setTasks((prev) => {
      const i = prev.findIndex((x) => x.id === t.id);
      if (i === -1) {
        if (route.view === "board" && t.boardId !== route.boardId) return prev;
        return [...prev, t];
      }
      const next = [...prev];
      next[i] = { ...t, access: prev[i].access };
      return next;
    });
  }, [route]);

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
      setTasks((prev) => prev.map((t) => {
        if (t.id !== taskId) return t;
        if (e.action === "created") return { ...t, commentCount: t.commentCount + 1 };
        if (e.action === "deleted") return { ...t, commentCount: Math.max(0, t.commentCount - 1) };
        return t;
      }));
    });

    const offAttachment = onRealtimeMessage("attachment", (e) => {
      const taskId = e.payload.taskId;
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
      playNotificationSound();
    });

    return () => { offTask(); offStep(); offComment(); offAttachment(); offColumns(); offBoard(); offAccess(); offNotif(); };
  }, [user, route, detailId, upsertTask, fetchOwnTaskView, reloadBoards, showError]);

  /* ---------------------------------------------------------- фильтрация */

  const allTags = useMemo(() => [...new Set(tasks.flatMap((t) => t.tags || []))].sort(), [tasks]);

  const visibleTasks = useMemo(() => tasks.filter((t) => {
    const q = search.trim().toLowerCase();
    if (q && !(`${t.title} ${t.description}`.toLowerCase().includes(q))) return false;
    if (filters.priority.size && !filters.priority.has(t.priority)) return false;
    if (filters.assignee.size && !t.assignees.some((a) => filters.assignee.has(a))) return false;
    if (filters.tag.size && !(t.tags || []).some((tag) => filters.tag.has(tag))) return false;
    if (filters.overdue && !isOverdue(t.dueDate, Boolean(t.completedAt))) return false;
    return true;
  }), [tasks, search, filters]);

  const toggleFilter = (kind, value) => setFilters((f) => {
    const next = new Set(f[kind]);
    next.has(value) ? next.delete(value) : next.add(value);
    return { ...f, [kind]: next };
  });

  const activeFilters = filters.priority.size + filters.assignee.size + filters.tag.size + (filters.overdue ? 1 : 0);

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

  const detailTask = tasks.find((t) => t.id === detailId);

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
        <div style={{ color: theme.text, fontFamily: "Space Grotesk, sans-serif" }} className="flex items-center gap-1.5 font-bold text-[15px]">
          <LayoutGrid size={18} style={{ color: theme.accent }} /> Команда
        </div>

        <div className="relative">
          <button onClick={() => setMenu(menu === "board" ? null : "board")} style={{ background: theme.surfaceAlt, color: theme.text, border: `1px solid ${theme.border}` }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium max-w-[240px]">
            {isInbox && <Inbox size={14} />}
            <span className="truncate">{isInbox ? "Входящие" : board?.title || "Проект"}</span>
            <ChevronDown size={14} />
          </button>

          {menu === "board" && (
            <div style={{ background: theme.surface, border: `1px solid ${theme.border}` }} className="absolute top-full mt-1 left-0 rounded-xl shadow-xl p-1.5 z-30 w-72">
              <button onClick={() => goto({ view: INBOX, boardId: null })} style={{ background: isInbox ? theme.surfaceAlt : "transparent", color: theme.text }} className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[13px] mb-1">
                <Inbox size={15} style={{ color: theme.accent }} /><span className="flex-1 text-left font-medium">Входящие</span>
              </button>
              <div style={{ color: theme.textMuted }} className="text-[10.5px] uppercase tracking-wide font-medium px-2.5 py-1">Проекты</div>
              {boards.map((b) => (
                <button key={b.id} onClick={() => goto({ view: "board", boardId: b.id })} style={{ background: b.id === route.boardId ? theme.surfaceAlt : "transparent", color: theme.text }} className="w-full text-left px-2.5 py-2 rounded-lg text-[13px] flex items-center gap-2">
                  <span style={{
                    background: bgById(b.bgPreset)?.css || theme.border,
                    backgroundSize: bgById(b.bgPreset)?.size || "cover",
                  }} className="w-2.5 h-6 rounded shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="font-medium block truncate">{b.title}</span>
                    <span style={{ color: theme.textMuted }} className="text-[11px]">{ROLE_LABEL[b.myRole]}</span>
                  </span>
                  {b.myRole === "reader" && <Eye size={13} style={{ color: theme.textMuted }} />}
                </button>
              ))}
              {boards.length === 0 && <p style={{ color: theme.textMuted }} className="text-[12.5px] px-2.5 py-2">Проектов пока нет.</p>}
              <div style={{ borderColor: theme.border }} className="border-t mt-1.5 pt-1.5">
                <button onClick={() => { setNewBoardOpen(true); setMenu(null); }} style={{ color: theme.accent }} className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[13px] font-medium">
                  <Plus size={14} /> Новый проект
                </button>
                <button onClick={() => { setTeamOpen(true); setMenu(null); }} style={{ color: theme.text }} className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[13px]">
                  <UserPlus size={14} /> Моя команда ({team.length})
                </button>
              </div>
            </div>
          )}
        </div>

        {!isInbox && board && (
          <>
            <button onClick={copyLink} style={{ color: theme.textMuted }} className="p-1.5" title="Скопировать ссылку на проект"><Link2 size={16} /></button>
            {canManage && <button onClick={() => setSettingsOpen(true)} style={{ color: theme.textMuted }} className="p-1.5" title="Настройки проекта"><Settings size={17} /></button>}
            {!canEdit && (
              <span style={{ background: theme.surfaceAlt, color: theme.textMuted }} className="flex items-center gap-1 text-[11.5px] px-2 py-1 rounded-lg">
                <Eye size={12} /> Только чтение
              </span>
            )}
          </>
        )}

        <div className="relative flex-1 min-w-[150px] max-w-xs">
          <Search size={14} style={{ color: theme.textMuted }} className="absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск задач" style={inputStyle(theme)} className="w-full pl-8 pr-2.5 py-1.5 rounded-lg text-[13px] outline-none" />
        </div>

        <button onClick={() => setFiltersOpen((v) => !v)} style={{ background: activeFilters ? theme.accent : theme.surfaceAlt, color: activeFilters ? theme.accentText : theme.text, border: `1px solid ${theme.border}` }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium">
          <Filter size={13} /> Фильтры{activeFilters > 0 && ` (${activeFilters})`}
        </button>

        {!isInbox && (
          <button onClick={() => setHideCompleted((v) => !v)} style={{ background: hideCompleted ? theme.accent : theme.surfaceAlt, color: hideCompleted ? theme.accentText : theme.text, border: `1px solid ${theme.border}` }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium" title={hideCompleted ? "Показать завершённые" : "Скрыть завершённые"}>
            {hideCompleted ? <EyeOff size={13} /> : <Eye size={13} />}<span className="hidden sm:inline">Завершённые</span>
          </button>
        )}

        {canEdit && !isInbox && (
          <button onClick={() => setTaskModal({ mode: "create", columnId: columns[0]?.id })} style={{ background: theme.accent, color: theme.accentText }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-semibold ml-auto">
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
            <div style={{ background: theme.surface, border: `1px solid ${theme.border}` }} className="absolute top-full mt-1 right-0 rounded-xl shadow-xl p-1.5 z-30 w-44">
              {Object.entries(THEMES).map(([id, t]) => (
                <button key={id} onClick={() => { setThemeId(id); setMenu(null); }} style={{ color: theme.text, background: id === themeId ? theme.surfaceAlt : "transparent" }} className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12.5px]">
                  <span style={{ background: t.accent, border: `1px solid ${theme.border}` }} className="w-3 h-3 rounded-full" />
                  {t.name}{id === themeId && <Check size={12} className="ml-auto" />}
                </button>
              ))}
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

      {filtersOpen && (
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
          <FilterGroup theme={theme} label="Прочее">
            <Chip theme={theme} active={filters.overdue} onClick={() => setFilters((f) => ({ ...f, overdue: !f.overdue }))}>Только просроченные</Chip>
          </FilterGroup>
          {activeFilters > 0 && (
            <button onClick={() => setFilters({ priority: new Set(), assignee: new Set(), tag: new Set(), overdue: false })} style={{ color: theme.danger }} className="text-[12px] font-medium self-center">
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
          ) : isInbox ? (
            <InboxView tasks={visibleTasks} theme={theme} directory={directory} onOpenTask={setDetailId} />
          ) : board ? (
            <BoardView columns={columns} tasks={visibleTasks} theme={theme} directory={directory} canEdit={canEdit} canManage={canManage}
              hideCompleted={hideCompleted} onOpenTask={setDetailId} onMove={moveTask}
              onQuickAdd={(columnId) => setTaskModal({ mode: "create", columnId })} onSettings={() => setSettingsOpen(true)}
              onShowCompleted={() => setHideCompleted(false)} />
          ) : (
            <div className="max-w-md mx-auto text-center py-16">
              <LayoutGrid size={30} style={{ color: theme.textMuted }} className="mx-auto mb-3" />
              <h3 style={{ color: theme.text, fontFamily: "Space Grotesk, sans-serif" }} className="font-semibold text-[16px] mb-1.5">Проектов пока нет</h3>
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
          onRequestDelete={requestDeleteTask} onError={showError} onOpenUser={setUserCard} />
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

      {userCard && <UserCard theme={theme} user={userCard} onClose={() => setUserCard(null)} />}
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
