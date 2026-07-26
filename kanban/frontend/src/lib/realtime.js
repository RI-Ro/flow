import { api, onTokenChanged, hasSession } from "./api.js";

// Простая шина: компоненты подписываются на тип события ("task",
// "step", "comment", "attachment", "columns", "board", "notification")
// и получают payload из конверта, который присылает realtime.Hub.
const listeners = new Map(); // type -> Set<fn>
let socket = null;
let reconnectDelay = 1000;
let reconnectTimer = null;
let manuallyClosed = false;
let statusListeners = new Set();

function setStatus(status) {
  statusListeners.forEach((fn) => fn(status));
}

export function onRealtimeStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

export function onRealtimeMessage(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type)?.delete(fn);
}

function dispatch(event) {
  listeners.get(event.type)?.forEach((fn) => fn(event));
}

export function realtimeConnect() {
  if (!hasSession()) return;
  manuallyClosed = false;
  clearTimeout(reconnectTimer);

  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  socket = new WebSocket(api.wsUrl());

  socket.onopen = () => {
    reconnectDelay = 1000;
    setStatus("connected");
  };

  socket.onmessage = (msg) => {
    try {
      dispatch(JSON.parse(msg.data));
    } catch {
      // Мусорный фрейм (например, служебный ping как текстовое
      // сообщение) — не повод рвать соединение.
    }
  };

  socket.onclose = () => {
    setStatus("disconnected");
    if (manuallyClosed) return;
    // Экспоненциальная задержка с потолком: при массовом обрыве (рестарт
    // бэкенда под нагрузкой от 300 клиентов) не устраиваем всем разом
    // синхронную атаку переподключений — потолок и случайный джиттер
    // размазывают повторные попытки по времени.
    const jitter = Math.random() * 400;
    reconnectTimer = setTimeout(realtimeConnect, reconnectDelay + jitter);
    reconnectDelay = Math.min(reconnectDelay * 1.7, 20000);
  };

  socket.onerror = () => {
    socket?.close();
  };
}

export function realtimeDisconnect() {
  manuallyClosed = true;
  clearTimeout(reconnectTimer);
  socket?.close();
  socket = null;
}

// При ротации access-токена (обычная REST-логика api.js) сокет сам по
// себе не разрывается — токен там участвует только в query-параметре
// первого рукопожатия. Переподключаемся с новым токеном, чтобы сессия
// WebSocket не осталась привязанной к уже невалидному значению дольше,
// чем нужно.
onTokenChanged((newAccess) => {
  if (!newAccess) {
    realtimeDisconnect();
    return;
  }
  if (socket) {
    manuallyClosed = false;
    socket.close();
    socket = null;
    realtimeConnect();
  }
});
