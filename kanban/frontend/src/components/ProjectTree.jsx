import React, { useMemo, useState } from "react";
import { ChevronRight, ChevronDown, Plus, Eye, GripVertical, Inbox, LayoutGrid, CalendarDays } from "lucide-react";
import { ROLE_LABEL, bgById, resolveUser } from "../lib/theme.js";

const OPEN_KEY = "kanban.treeOpen";

// Собирает плоский список проектов в дерево.
//
// Ключевое правило: если родитель недоступен текущему пользователю, узел
// поднимается на верхний уровень. Проверять это на сервере рекурсивным
// запросом с правами на каждом уровне заметно дороже, а результат тот
// же — сервер отдаёт parentId как есть, разрыв разбирается здесь.
function buildTree(boards) {
  const byId = new Map(boards.map((b) => [b.id, b]));
  const children = new Map();

  for (const b of boards) {
    const parentVisible = b.parentId && byId.has(b.parentId);
    const key = parentVisible ? b.parentId : "__root__";
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(b);
  }

  for (const list of children.values()) {
    list.sort((a, b) => (a.position - b.position) || a.title.localeCompare(b.title, "ru"));
  }

  const walk = (key, depth) =>
    (children.get(key) || []).flatMap((b) => [
      { ...b, depth, hasChildren: (children.get(b.id) || []).length > 0 },
      ...walk(b.id, depth + 1),
    ]);

  return walk("__root__", 0);
}

