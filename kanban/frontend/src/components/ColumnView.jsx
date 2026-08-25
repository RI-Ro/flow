import React, { useMemo, useState } from "react";
import { ArrowUpDown, Calendar, MessageSquare, Paperclip, Check, AlertTriangle } from "lucide-react";
import { PRIORITIES, fmtDate, resolveUser, dueColor, plural, taskColorFill } from "../lib/theme.js";
import { Avatar, Modal, ModalHeader } from "../lib/ui.jsx";

// Порядок сортировки хранится рядом с прочими настройками вида —
// человек выбирает его один раз под свою манеру работы.
const SORT_KEY = "kanban.columnSort";

const SORTS = [
  { id: "position", label: "Как на доске" },
  { id: "due",      label: "По сроку" },
  { id: "priority", label: "По приоритету" },
  { id: "created",  label: "По дате создания" },
  { id: "title",    label: "По названию" },
];

export default function ColumnView({ theme, column, tasks, directory, onClose, onOpenTask }) {
  const [sort, setSort] = useState(() => localStorage.getItem(SORT_KEY) || "position");

  const setSortMode = (id) => {
    setSort(id);
    localStorage.setItem(SORT_KEY, id);
  };

  const sorted = useMemo(() => {
    const list = [...tasks];
    switch (sort) {
      case "due":
        // Задачи без срока уходят в конец: пустая дата не означает
        // «очень срочно», а при обычной сортировке оказалась бы первой.
        return list.sort((a, b) => {
          if (!a.dueDate && !b.dueDate) return 0;
          if (!a.dueDate) return 1;
          if (!b.dueDate) return -1;
          return a.dueDate.localeCompare(b.dueDate);
        });
      case "priority":
        return list.sort((a, b) =>
          (PRIORITIES[b.priority]?.order || 0) - (PRIORITIES[a.priority]?.order || 0));
      case "created":
        return list.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      case "title":
        return list.sort((a, b) => a.title.localeCompare(b.title, "ru"));
      default:
        return list.sort((a, b) => a.position - b.position);
    }
  }, [tasks, sort]);

  const done = sorted.filter((t) => t.completedAt).length;
  const overdue = sorted.filter(
    (t) => !t.completedAt && t.dueDate && new Date(t.dueDate) < new Date(new Date().toDateString())
  ).length;

  return (
    <Modal theme={theme} onClose={onClose} width="max-w-5xl" padded={false}>
      <div className="p-5 pb-3">
        <ModalHeader theme={theme} onClose={onClose}
          title={
            <span className="flex items-center gap-2">
              <span style={{ background: column.color }} className="w-2.5 h-2.5 rounded-full" />
              {column.title}
            </span>
          }
          subtitle={
            `${plural(sorted.length, "задача", "задачи", "задач")}` +
            (done ? ` · выполнено ${done}` : "") +
            (overdue ? ` · просрочено ${overdue}` : "")
          } />

        <div className="flex items-center gap-1.5 flex-wrap">
          <ArrowUpDown size={13} style={{ color: theme.textMuted }} />
          {SORTS.map((s) => (
            <button key={s.id} onClick={() => setSortMode(s.id)}
              style={{
                background: sort === s.id ? theme.accent : theme.surfaceAlt,
                color: sort === s.id ? theme.accentText : theme.text,
                border: `1px solid ${theme.border}`,
              }}
              className="px-2.5 py-1 rounded-lg text-[11.5px] font-medium">
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ borderColor: theme.border }}
        className="border-t max-h-[62vh] overflow-y-auto px-3 py-2">
        {sorted.map((task) => {
          const assignees = task.assignees.map((id) => resolveUser(directory, id));
          const doneIds = task.assigneesDone || [];
          const completed = Boolean(task.completedAt);
          const tint = dueColor(task.dueDate, completed, theme);
          const fill = taskColorFill(task.color, theme);
          const pr = PRIORITIES[task.priority] || PRIORITIES.normal;

          return (
            <button key={task.id} onClick={() => onOpenTask(task.id)}
              style={{
                background: fill ? `linear-gradient(${fill}, ${fill}), ${theme.surfaceAlt}` : theme.surfaceAlt,
                border: `1px solid ${theme.border}`,
                opacity: completed ? 0.7 : 1,
              }}
              className="w-full rounded-xl p-3 mb-1.5 text-left flex items-center gap-3">
              {/* В развороте колонки места больше, чем на доске,
                  поэтому реквизиты и сроки показываются в одну строку,
                  без переносов и сокращений. */}
              <span className="mono text-[10px] px-1.5 py-0.5 rounded shrink-0 w-[92px] text-center"
                style={{ background: theme.surface, color: theme[pr.color] }}>
                {pr.label}
              </span>

              <div className="min-w-0 flex-1">
                <div style={{
                  color: theme.text,
                  textDecoration: completed ? "line-through" : "none",
                }} className="text-[13px] font-medium truncate">
                  {task.title}
                </div>
                <div style={{ color: theme.textMuted }} className="text-[11px] truncate mt-0.5">
                  {task.incomingNumber && `вх. № ${task.incomingNumber} · `}
                  {task.steps?.length > 0 &&
                    `чек-лист ${task.steps.filter((s) => s.done).length}/${task.steps.length} · `}
                  {task.tags?.length > 0 && task.tags.map((t) => `#${t}`).join(" ")}
                </div>
              </div>

              <div className="flex -space-x-1.5 shrink-0">
                {assignees.slice(0, 4).map((u, i) => (
                  <span key={`${u.id}-${i}`}
                    style={{
                      boxShadow: `0 0 0 2px ${doneIds.includes(u.id) ? theme.success : theme.surfaceAlt}`,
                      borderRadius: 999,
                    }}>
                    <Avatar user={u} size={22} theme={theme} />
                  </span>
                ))}
              </div>

              <div style={{ color: theme.textMuted }}
                className="flex items-center gap-2.5 text-[11px] shrink-0 w-[150px] justify-end">
                {completed && <Check size={13} style={{ color: theme.success }} />}
                {task.commentCount > 0 && (
                  <span className="flex items-center gap-0.5"><MessageSquare size={12} />{task.commentCount}</span>
                )}
                {task.attachmentCount > 0 && (
                  <span className="flex items-center gap-0.5"><Paperclip size={12} />{task.attachmentCount}</span>
                )}
                {task.dueDate && (
                  <span className="flex items-center gap-1 font-medium"
                    style={{ color: tint || theme.textMuted }}>
                    <Calendar size={12} />{fmtDate(task.dueDate)}
                  </span>
                )}
              </div>
            </button>
          );
        })}

        {sorted.length === 0 && (
          <p style={{ color: theme.textMuted }} className="text-[13px] text-center py-12">
            В этой колонке задач нет.
          </p>
        )}
      </div>
    </Modal>
  );
}
