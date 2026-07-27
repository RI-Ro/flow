const ACCESS_KEY = "kanban.access";
const REFRESH_KEY = "kanban.refresh";

let accessToken = sessionStorage.getItem(ACCESS_KEY) || null;
let refreshToken = localStorage.getItem(REFRESH_KEY) || null;
let refreshPromise = null;
const authListeners = new Set();
const tokenListeners = new Set();

export function setTokens(access, refresh) {
  accessToken = access;
  refreshToken = refresh;
  access ? sessionStorage.setItem(ACCESS_KEY, access) : sessionStorage.removeItem(ACCESS_KEY);
  refresh ? localStorage.setItem(REFRESH_KEY, refresh) : localStorage.removeItem(REFRESH_KEY);
  tokenListeners.forEach((fn) => fn(access));
}

export const hasSession = () => Boolean(refreshToken);
export const accessTokenValue = () => accessToken;
export const onAuthLost = (fn) => (authListeners.add(fn), () => authListeners.delete(fn));
// Уведомляет WebSocket-клиент, что нужно переподключиться с новым
// токеном — обычная REST-ротация токена сама по себе разрыв сокета
// не вызывает, поэтому его никто, кроме нас, не заметит.
export const onTokenChanged = (fn) => (tokenListeners.add(fn), () => tokenListeners.delete(fn));

