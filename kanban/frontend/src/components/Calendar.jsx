import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, CalendarDays, Check, Plus } from "lucide-react";
import { api } from "../lib/api.js";
import { PRIORITIES, fmtDate, resolveUser, dueColor, taskColorFill, plural } from "../lib/theme.js";
import { onRealtimeMessage } from "../lib/realtime.js";
import { Avatar, Spinner, Modal, ModalHeader, Field, inputStyle } from "../lib/ui.jsx";

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const MONTHS = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

const iso = (d) => d.toISOString().slice(0, 10);
const todayIso = () => iso(new Date());

// Сетка месяца всегда начинается с понедельника и содержит целые
// недели: иначе клетки первой и последней строки съезжают, и календарь
// перестаёт читаться как таблица.
function monthGrid(year, month) {
  const first = new Date(Date.UTC(year, month, 1));
  const shift = (first.getUTCDay() + 6) % 7; // понедельник = 0
  const start = new Date(first);
  start.setUTCDate(first.getUTCDate() - shift);

  const days = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    days.push(d);
  }
  // Шестая строка нужна не всегда — убираем, если она целиком из
  // соседнего месяца.
  const lastWeek = days.slice(35);
  return lastWeek.every((d) => d.getUTCMonth() !== month) ? days.slice(0, 35) : days;
}

