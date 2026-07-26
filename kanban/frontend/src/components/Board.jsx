import React, { useRef, useState } from "react";
import {
  Plus, MessageSquare, Paperclip, Calendar, AlertTriangle, ListChecks,
  Settings, Share2, Check, Users,
} from "lucide-react";
import { PRIORITIES, fmtDate, isOverdue, plural, resolveUser, taskColorFill } from "../lib/theme.js";
import { Avatar } from "../lib/ui.jsx";

export function TaskCard({ task, theme, directory, onOpen, draggable, dragging, onDragStart, onDragEnd, onHover, sourceLabel, showAuthor }) {
  const assignees = task.assignees.map((id) => resolveUser(directory, id));
  const hasDeleted = assignees.some((u) => u.deleted);
  const completed = Boolean(task.completedAt);
  const overdue = isOverdue(task.dueDate, completed);
  const pr = PRIORITIES[task.priority] || PRIORITIES.medium;
  const stepsDone = task.steps.filter((s) => s.done).length;
  const author = showAuthor ? resolveUser(directory, task.createdBy) : null;
  const fill = taskColorFill(task.color, theme);

  const handleDragOver = (e) => {
    if (!draggable) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    onHover(task.columnId, task.position + (after ? 1 : 0));
  };

  return (
    <article
      draggable={draggable}
      onDragStart={(e) => {
        if (!draggable) return;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", task.id);
        onDragStart(task.id);
      }}
      onDragEnd={onDragEnd}
      onDragOver={handleDragOver}
      onClick={() => onOpen(task.id)}
      style={{
        // Цветная заливка кладётся поверх обычного фона карточки, а не
        // вместо него: сплошной цвет сделал бы текст нечитаемым, а
        // полупрозрачный слой сохраняет контраст в любой теме.
        background: fill
          ? `linear-gradient(${fill}, ${fill}), ${theme.surface}`
          : theme.surface,
        border: `1px solid ${fill ? "transparent" : theme.border}`,
        boxShadow: fill ? `inset 0 0 0 1px ${theme.border}` : undefined,
        opacity: dragging === task.id ? 0.35 : completed ? 0.75 : 1,
      }}
      className={`rounded-xl p-3 mb-2 shadow-sm hover:shadow-md transition-shadow ${draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}`}
    >
      <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
        <span style={{ background: theme[pr.color] }} className="w-1.5 h-1.5 rounded-full" />
        <span style={{ color: theme.textMuted }} className="text-[10.5px] uppercase tracking-wide font-medium">{pr.label}</span>
        {sourceLabel && (
          <span style={{ background: theme.surfaceAlt, color: theme.textMuted }} className="text-[10px] px-1.5 py-0.5 rounded">{sourceLabel}</span>
        )}
        {completed && <Check size={12} style={{ color: theme.success }} />}
        {overdue && (
          <span style={{ color: theme.danger }} className="ml-auto flex items-center gap-0.5 text-[10.5px] font-medium">
            <AlertTriangle size={11} /> просрочено
          </span>
        )}
      </div>

      <h4 style={{ color: theme.text, textDecoration: completed ? "line-through" : "none" }} className="text-[13.5px] font-medium leading-snug mb-2">
        {task.title}
      </h4>

      {author && (
        <div className="flex items-center gap-1.5 mb-2">
          <Avatar user={author} size={16} theme={theme} />
          <span style={{ color: theme.textMuted }} className="text-[11px] truncate">
            Поставил{author.fullName?.endsWith("а") ? "а" : ""}: {author.fullName}
          </span>
        </div>
      )}

      {task.tags?.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {task.tags.map((t) => (
            <span key={t} style={{ background: theme.surfaceAlt, color: theme.textMuted }} className="text-[10.5px] px-1.5 py-0.5 rounded-md">#{t}</span>
          ))}
        </div>
      )}

      {task.steps.length > 0 && (
        <div style={{ color: theme.textMuted }} className="flex items-center gap-1 text-[11px] mb-2">
          <ListChecks size={12} />
          {stepsDone}/{task.steps.length}
          <span style={{ background: theme.surfaceAlt }} className="flex-1 h-1 rounded-full ml-1 overflow-hidden">
            <span style={{ width: `${(stepsDone / task.steps.length) * 100}%`, background: theme.accent }} className="block h-full" />
          </span>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 min-w-0">
          <div className="flex -space-x-1.5">
            {assignees.slice(0, 3).map((u, i) => (
              <span key={`${u.id}-${i}`} style={{ boxShadow: `0 0 0 2px ${theme.surface}`, borderRadius: 999 }}>
                <Avatar user={u} size={22} theme={theme} />
              </span>
            ))}
            {assignees.length > 3 && (
              <span style={{ background: theme.surfaceAlt, color: theme.textMuted, boxShadow: `0 0 0 2px ${theme.surface}` }}
                className="w-[22px] h-[22px] rounded-full flex items-center justify-center text-[10px] font-medium">
                +{assignees.length - 3}
              </span>
            )}
          </div>
          {hasDeleted && (
            <span title="Среди исполнителей есть удалённая учётная запись" style={{ color: theme.warning }}><AlertTriangle size={12} /></span>
          )}
        </div>

        <div style={{ color: theme.textMuted }} className="flex items-center gap-2 text-[11px] shrink-0">
          {task.grants?.length > 0 && <Share2 size={12} title="Есть внешние участники" />}
          {task.commentCount > 0 && <span className="flex items-center gap-0.5"><MessageSquare size={12} />{task.commentCount}</span>}
          {task.attachmentCount > 0 && <span className="flex items-center gap-0.5"><Paperclip size={12} />{task.attachmentCount}</span>}
          {task.dueDate && (
            <span style={{ color: overdue ? theme.danger : theme.textMuted }} className="flex items-center gap-0.5 font-medium">
              <Calendar size={12} />{fmtDate(task.dueDate)}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

export function Column({ column, tasks, theme, directory, canEdit, dragging, dropTarget, onOpen, onDragStart, onDragEnd, onHover, onDrop, onQuickAdd, onSettings }) {
  const count = tasks.length;
  const overLimit = column.wipLimit > 0 && count > column.wipLimit;
  const load = column.wipLimit > 0 ? Math.min(1, count / column.wipLimit) : 0;
  const isTarget = dropTarget?.columnId === column.id;

  const handleDragOver = (e) => {
    if (!canEdit) return;
    e.preventDefault();
    onHover(column.id, count);
  };

  const insertionLine = (index) =>
    isTarget && dropTarget.index === index ? <div style={{ background: theme.accent }} className="h-[2px] rounded-full my-1" /> : null;

  return (
    <section
      onDragOver={handleDragOver}
      onDrop={(e) => { e.preventDefault(); onDrop(column.id); }}
      style={{ background: theme.surfaceAlt, border: `1px solid ${isTarget && dragging ? theme.accent : theme.border}` }}
      className="rounded-2xl flex flex-col w-[280px] shrink-0 max-h-full transition-colors"
    >
      <header className="px-3 pt-3 pb-2">
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-2 min-w-0">
            <span style={{ background: column.color }} className="w-2 h-2 rounded-full shrink-0" />
            <h3 style={{ color: theme.text, fontFamily: "Space Grotesk, sans-serif" }} className="font-semibold text-[13.5px] truncate">{column.title}</h3>
            {column.isDone && <Check size={12} style={{ color: theme.success }} title="Колонка завершения" />}
          </div>
          {canEdit && <button onClick={onSettings} style={{ color: theme.textMuted }} title="Настроить колонки"><Settings size={13} /></button>}
        </div>

        <div className="flex items-center justify-between gap-2">
          <span style={{ color: theme.textMuted }} className="text-[11.5px]">{plural(count, "задача", "задачи", "задач")}</span>
          {column.wipLimit > 0 && (
            <span style={{ color: overLimit ? theme.danger : theme.textMuted }} className="text-[11.5px] font-medium" title={`Не больше ${column.wipLimit} задач одновременно`}>
              предел {column.wipLimit}
            </span>
          )}
        </div>

        {column.wipLimit > 0 && (
          <div style={{ background: theme.border }} className="h-[3px] rounded-full overflow-hidden mt-1.5">
            <div style={{ width: `${load * 100}%`, background: overLimit ? theme.danger : column.color }} className="h-full transition-all" />
          </div>
        )}
      </header>

      <div className="px-2 pb-2 overflow-y-auto flex-1 min-h-[60px]">
        {insertionLine(0)}
        {tasks.map((t, i) => (
          <React.Fragment key={t.id}>
            <TaskCard task={t} theme={theme} directory={directory} onOpen={onOpen} draggable={canEdit}
              dragging={dragging} onDragStart={onDragStart} onDragEnd={onDragEnd} onHover={onHover} />
            {insertionLine(i + 1)}
          </React.Fragment>
        ))}

        {count === 0 && (
          <div style={{ color: theme.textMuted, borderColor: isTarget && dragging ? theme.accent : theme.border }}
            className="text-[12px] text-center py-7 border border-dashed rounded-xl transition-colors">
            {canEdit ? "Перетащите задачу сюда" : "Пусто"}
          </div>
        )}
      </div>

      {canEdit && (
        <button onClick={() => onQuickAdd(column.id)} style={{ color: theme.textMuted }} className="flex items-center gap-1.5 px-3 py-2.5 text-[12.5px] font-medium hover:opacity-80">
          <Plus size={14} /> Добавить задачу
        </button>
      )}
    </section>
  );
}

export function BoardView({ columns, tasks, theme, directory, canEdit, canManage, hideCompleted, onOpenTask, onMove, onQuickAdd, onSettings, onShowCompleted }) {
  const [dragging, setDragging] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const target = useRef(null);

  const hover = (columnId, index) => {
    target.current = { columnId, index };
    setDropTarget((prev) => (prev?.columnId === columnId && prev?.index === index ? prev : { columnId, index }));
  };

  const finish = () => {
    setDragging(null);
    setDropTarget(null);
    target.current = null;
  };

  const drop = (fallbackColumnId) => {
    const taskId = dragging;
    const t = target.current || { columnId: fallbackColumnId, index: 0 };
    finish();
    if (taskId) onMove(taskId, t.columnId, t.index);
  };

  const visibleColumns = columns.filter((c) => !(hideCompleted && c.isDone));
  const hiddenCount = hideCompleted ? tasks.filter((t) => columns.find((c) => c.id === t.columnId)?.isDone).length : 0;

  return (
    <>
      {hiddenCount > 0 && (
        <button onClick={onShowCompleted} style={{ background: theme.surface, color: theme.textMuted, border: `1px solid ${theme.border}` }}
          className="mb-3 flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-lg">
          Скрыто завершённых: {hiddenCount}. Показать
        </button>
      )}

      <div className="flex gap-3 h-full items-start pb-2">
        {visibleColumns.map((col) => (
          <Column key={col.id} column={col}
            tasks={tasks.filter((t) => t.columnId === col.id).sort((a, b) => a.position - b.position)}
            theme={theme} directory={directory} canEdit={canEdit} dragging={dragging} dropTarget={dropTarget}
            onOpen={onOpenTask} onDragStart={setDragging} onDragEnd={finish} onHover={hover} onDrop={drop}
            onQuickAdd={onQuickAdd} onSettings={onSettings} />
        ))}

        {canManage && (
          <button onClick={onSettings} style={{ border: `1px dashed ${theme.border}`, color: theme.textMuted, background: theme.surfaceAlt }}
            className="w-[280px] shrink-0 rounded-2xl py-4 flex items-center justify-center gap-1.5 text-[12.5px] font-medium">
            <Plus size={14} /> Добавить колонку
          </button>
        )}
      </div>
    </>
  );
}

export function InboxView({ tasks, theme, directory, onOpenTask }) {
  const groups = Object.entries(
    tasks.reduce((acc, t) => {
      (acc[t.boardTitle || "Без проекта"] ||= []).push(t);
      return acc;
    }, {})
  );

  if (groups.length === 0) {
    return (
      <div className="max-w-md mx-auto text-center py-16">
        <Users size={30} style={{ color: theme.textMuted }} className="mx-auto mb-3" />
        <h3 style={{ color: theme.text, fontFamily: "Space Grotesk, sans-serif" }} className="font-semibold text-[16px] mb-1.5">Входящих задач нет</h3>
        <p style={{ color: theme.textMuted }} className="text-[13px] leading-relaxed">
          Сюда попадают задачи из чужих проектов, к которым вам открыли доступ точечно, — без доступа к остальной доске.
        </p>
      </div>
    );
  }

  return (
    <>
      <p style={{ color: theme.textMuted }} className="text-[12.5px] leading-relaxed mb-3 max-w-2xl">
        Задачи из проектов, участником которых вы не являетесь. Колонки здесь — проекты-источники, а не статусы.
        У каждой карточки указан автор — кто именно поставил задачу.
      </p>
      <div className="flex gap-3 items-start pb-2">
        {groups.map(([title, list]) => (
          <section key={title} style={{ background: theme.surfaceAlt, border: `1px solid ${theme.border}` }} className="rounded-2xl w-[300px] shrink-0 flex flex-col max-h-full">
            <header className="px-3 pt-3 pb-2 flex items-center justify-between">
              <h3 style={{ color: theme.text, fontFamily: "Space Grotesk, sans-serif" }} className="font-semibold text-[13.5px] truncate">{title}</h3>
              <span style={{ color: theme.textMuted }} className="text-[11.5px]">{plural(list.length, "задача", "задачи", "задач")}</span>
            </header>
            <div className="px-2 pb-2 overflow-y-auto">
              {list.map((t) => (
                <TaskCard key={t.id} task={t} theme={theme} directory={directory} onOpen={onOpenTask}
                  draggable={false} dragging={null} onDragStart={() => {}} onDragEnd={() => {}} onHover={() => {}}
                  sourceLabel={t.access === "read" ? "просмотр" : "участие"} showAuthor />
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