function loseAuth() {
  setTokens(null, null);
  authListeners.forEach((fn) => fn());
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function refreshAccess() {
  if (!refreshToken) throw new ApiError(401, "no_session", "Нет активной сессии");
  if (!refreshPromise) {
    refreshPromise = fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    })
      .then(async (res) => {
        if (!res.ok) {
          loseAuth();
          throw new ApiError(401, "refresh_failed", "Сессия истекла, войдите заново");
        }
        const data = await res.json();
        setTokens(data.accessToken, data.refreshToken);
        return data;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

async function request(method, path, { body, form, retry = true } = {}) {
  const headers = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const res = await fetch(`/api${path}`, { method, headers, body: payload });

  if (res.status === 401 && retry && refreshToken) {
    await refreshAccess();
    return request(method, path, { body, form, retry: false });
  }
  if (res.status === 204) return null;

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    if (res.status === 401) loseAuth();
    throw new ApiError(res.status, data?.code || "error", data?.error || "Не удалось выполнить запрос");
  }
  return data;
}

const get = (p) => request("GET", p);
const post = (p, body) => request("POST", p, { body });
const patch = (p, body) => request("PATCH", p, { body });
const put = (p, body) => request("PUT", p, { body });
const del = (p) => request("DELETE", p);

export const api = {
  async login(email, password) {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new ApiError(res.status, data?.code, data?.error || "Не удалось войти");
    setTokens(data.accessToken, data.refreshToken);
    return data.user;
  },

  async register(payload) {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new ApiError(res.status, data?.code, data?.error || "Не удалось зарегистрироваться");
    setTokens(data.accessToken, data.refreshToken);
    return data.user;
  },

  async restore() {
    const data = await refreshAccess();
    return data.user;
  },

  async logout() {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
    } finally {
      setTokens(null, null);
    }
  },

  me: () => get("/me"),
  updateMe: (patchBody) => patch("/me", patchBody),
  changePassword: (currentPassword, newPassword) => post("/me/password", { currentPassword, newPassword }),
  directory: (q = "") => get(`/users?limit=500${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  team: () => get("/team"),
  saveTeam: (ids) => put("/team", ids),

  notifications: ({ limit = 10, offset = 0, includeRead = false }) =>
    get(`/notifications?limit=${limit}&offset=${offset}&includeRead=${includeRead}`),
  readNotification: (id) => post(`/notifications/${id}/read`),
  readAllNotifications: () => post("/notifications/read-all"),

  boards: () => get("/boards"),
  board: (id) => get(`/boards/${id}`),
  createBoard: (payload) => post("/boards/", payload),
  updateBoard: (id, payload) => patch(`/boards/${id}`, payload),
  deleteBoard: (id) => del(`/boards/${id}`),
  setMembers: (id, members) => put(`/boards/${id}/members`, members),

  uploadBackground(boardId, file) {
    const form = new FormData();
    form.append("file", file);
    return request("POST", `/boards/${boardId}/background`, { form });
  },
  deleteBackground: (boardId) => del(`/boards/${boardId}/background`),
  backgroundUrl: (boardId, stamp) =>
    `/api/boards/${boardId}/background?access_token=${encodeURIComponent(accessToken || "")}&v=${stamp || 0}`,

  columns: (boardId) => get(`/boards/${boardId}/columns`),
  saveColumns: (boardId, columns) => put(`/boards/${boardId}/columns`, columns),

  tasks: (boardId) => get(`/boards/${boardId}/tasks`),
  inbox: () => get("/inbox"),
  task: (id) => get(`/tasks/${id}/`),
  createTask: (boardId, payload) => post(`/boards/${boardId}/tasks`, payload),
  updateTask: (id, payload) => patch(`/tasks/${id}/`, payload),
  deleteTask: (id) => del(`/tasks/${id}/`),
  moveTask: (id, columnId, position) => post(`/tasks/${id}/move`, { columnId, position }),
  completeTask: (id, completed) => post(`/tasks/${id}/complete`, { completed }),
  // Отметка исполнителя о своей части. Отдельный маршрут, а не флаг в
  // completeTask: права разные — закрыть задачу может редактор,
  // отметиться только сам исполнитель.
  completeAssignment: (id, completed) => post(`/tasks/${id}/assignment`, { completed }),
  setGrants: (id, grants) => put(`/tasks/${id}/grants`, grants),

  createStep: (taskId, body) => post(`/tasks/${taskId}/steps`, { body }),
  renameStep: (taskId, stepId, body) => patch(`/tasks/${taskId}/steps/${stepId}`, { body }),
  toggleStep: (taskId, stepId, done) => post(`/tasks/${taskId}/steps/${stepId}/toggle`, { done }),
  deleteStep: (taskId, stepId) => del(`/tasks/${taskId}/steps/${stepId}`),

  comments: (taskId) => get(`/tasks/${taskId}/comments`),
  addComment: (taskId, body) => post(`/tasks/${taskId}/comments`, { body }),
  editComment: (id, body) => patch(`/comments/${id}`, { body }),
  deleteComment: (id) => del(`/comments/${id}`),

  attachments: (taskId) => get(`/tasks/${taskId}/attachments`),
  uploadAttachment(taskId, file) {
    const form = new FormData();
    form.append("file", file);
    return request("POST", `/tasks/${taskId}/attachments`, { form });
  },
  renameAttachment: (id, title) => patch(`/attachments/${id}`, { title }),
  deleteAttachment: (id) => del(`/attachments/${id}`),
  attachmentUrl: (id, download = false) =>
    `/api/attachments/${id}/content?access_token=${encodeURIComponent(accessToken || "")}${download ? "&download=1" : ""}`,

  activity: (taskId) => get(`/tasks/${taskId}/activity`),

  // --- администрирование учётных записей
  // Доступно только роли admin: сервер проверяет права запросом к базе
  // на каждый вызов и отвечает 404, если их нет.
  adminUsers: ({ limit = 20, offset = 0, q = "" }) =>
    get(`/admin/users?limit=${limit}&offset=${offset}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  adminCreateUser: (payload) => post("/admin/users", payload),
  adminUpdateUser: (id, payload) => patch(`/admin/users/${id}`, payload),
  adminDeleteUser: (id) => del(`/admin/users/${id}`),
  adminRestoreUser: (id) => post(`/admin/users/${id}/restore`),
  adminResetPassword: (id, newPassword) => post(`/admin/users/${id}/password`, { newPassword }),

  wsUrl: () => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/api/ws?access_token=${encodeURIComponent(accessToken || "")}`;
  },
};