export default function Calendar({ theme, directory, boards, currentUser, onError, onInfo, onOpenTask, onTaskCreated }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [onlyMine, setOnlyMine] = useState(false);
  const [boardId, setBoardId] = useState("");
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(todayIso());
  const [creating, setCreating] = useState(null);

  const grid = useMemo(() => monthGrid(year, month), [year, month]);

  const load = useCallback(async () => {
    if (grid.length === 0) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        from: iso(grid[0]),
        to: iso(grid[grid.length - 1]),
      });
      if (onlyMine) params.set("mine", "1");
      if (boardId) params.set("boardId", boardId);
      const data = await api.calendar(params.toString());
      setTasks(data.items || []);
    } catch (e) {
      onError(e.message);
    } finally {
      setLoading(false);
    }
  }, [grid, onlyMine, boardId, onError]);

  useEffect(() => { load(); }, [load]);

  // Календарь раскладывает задачи по клеткам на основании due_date.
  // Когда срок меняют — из карточки, с доски или другим человеком —
  // задача обязана переехать в другую клетку, а при изменении вне
  // текущего диапазона исчезнуть. Проще и надёжнее перезапросить
  // диапазон, чем пытаться пересчитать раскладку по частям.
  useEffect(() => {
    const off = onRealtimeMessage("task", () => load());
    return off;
  }, [load]);

  // Задачи, разложенные по дням: один проход вместо фильтрации внутри
  // каждой из 35 клеток.
  const byDay = useMemo(() => {
    const map = new Map();
    for (const t of tasks) {
      if (!map.has(t.dueDate)) map.set(t.dueDate, []);
      map.get(t.dueDate).push(t);
    }
    return map;
  }, [tasks]);

  const shift = (delta) => {
    const d = new Date(Date.UTC(year, month + delta, 1));
    setYear(d.getUTCFullYear());
    setMonth(d.getUTCMonth());
  };

  const goToday = () => {
    const d = new Date();
    setYear(d.getFullYear());
    setMonth(d.getMonth());
    setSelected(todayIso());
  };

  const selectedTasks = byDay.get(selected) || [];

  return (
    <div className="max-w-[1500px] mx-auto pb-6">
      {/* ── управление ───────────────────────────────────────────── */}
      <div style={{ background: theme.surface, border: `1px solid ${theme.border}` }}
        className="rounded-2xl p-3 mb-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <button onClick={() => shift(-1)} style={{ color: theme.textMuted }} className="p-1.5"
            title="Предыдущий месяц">
            <ChevronLeft size={16} />
          </button>
          <span style={{ color: theme.text, fontFamily: "Manrope, sans-serif" }}
            className="font-bold text-[15px] min-w-[150px] text-center">
            {MONTHS[month]} {year}
          </span>
          <button onClick={() => shift(1)} style={{ color: theme.textMuted }} className="p-1.5"
            title="Следующий месяц">
            <ChevronRight size={16} />
          </button>
        </div>

        <button onClick={goToday}
          style={{ background: theme.surfaceAlt, color: theme.text, border: `1px solid ${theme.border}` }}
          className="px-2.5 py-1.5 rounded-lg text-[12px] font-medium">
          Сегодня
        </button>

        <button onClick={() => setOnlyMine((v) => !v)}
          style={{
            background: onlyMine ? theme.accent : theme.surfaceAlt,
            color: onlyMine ? theme.accentText : theme.text,
            border: `1px solid ${theme.border}`,
          }}
          className="px-2.5 py-1.5 rounded-lg text-[12px] font-medium">
          Только мои
        </button>

        <select value={boardId} onChange={(e) => setBoardId(e.target.value)}
          style={{ background: theme.surfaceAlt, color: theme.text, border: `1px solid ${theme.border}` }}
          className="rounded-lg px-2 py-1.5 text-[12px] outline-none min-w-[160px]">
          <option value="">Все проекты</option>
          {boards.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
        </select>

        <span className="mono text-[10.5px] ml-auto" style={{ color: theme.textMuted }}>
          {loading ? "// загрузка…" : `// ${plural(tasks.length, "задача", "задачи", "задач")} со сроком`}
        </span>
      </div>

      <div className="flex gap-3 items-start flex-col lg:flex-row">
        {/* ── сетка месяца ───────────────────────────────────────── */}
        <div style={{ background: theme.surface, border: `1px solid ${theme.border}` }}
          className="rounded-2xl p-3 flex-1 w-full">
          <div className="grid grid-cols-7 gap-1 mb-1">
            {WEEKDAYS.map((w, i) => (
              <div key={w} className="mono text-[10px] uppercase text-center py-1"
                style={{ color: i > 4 ? theme.danger : theme.textMuted }}>
                {w}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {grid.map((d) => {
              const key = iso(d);
              const dayTasks = byDay.get(key) || [];
              const isCurrentMonth = d.getUTCMonth() === month;
              const isToday = key === todayIso();
              const isSelected = key === selected;
              const isWeekend = [0, 6].includes(d.getUTCDay());
              const overdue = dayTasks.filter((t) => !t.completed && key < todayIso()).length;

              return (
                <button key={key} onClick={() => setSelected(key)}
                  style={{
                    background: isSelected ? theme.surfaceAlt : "transparent",
                    border: `1px solid ${isSelected ? theme.accent : isToday ? theme.accent2 : theme.border}`,
                    opacity: isCurrentMonth ? 1 : 0.4,
                  }}
                  className="rounded-lg p-1.5 min-h-[92px] text-left flex flex-col gap-1 hover:opacity-90">
                  <div className="flex items-center justify-between">
                    <span style={{
                      color: isToday ? theme.accent : isWeekend ? theme.danger : theme.text,
                      fontWeight: isToday ? 800 : 500,
                    }} className="text-[12px]">
                      {d.getUTCDate()}
                    </span>
                    {dayTasks.length > 0 && (
                      <span className="mono text-[9.5px]"
                        style={{ color: overdue > 0 ? theme.danger : theme.textMuted }}>
                        {dayTasks.length}
                      </span>
                    )}
                  </div>

                  {/* В клетке помещается три карточки; остальное
                      сворачивается в счётчик — иначе высота строки
                      скачет и сетка перестаёт быть сеткой. */}
                  {dayTasks.slice(0, 3).map((t) => {
                    const fill = taskColorFill(t.color, theme);
                    return (
                      <span key={t.id}
                        style={{
                          background: fill || theme.surfaceAlt,
                          color: theme.text,
                          textDecoration: t.completed ? "line-through" : "none",
                          opacity: t.completed ? 0.6 : 1,
                          borderLeft: `2px solid ${theme[PRIORITIES[t.priority]?.color] || theme.border}`,
                        }}
                        className="text-[10px] px-1 py-0.5 rounded truncate block">
                        {t.title}
                      </span>
                    );
                  })}
                  {dayTasks.length > 3 && (
                    <span className="mono text-[9.5px]" style={{ color: theme.textMuted }}>
                      +{dayTasks.length - 3}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── выбранный день ─────────────────────────────────────── */}
        <div style={{ background: theme.surface, border: `1px solid ${theme.border}` }}
          className="rounded-2xl p-3 w-full lg:w-[340px] shrink-0">
          <div className="flex items-center gap-2 mb-3">
            <CalendarDays size={15} style={{ color: theme.accent }} />
            <span style={{ color: theme.text, fontFamily: "Manrope, sans-serif" }}
              className="font-bold text-[14px]">
              {fmtDate(selected)}
            </span>
            <span className="mono text-[10px] ml-auto" style={{ color: theme.textMuted }}>
              {selectedTasks.length}
            </span>
          </div>

          <button onClick={() => setCreating(selected)}
            style={{ color: theme.accent, border: `1px dashed ${theme.border}` }}
            className="w-full flex items-center justify-center gap-1.5 rounded-lg py-2 text-[12px] font-medium mb-2">
            <Plus size={13} /> Задача на этот день
          </button>

          {selectedTasks.length === 0 && (
            <p style={{ color: theme.textMuted }} className="text-[12.5px] py-6 text-center">
              На этот день задач нет.
            </p>
          )}

          {selectedTasks.map((t) => {
            const tint = dueColor(t.dueDate, t.completed, theme);
            const assignees = t.assignees.map((id) => resolveUser(directory, id));
            return (
              <button key={t.id} onClick={() => onOpenTask(t.id)}
                style={{ background: theme.surfaceAlt, border: `1px solid ${theme.border}` }}
                className="w-full rounded-xl p-2.5 mb-1.5 text-left">
                <div className="flex items-start gap-1.5 mb-1">
                  <span style={{ background: theme[PRIORITIES[t.priority]?.color] || theme.border }}
                    className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0" />
                  <span style={{
                    color: theme.text,
                    textDecoration: t.completed ? "line-through" : "none",
                  }} className="text-[12.5px] font-medium leading-snug">
                    {t.title}
                  </span>
                  {t.completed && <Check size={12} style={{ color: theme.success }} className="shrink-0 mt-0.5" />}
                </div>

                <div style={{ color: theme.textMuted }} className="text-[10.5px] truncate mb-1">
                  {t.boardTitle}
                  {t.incomingNumber ? ` · вх. № ${t.incomingNumber}` : ""}
                </div>

                {/* Автор — как во «Входящих»: по задаче в чужом проекте
                    первым делом нужно понять, кто её поставил. */}
                <div className="flex items-center gap-1.5 mb-1">
                  <Avatar user={resolveUser(directory, t.createdBy)} size={15} theme={theme} />
                  <span style={{ color: theme.textMuted }} className="text-[10.5px] truncate">
                    поставил(а): {resolveUser(directory, t.createdBy).fullName}
                  </span>
                  {/* Уровень доступа объясняет, почему задача не
                      редактируется: раньше карточка просто не отвечала
                      на попытку правки без единого пояснения. */}
                  {t.access !== "edit" && (
                    <span className="mono text-[9px] px-1 py-0.5 rounded shrink-0"
                      style={{ background: theme.surface, color: theme.textMuted }}
                      title={t.access === "read"
                        ? "Доступ только на просмотр — правка недоступна"
                        : "Участие: комментарии и отметки, но не правка задачи"}>
                      {t.access === "read" ? "просмотр" : "участие"}
                    </span>
                  )}
                </div>

                <div className="flex items-center justify-between gap-2">
                  <div className="flex -space-x-1.5">
                    {assignees.slice(0, 4).map((u, i) => (
                      <span key={`${u.id}-${i}`}
                        style={{ boxShadow: `0 0 0 2px ${theme.surfaceAlt}`, borderRadius: 999 }}>
                        <Avatar user={u} size={19} theme={theme} />
                      </span>
                    ))}
                  </div>
                  {!t.completed && tint && (
                    <span className="mono text-[9.5px]" style={{ color: tint }}>
                      {selected < todayIso() ? "просрочено" : "срок"}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {creating && (
        <CalendarTaskForm theme={theme} directory={directory} boards={boards}
          dueDate={creating} onClose={() => setCreating(null)}
          onError={onError}
          onCreated={(task) => {
            setCreating(null);
            onInfo(`Задача «${task.title}» создана`);
            onTaskCreated?.(task);
            load();
          }} />
      )}
    </div>
  );
}

// Создание задачи прямо из календаря.
//
// Проект и колонка выбираются здесь же: задача обязана куда-то попасть,
// а календарь показывает сразу все проекты — угадать нужный за
// пользователя нельзя. Колонки подгружаются после выбора проекта,
// потому что у каждого они свои.
function CalendarTaskForm({ theme, directory, boards, dueDate, onClose, onCreated, onError }) {
  const [boardId, setBoardId] = useState("");
  const [columns, setColumns] = useState([]);
  const [columnId, setColumnId] = useState("");
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("dated");
  const [busy, setBusy] = useState(false);

  // Только те проекты, где есть право создавать задачи: читателю
  // показывать проект в выборе бессмысленно — сохранение отвергнет RLS.
  const writable = boards.filter((b) => ["owner", "editor"].includes(b.myRole));

  useEffect(() => {
    if (!boardId) { setColumns([]); setColumnId(""); return; }
    let alive = true;
    api.columns(boardId)
      .then((cols) => {
        if (!alive) return;
        setColumns(cols);
        setColumnId(cols[0]?.id || "");
      })
      .catch((e) => onError(e.message));
    return () => { alive = false; };
  }, [boardId, onError]);

  const submit = async () => {
    if (!title.trim()) return onError("Укажите название задачи");
    if (!boardId || !columnId) return onError("Выберите проект и колонку");
    setBusy(true);
    try {
      const task = await api.createTask(boardId, {
        title: title.trim(), description: "", priority,
        color: "none", incomingNumber: "", incomingDate: null,
        columnId, dueDate, tags: [], assignees: [],
      });
      onCreated(task);
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal theme={theme} onClose={onClose} width="max-w-sm">
      <ModalHeader theme={theme} title="Новая задача"
        subtitle={`Срок исполнения — ${fmtDate(dueDate)}`} onClose={onClose} />

      <Field label="Название" theme={theme}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Новая задача" style={inputStyle(theme)}
          className="w-full rounded-lg px-3 py-2 text-[13.5px] outline-none" />
      </Field>

      <Field label="Проект" theme={theme}
        hint={writable.length === 0 ? "Нет проектов, где вы можете создавать задачи" : undefined}>
        <select value={boardId} onChange={(e) => setBoardId(e.target.value)}
          style={inputStyle(theme)} className="w-full rounded-lg px-2 py-2 text-[13px] outline-none">
          <option value="">— выберите —</option>
          {writable.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
        </select>
      </Field>

      {columns.length > 0 && (
        <Field label="Колонка" theme={theme}>
          <div className="flex flex-wrap gap-1.5">
            {columns.map((c) => (
              <button key={c.id} onClick={() => setColumnId(c.id)}
                style={{
                  background: columnId === c.id ? theme.accent : theme.surfaceAlt,
                  color: columnId === c.id ? theme.accentText : theme.text,
                  border: `1px solid ${theme.border}`,
                }}
                className="px-2.5 py-1.5 rounded-lg text-[12px] font-medium">
                {c.title}
              </button>
            ))}
          </div>
        </Field>
      )}

      <Field label="Приоритет" theme={theme}>
        <select value={priority} onChange={(e) => setPriority(e.target.value)}
          style={inputStyle(theme)} className="w-full rounded-lg px-2 py-2 text-[13px] outline-none">
          {Object.entries(PRIORITIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
      </Field>

      <button onClick={submit} disabled={busy || !boardId || !columnId}
        style={{ background: theme.accent, color: theme.accentText }}
        className="w-full rounded-lg py-2.5 text-[13.5px] font-semibold disabled:opacity-40 mt-1">
        {busy ? "Создаём…" : "Создать задачу"}
      </button>
    </Modal>
  );
}