export default function ProjectTree({
  theme, boards, directory, activeId, isInbox, isDashboard, isCalendar,
  onSelect, onSelectInbox, onSelectDashboard, onSelectCalendar, onCreate, onMove, canReorder,
}) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || "[]"));
    } catch {
      return new Set();
    }
  });
  const [dragId, setDragId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null); // { id, mode: "into" | "before" }

  const flat = useMemo(() => buildTree(boards), [boards]);

  // Свёрнутый узел прячет всё поддерево, а не только прямых потомков.
  const hiddenIds = useMemo(() => {
    const hidden = new Set();
    for (const node of flat) {
      if (hidden.has(node.parentId) || collapsed.has(node.parentId)) {
        hidden.add(node.id);
      }
    }
    return hidden;
  }, [flat, collapsed]);

  const toggle = (id) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  // Три зоны по высоте строки вместо двух.
  //
  // Раньше их было две — «перед» и «внутрь», — и из-за этого нельзя
  // было ни поменять подпроект местами с родителем (место «после
  // родителя на его уровне» просто не выражалось), ни вынести узел
  // на уровень выше. Нижняя четверть теперь означает «после, на том же
  // уровне», а отдельная зона в конце списка — «в корень».
  const handleDragOver = (e, node) => {
    if (!canReorder || !dragId || dragId === node.id) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const offset = e.clientY - rect.top;
    let mode;
    if (offset < rect.height * 0.28) mode = "before";
    else if (offset > rect.height * 0.72) mode = "after";
    else mode = "into";
    setDropTarget({ id: node.id, mode });
  };

  const handleDrop = (e, node) => {
    e.preventDefault();
    const source = dragId;
    const target = dropTarget;
    setDragId(null);
    setDropTarget(null);
    if (!source || !target || source === node.id) return;

    if (target.mode === "into") {
      onMove(source, { parentId: node.id });
    } else if (target.mode === "after") {
      // На уровень цели, сразу за ней. Именно это позволяет вытащить
      // подпроект наверх и поставить его рядом с бывшим родителем.
      onMove(source, { parentId: node.parentId || null, position: node.position + 1 });
    } else {
      onMove(source, { parentId: node.parentId || null, position: node.position });
    }
  };

  // Отдельная зона: положить проект в корень дерева. Без неё вынести
  // единственный вложенный проект наверх было невозможно — не на что
  // навести курсор.
  const handleRootDrop = (e) => {
    e.preventDefault();
    const source = dragId;
    setDragId(null);
    setDropTarget(null);
    if (source) onMove(source, { parentId: null });
  };

  return (
    <div className="p-1.5">
      <button onClick={onSelectDashboard}
        style={{ background: isDashboard ? theme.surfaceAlt : "transparent", color: theme.text }}
        className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[13px] mb-0.5">
        <LayoutGrid size={15} style={{ color: theme.accent }} />
        <span className="flex-1 text-left font-medium">Сводка</span>
      </button>

      <button onClick={onSelectCalendar}
        style={{ background: isCalendar ? theme.surfaceAlt : "transparent", color: theme.text }}
        className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[13px] mb-0.5">
        <CalendarDays size={15} style={{ color: theme.accent }} />
        <span className="flex-1 text-left font-medium">Календарь</span>
      </button>

      <button onClick={onSelectInbox}
        style={{ background: isInbox ? theme.surfaceAlt : "transparent", color: theme.text }}
        className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[13px] mb-1">
        <Inbox size={15} style={{ color: theme.accent }} />
        <span className="flex-1 text-left font-medium">Входящие</span>
      </button>

      <div className="mono text-[10px] uppercase tracking-wider px-2.5 py-1.5"
        style={{ color: theme.textMuted }}>
        // проекты{canReorder ? " · перетащите для сортировки" : ""}
      </div>

      {flat.filter((n) => !hiddenIds.has(n.id)).map((node) => {
        const isTarget = dropTarget?.id === node.id;
        const author = resolveUser(directory, node.createdBy);
        return (
          <div key={node.id}>
            {isTarget && dropTarget.mode === "after" && null}
            {isTarget && dropTarget.mode === "before" && (
              <div style={{ background: theme.accent, marginLeft: 10 + node.depth * 14 }}
                className="h-[2px] rounded-full my-0.5" />
            )}
            <div
              draggable={canReorder}
              onDragStart={() => setDragId(node.id)}
              onDragEnd={() => { setDragId(null); setDropTarget(null); }}
              onDragOver={(e) => handleDragOver(e, node)}
              onDrop={(e) => handleDrop(e, node)}
              style={{
                background: node.id === activeId ? theme.surfaceAlt
                  : isTarget && dropTarget.mode === "into" ? theme.surfaceAlt : "transparent",
                border: `1px solid ${isTarget && dropTarget.mode === "into" ? theme.accent : "transparent"}`,
                opacity: dragId === node.id ? 0.4 : 1,
                paddingLeft: 6 + node.depth * 14,
              }}
              className="w-full flex items-center gap-1 pr-2 py-1.5 rounded-lg group">
              {node.hasChildren ? (
                <button onClick={() => toggle(node.id)} style={{ color: theme.textMuted }}
                  className="p-0.5 shrink-0"
                  title={collapsed.has(node.id) ? "Развернуть" : "Свернуть"}>
                  {collapsed.has(node.id) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                </button>
              ) : (
                <span className="w-[18px] shrink-0" />
              )}

              <button onClick={() => onSelect(node.id)}
                className="flex-1 min-w-0 flex items-center gap-2 text-left">
                <span style={{ background: bgById(node.bgPreset)?.css || theme.border }}
                  className="w-2 h-5 rounded shrink-0" />
                <span className="flex-1 min-w-0">
                  <span style={{ color: theme.text }} className="text-[12.5px] font-medium block truncate">
                    {node.title}
                  </span>
                  <span style={{ color: theme.textMuted }} className="text-[10.5px] block truncate">
                    {ROLE_LABEL[node.myRole]}
                    {author && !author.deleted ? ` · ${author.fullName}` : ""}
                  </span>
                </span>
                {node.myRole === "reader" && (
                  <Eye size={12} style={{ color: theme.textMuted }} className="shrink-0" />
                )}
              </button>

              {canReorder && (
                <GripVertical size={12} style={{ color: theme.textMuted }}
                  className="opacity-0 group-hover:opacity-60 shrink-0 cursor-grab" />
              )}
            </div>
            {isTarget && dropTarget.mode === "after" && (
              <div style={{ background: theme.accent, marginLeft: 10 + node.depth * 14 }}
                className="h-[2px] rounded-full my-0.5" />
            )}
          </div>
        );
      })}

      {canReorder && dragId && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDropTarget({ id: "__root__", mode: "root" }); }}
          onDrop={handleRootDrop}
          style={{
            border: `1px dashed ${dropTarget?.mode === "root" ? theme.accent : theme.border}`,
            color: dropTarget?.mode === "root" ? theme.accent : theme.textMuted,
            background: dropTarget?.mode === "root" ? theme.surfaceAlt : "transparent",
          }}
          className="rounded-lg py-2.5 text-center text-[11.5px] my-1.5 mx-1">
          Отпустите здесь — вынести в корень
        </div>
      )}

      {boards.length === 0 && (
        <p style={{ color: theme.textMuted }} className="text-[12.5px] px-2.5 py-2">
          Проектов пока нет.
        </p>
      )}

      <div style={{ borderColor: theme.border }} className="border-t mt-1.5 pt-1.5">
        <button onClick={onCreate} style={{ color: theme.accent }}
          className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[13px] font-medium">
          <Plus size={14} /> Новый проект
        </button>
      </div>
    </div>
  );
}
