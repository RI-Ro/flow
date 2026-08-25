import React, { useCallback, useEffect, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, LineChart, Line,
} from "recharts";
import { AlertTriangle, CheckCircle2, Clock, ListTodo, X, Inbox } from "lucide-react";
import { api } from "../lib/api.js";
import { PRIORITIES, fmtDate, resolveUser, dueColor } from "../lib/theme.js";
import { Avatar, Modal, ModalHeader, Spinner, inputStyle } from "../lib/ui.jsx";

const STATUSES = [
  ["all", "Все"],
  ["open", "Не выполнены"],
  ["done", "Выполнены"],
  ["overdue", "Просрочены"],
];

const monthsAgo = (n) => {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
};
const tomorrow = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

const FILTER_KEY = "kanban.dashboardFilter";

export default function Dashboard({ theme, directory, boards, currentUser, onError, onOpenTask }) {
  // Фильтр переживает перезагрузку — как и фильтры доски: настроенный
  // срез это рабочий инструмент, а не разовый выбор.
  const [filter, setFilter] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || "{}");
      return {
        from: saved.from || monthsAgo(6),
        to: saved.to || tomorrow(),
        status: saved.status || "all",
        boardId: saved.boardId || "",
      };
    } catch {
      return { from: monthsAgo(6), to: tomorrow(), status: "all", boardId: "" };
    }
  });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [userTasks, setUserTasks] = useState(null);

  useEffect(() => {
    localStorage.setItem(FILTER_KEY, JSON.stringify(filter));
  }, [filter]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        from: filter.from, to: filter.to, status: filter.status,
      });
      if (filter.boardId) params.set("boardId", filter.boardId);
      setData(await api.dashboard(params.toString()));
    } catch (e) {
      onError(e.message);
    } finally {
      setLoading(false);
    }
  }, [filter, onError]);

  useEffect(() => { load(); }, [load]);

  const set = (k, v) => setFilter((f) => ({ ...f, [k]: v }));

  // override позволяет открыть срез, отличающийся от текущего фильтра:
  // например, «из них просрочено» — тот же человек, но только
  // просроченные, независимо от выбранного статуса.
  const openUser = async (userId, kind, override = {}) => {
    try {
      const params = new URLSearchParams({
        from: override.from || filter.from,
        to: override.to || filter.to,
        status: override.status || filter.status,
        kind,
      });
      if (filter.boardId) params.set("boardId", filter.boardId);
      const tasks = await api.dashboardUserTasks(userId, params.toString());
      setUserTasks({ user: resolveUser(directory, userId), kind, tasks, override });
    } catch (e) {
      onError(e.message);
    }
  };

  // Палитра графиков строится от акцентов темы, а не задаётся жёстко:
  // фиксированные цвета выглядели бы чужеродно на кислотном Balun и на
  // пастельной Rose одновременно.
  const chartColors = [
    theme.accent, theme.accent2, theme.info, theme.warning, theme.danger, theme.success,
  ];

  const tooltipStyle = {
    background: theme.surface,
    border: `1px solid ${theme.border}`,
    borderRadius: 10,
    fontSize: 12,
    color: theme.text,
  };

  if (loading && !data) {
    return <Spinner theme={theme} label="Считаем статистику…" />;
  }
  if (!data) return null;

  const t = data.totals;
  const my = data.myLoad || {};

  const priorityData = (data.byPriority || []).map((p) => ({
    name: PRIORITIES[p.priority]?.label || p.priority,
    value: p.total,
    done: p.done,
  }));

  const boardData = (data.byBoard || []).slice(0, 8).map((b) => ({
    name: b.title.length > 18 ? b.title.slice(0, 17) + "…" : b.title,
    Всего: b.total,
    Выполнено: b.done,
    Просрочено: b.overdue,
  }));

  const weekData = (data.byWeek || []).map((w) => ({
    name: fmtDate(w.week),
    Создано: w.created,
    Выполнено: w.done,
  }));

  return (
    <div className="max-w-[1500px] mx-auto pb-6">
      {/* ── фильтр ───────────────────────────────────────────────── */}
      <div style={{ background: theme.surface, border: `1px solid ${theme.border}` }}
        className="rounded-2xl p-3 mb-4 flex flex-wrap items-end gap-3">
        <div>
          <div className="mono text-[10px] uppercase tracking-wider mb-1"
            style={{ color: theme.textMuted }}>период с</div>
          <input type="date" value={filter.from} onChange={(e) => set("from", e.target.value)}
            style={inputStyle(theme)} className="rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none" />
        </div>
        <div>
          <div className="mono text-[10px] uppercase tracking-wider mb-1"
            style={{ color: theme.textMuted }}>по</div>
          <input type="date" value={filter.to} onChange={(e) => set("to", e.target.value)}
            style={inputStyle(theme)} className="rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none" />
        </div>

        <div>
          <div className="mono text-[10px] uppercase tracking-wider mb-1"
            style={{ color: theme.textMuted }}>статус</div>
          <div className="flex gap-1">
            {STATUSES.map(([id, label]) => (
              <button key={id} onClick={() => set("status", id)}
                style={{
                  background: filter.status === id ? theme.accent : theme.surfaceAlt,
                  color: filter.status === id ? theme.accentText : theme.text,
                  border: `1px solid ${theme.border}`,
                }}
                className="px-2.5 py-1.5 rounded-lg text-[12px] font-medium">
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-w-[180px]">
          <div className="mono text-[10px] uppercase tracking-wider mb-1"
            style={{ color: theme.textMuted }}>проект</div>
          <select value={filter.boardId} onChange={(e) => set("boardId", e.target.value)}
            style={inputStyle(theme)} className="w-full rounded-lg px-2 py-1.5 text-[12.5px] outline-none">
            <option value="">Все проекты</option>
            {boards.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
          </select>
        </div>

        {loading && (
          <span style={{ color: theme.textMuted }} className="text-[12px] self-center">обновляем…</span>
        )}
      </div>

      {/* ── что на мне ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Metric theme={theme} icon={ListTodo} label="Мне поручено"
          value={my.assigned || 0} accent={theme.accent}
          hint="Незавершённые задачи, где я исполнитель"
          onClick={() => openUser(currentUser.id, "assigned")} />
        <Metric theme={theme} icon={AlertTriangle} label="Из них просрочено"
          value={my.assignedOverdue || 0} accent={theme.danger}
          hint="Мои задачи с истёкшим сроком"
          onClick={() => openUser(currentUser.id, "assigned", { status: "overdue" })} />
        <Metric theme={theme} icon={CheckCircle2} label="Я поручил"
          value={my.createdByMe || 0} accent={theme.accent2}
          hint="Незавершённые задачи, которые создал я"
          onClick={() => openUser(currentUser.id, "created")} />
        <Metric theme={theme} icon={Inbox} label="Открыт доступ"
          value={my.grantedToMe || 0} accent={theme.info}
          hint="Задачи чужих проектов, открытые мне точечно"
          onClick={() => openUser(currentUser.id, "granted")} />
      </div>

      {/* ── сводка по выборке ────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
        <Metric theme={theme} label="Всего задач" value={t.total} />
        <Metric theme={theme} label="Выполнено" value={t.done} accent={theme.success} />
        <Metric theme={theme} label="В работе" value={t.open} accent={theme.warning} />
        <Metric theme={theme} label="Просрочено" value={t.overdue} accent={theme.danger}
          hint="Показать просроченные задачи"
          onClick={() => openUser(currentUser.id, "assigned", { status: "overdue" })} />
        <Metric theme={theme} label="Срок на неделе" value={t.dueSoon} accent={theme.accent2} />
        <Metric theme={theme} label="Без срока" value={t.noDueDate} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        {/* динамика */}
        <Panel theme={theme} title="Динамика по неделям" mono="// created vs done">
          {weekData.length === 0 ? (
            <Empty theme={theme} />
          ) : (
            <ResponsiveContainer width="100%" height={230}>
              <LineChart data={weekData}>
                <CartesianGrid strokeDasharray="3 3" stroke={theme.border} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: theme.textMuted }} />
                <YAxis tick={{ fontSize: 11, fill: theme.textMuted }} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="Создано" stroke={theme.accent} strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="Выполнено" stroke={theme.success} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Panel>

        {/* приоритеты */}
        <Panel theme={theme} title="По приоритетам" mono="// priority">
          {priorityData.length === 0 ? (
            <Empty theme={theme} />
          ) : (
            <ResponsiveContainer width="100%" height={230}>
              <PieChart>
                <Pie data={priorityData} dataKey="value" nameKey="name"
                  cx="50%" cy="50%" outerRadius={80} innerRadius={45}
                  label={({ name, value }) => `${name}: ${value}`}
                  labelLine={false} style={{ fontSize: 11 }}>
                  {priorityData.map((_, i) => (
                    <Cell key={i} fill={chartColors[i % chartColors.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Panel>
      </div>

      {/* по проектам */}
      <Panel theme={theme} title="По проектам" mono="// boards" className="mb-4">
        {boardData.length === 0 ? (
          <Empty theme={theme} />
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(200, boardData.length * 42)}>
            <BarChart data={boardData} layout="vertical" margin={{ left: 12 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={theme.border} />
              <XAxis type="number" tick={{ fontSize: 11, fill: theme.textMuted }} allowDecimals={false} />
              <YAxis type="category" dataKey="name" width={130}
                tick={{ fontSize: 11, fill: theme.textMuted }} />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="Выполнено" stackId="a" fill={theme.success} radius={[0, 0, 0, 0]} />
              <Bar dataKey="Просрочено" stackId="a" fill={theme.danger} />
              <Bar dataKey="Всего" fill={theme.accent} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </Panel>

      {/* по исполнителям */}
      <Panel theme={theme} title="Нагрузка по исполнителям"
        mono="// нажмите на строку — откроются задачи">
        {(data.byAssignee || []).length === 0 ? (
          <Empty theme={theme} />
        ) : (
          <div>
            {data.byAssignee.map((a) => {
              const u = resolveUser(directory, a.userId);
              const pct = a.total ? Math.round((a.done / a.total) * 100) : 0;
              return (
                <button key={a.userId} onClick={() => openUser(a.userId, "assigned")}
                  style={{ background: theme.surfaceAlt, border: `1px solid ${theme.border}` }}
                  className="w-full rounded-xl p-2.5 mb-1.5 flex items-center gap-2.5 text-left hover:opacity-90">
                  <Avatar user={u} size={30} theme={theme} />
                  <div className="min-w-0 flex-1">
                    <div style={{ color: theme.text }} className="text-[13px] font-medium truncate">
                      {u.fullName}
                    </div>
                    <div style={{ background: theme.border }}
                      className="h-1.5 rounded-full overflow-hidden mt-1.5">
                      <div style={{ width: `${pct}%`, background: theme.success }} className="h-full" />
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div style={{ color: theme.text }} className="text-[13px] font-semibold">
                      {a.total}
                    </div>
                    <div className="mono text-[10px]" style={{ color: theme.textMuted }}>
                      {a.done} готово
                      {a.overdue > 0 && (
                        <span style={{ color: theme.danger }}> · {a.overdue} просроч.</span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Panel>

      {userTasks && (
        <UserTasksModal theme={theme} data={userTasks} onClose={() => setUserTasks(null)}
          onOpenTask={(id) => { setUserTasks(null); onOpenTask(id); }} />
      )}
    </div>
  );
}

function Metric({ theme, icon: Icon, label, value, accent, hint, onClick }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag onClick={onClick} title={hint}
      style={{ background: theme.surface, border: `1px solid ${theme.border}` }}
      className={`rounded-2xl p-3 text-left ${onClick ? "hover:opacity-90" : ""}`}>
      <div className="flex items-center gap-1.5 mb-1">
        {Icon && <Icon size={13} style={{ color: accent || theme.textMuted }} />}
        <span className="mono text-[10px] uppercase tracking-wider truncate"
          style={{ color: theme.textMuted }}>{label}</span>
      </div>
      <div style={{ color: accent || theme.text, fontFamily: "Manrope, sans-serif" }}
        className="text-[24px] font-extrabold leading-none">
        {value}
      </div>
    </Tag>
  );
}

function Panel({ theme, title, mono, children, className = "" }) {
  return (
    <div style={{ background: theme.surface, border: `1px solid ${theme.border}` }}
      className={`rounded-2xl p-4 ${className}`}>
      <div className="flex items-baseline justify-between mb-3 gap-2">
        <h3 style={{ color: theme.text, fontFamily: "Manrope, sans-serif" }}
          className="font-bold text-[14px]">{title}</h3>
        {mono && (
          <span className="mono text-[10px] truncate" style={{ color: theme.textMuted }}>{mono}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function Empty({ theme }) {
  return (
    <p style={{ color: theme.textMuted }} className="text-[13px] text-center py-10">
      За выбранный период данных нет.
    </p>
  );
}

function UserTasksModal({ theme, data, onClose, onOpenTask }) {
  const { user, kind, tasks } = data;
  return (
    <Modal theme={theme} onClose={onClose} width="max-w-lg" padded={false}>
      <div className="p-5 pb-3">
        <ModalHeader theme={theme} onClose={onClose}
          title={user.fullName}
          subtitle={
            (kind === "created" ? "Поручено другим" :
             kind === "granted" ? "Открыт доступ" : "Назначено задач") +
            `: ${tasks.length}` +
            (data.override?.status === "overdue" ? " · только просроченные" : "")
          } />
      </div>
      <div style={{ borderColor: theme.border }}
        className="border-t max-h-[55vh] overflow-y-auto px-3 py-2">
        {tasks.map((t) => (
          <button key={t.id} onClick={() => onOpenTask(t.id)}
            style={{ background: theme.surfaceAlt, border: `1px solid ${theme.border}` }}
            className="w-full rounded-xl p-2.5 mb-1.5 text-left flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div style={{
                color: theme.text,
                textDecoration: t.completed ? "line-through" : "none",
                opacity: t.completed ? 0.65 : 1,
              }} className="text-[12.5px] font-medium truncate">
                {t.title}
              </div>
              <div style={{ color: theme.textMuted }} className="text-[11px] truncate">
                {t.boardTitle} · {PRIORITIES[t.priority]?.label || t.priority}
              </div>
            </div>
            {t.dueDate && (
              <span className="mono text-[10.5px] shrink-0"
                style={{ color: dueColor(t.dueDate, t.completed, theme) || theme.textMuted }}>
                {fmtDate(t.dueDate)}
              </span>
            )}
          </button>
        ))}
        {tasks.length === 0 && (
          <p style={{ color: theme.textMuted }} className="text-[13px] text-center py-8">
            Задач нет.
          </p>
        )}
      </div>
    </Modal>
  );
}
