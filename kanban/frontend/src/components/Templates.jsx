import React, { useEffect, useState } from "react";
import { Plus, Trash2, Zap, ListChecks } from "lucide-react";
import { api } from "../lib/api.js";
import { PRIORITIES, TASK_COLORS, resolveUser, plural } from "../lib/theme.js";
import { Avatar, Modal, ModalHeader, Field, ConfirmDialog, inputStyle } from "../lib/ui.jsx";

// Шаблоны заменяют цикличные задачи: экземпляр появляется по действию
// человека, а не сам по расписанию, поэтому мусора не накапливается.
export default function Templates({
  theme, directory, team, boardId, boardTitle, columns, onClose, onError, onInfo, onCreated,
}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [applying, setApplying] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      setItems(await api.templates());
    } catch (e) {
      onError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = async (tpl, columnId) => {
    try {
      const task = await api.applyTemplate(tpl.id, boardId, columnId);
      onInfo(`Задача «${task.title}» создана`);
      setApplying(null);
      onCreated(task);
      onClose();
    } catch (e) {
      onError(e.message);
    }
  };

  const remove = (tpl) => setConfirm({
    title: "Удалить шаблон?",
    message: `Шаблон «${tpl.name}» будет удалён. Созданные по нему задачи останутся.`,
    confirmLabel: "Удалить",
    onConfirm: async () => {
      setConfirm(null);
      try {
        await api.deleteTemplate(tpl.id);
        load();
      } catch (e) {
        onError(e.message);
      }
    },
  });

  return (
    <Modal theme={theme} onClose={onClose} width="max-w-md" padded={false}>
      <div className="p-5 pb-3">
        <ModalHeader theme={theme} title="Шаблоны задач"
          subtitle={boardTitle ? `Создание в проекте «${boardTitle}»` : "Заготовки для повторяющихся работ"}
          onClose={onClose}
          extra={
            <button onClick={() => setAdding(true)}
              style={{ background: theme.accent, color: theme.accentText }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold">
              <Plus size={13} /> Создать
            </button>
          } />
      </div>

      <div style={{ borderColor: theme.border }} className="border-t max-h-[55vh] overflow-y-auto px-3 py-2">
        {loading && <p style={{ color: theme.textMuted }} className="text-[13px] py-6 text-center">Загружаем…</p>}

        {!loading && items.map((tpl) => (
          <div key={tpl.id}
            style={{ background: theme.surfaceAlt, border: `1px solid ${theme.border}` }}
            className="rounded-xl p-2.5 mb-1.5">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div style={{ color: theme.text }} className="text-[13px] font-medium truncate">
                  {tpl.name}
                </div>
                <div style={{ color: theme.textMuted }} className="text-[11px] truncate">
                  {PRIORITIES[tpl.priority]?.label || tpl.priority}
                  {tpl.dueInDays != null && ` · срок +${plural(tpl.dueInDays, "день", "дня", "дней")}`}
                  {tpl.steps?.length > 0 && ` · ${plural(tpl.steps.length, "пункт", "пункта", "пунктов")}`}
                  {!tpl.boardId && " · личный"}
                </div>
              </div>

              <div className="flex -space-x-1.5 shrink-0">
                {(tpl.assignees || []).slice(0, 3).map((id) => (
                  <span key={id} style={{ boxShadow: `0 0 0 2px ${theme.surfaceAlt}`, borderRadius: 999 }}>
                    <Avatar user={resolveUser(directory, id)} size={20} theme={theme} />
                  </span>
                ))}
              </div>

              <button onClick={() => setApplying(tpl)}
                style={{ background: theme.accent, color: theme.accentText }}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11.5px] font-semibold shrink-0"
                disabled={!boardId} title={boardId ? "Создать задачу" : "Откройте проект"}>
                <Zap size={12} /> Создать
              </button>
              <button onClick={() => remove(tpl)} style={{ color: theme.danger }} className="p-1 shrink-0">
                <Trash2 size={13} />
              </button>
            </div>

            {/* Выбор колонки показывается только при применении: в
                обычном списке он занял бы место без пользы. */}
            {applying?.id === tpl.id && (
              <div className="flex flex-wrap gap-1.5 mt-2 pt-2"
                style={{ borderTop: `1px solid ${theme.border}` }}>
                <span className="mono text-[10px] uppercase self-center mr-1"
                  style={{ color: theme.textMuted }}>в колонку:</span>
                {columns.map((c) => (
                  <button key={c.id} onClick={() => apply(tpl, c.id)}
                    style={{ background: theme.surface, color: theme.text, border: `1px solid ${theme.border}` }}
                    className="px-2 py-1 rounded-lg text-[11.5px]">
                    {c.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}

        {!loading && items.length === 0 && (
          <p style={{ color: theme.textMuted }} className="text-[13px] text-center py-8 px-4 leading-relaxed">
            Шаблонов нет. Они пригодятся для повторяющихся работ: набор пунктов
            чек-листа, исполнители и срок заводятся одним нажатием.
          </p>
        )}
      </div>

      {adding && (
        <TemplateForm theme={theme} directory={directory} team={team}
          boardId={boardId} boardTitle={boardTitle}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); load(); onInfo("Шаблон создан"); }}
          onError={onError} />
      )}

      {confirm && <ConfirmDialog theme={theme} {...confirm} onCancel={() => setConfirm(null)} />}
    </Modal>
  );
}

function TemplateForm({ theme, directory, team, boardId, boardTitle, onClose, onSaved, onError }) {
  const [form, setForm] = useState({
    name: "", title: "", description: "", priority: "normal", color: "none",
    dueInDays: "", stepsText: "", assignees: [], shared: Boolean(boardId),
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!form.name.trim()) return onError("Укажите название шаблона");
    setBusy(true);
    try {
      await api.createTemplate({
        // Общий шаблон привязан к проекту и виден его участникам;
        // личный доступен только автору в любом проекте.
        boardId: form.shared && boardId ? boardId : null,
        name: form.name.trim(),
        title: form.title.trim() || form.name.trim(),
        description: form.description,
        priority: form.priority,
        color: form.color,
        tags: [],
        dueInDays: form.dueInDays === "" ? null : Number(form.dueInDays),
        steps: form.stepsText.split("\n").map((x) => x.trim()).filter(Boolean),
        assignees: form.assignees,
      });
      onSaved();
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const candidates = team.map((id) => resolveUser(directory, id)).filter((u) => !u.deleted);

  return (
    <Modal theme={theme} onClose={onClose} width="max-w-sm">
      <ModalHeader theme={theme} title="Новый шаблон" onClose={onClose} />

      <Field label="Название шаблона" theme={theme} hint="Видно только в списке шаблонов">
        <input value={form.name} onChange={(e) => set("name", e.target.value)} autoFocus
          placeholder="например, Еженедельный отчёт" style={inputStyle(theme)}
          className="w-full rounded-lg px-3 py-2 text-[13.5px] outline-none" />
      </Field>

      <Field label="Название задачи" theme={theme} hint="Пусто — возьмётся название шаблона">
        <input value={form.title} onChange={(e) => set("title", e.target.value)}
          style={inputStyle(theme)} className="w-full rounded-lg px-3 py-2 text-[13px] outline-none" />
      </Field>

      <Field label="Описание" theme={theme}>
        <textarea value={form.description} onChange={(e) => set("description", e.target.value)} rows={2}
          style={inputStyle(theme)} className="w-full rounded-lg px-3 py-2 text-[13px] outline-none resize-none" />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Приоритет" theme={theme}>
          <select value={form.priority} onChange={(e) => set("priority", e.target.value)}
            style={inputStyle(theme)} className="w-full rounded-lg px-2 py-2 text-[13px] outline-none">
            {Object.entries(PRIORITIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </Field>
        <Field label="Срок, дней" theme={theme} hint="От дня создания">
          <input type="number" min="0" value={form.dueInDays}
            onChange={(e) => set("dueInDays", e.target.value)} placeholder="без срока"
            style={inputStyle(theme)} className="w-full rounded-lg px-3 py-2 text-[13px] outline-none" />
        </Field>
      </div>

      <Field label="Чек-лист" theme={theme} hint="По одному пункту в строке">
        <textarea value={form.stepsText} onChange={(e) => set("stepsText", e.target.value)} rows={4}
          placeholder={"Собрать данные\nСогласовать с отделом\nОтправить"}
          style={inputStyle(theme)} className="w-full rounded-lg px-3 py-2 text-[13px] outline-none resize-none" />
      </Field>

      {candidates.length > 0 && (
        <Field label="Исполнители по умолчанию" theme={theme}>
          <div className="flex flex-wrap gap-1.5">
            {candidates.map((u) => {
              const active = form.assignees.includes(u.id);
              return (
                <button key={u.id}
                  onClick={() => set("assignees", active
                    ? form.assignees.filter((a) => a !== u.id)
                    : [...form.assignees, u.id])}
                  style={{
                    background: active ? theme.accent : theme.surfaceAlt,
                    color: active ? theme.accentText : theme.text,
                    border: `1px solid ${theme.border}`,
                  }}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-full text-[12px] font-medium">
                  <Avatar user={u} size={16} theme={theme} />{u.fullName.split(" ")[0]}
                </button>
              );
            })}
          </div>
        </Field>
      )}

      {boardId && (
        <label style={{ color: theme.textMuted }} className="flex items-center gap-2 text-[12.5px] mb-3">
          <input type="checkbox" checked={form.shared}
            onChange={(e) => set("shared", e.target.checked)} />
          Общий для проекта «{boardTitle}» — иначе шаблон будет виден только вам
        </label>
      )}

      <button onClick={submit} disabled={busy}
        style={{ background: theme.accent, color: theme.accentText }}
        className="w-full rounded-lg py-2.5 text-[13.5px] font-semibold disabled:opacity-50">
        {busy ? "Сохраняем…" : "Создать шаблон"}
      </button>
    </Modal>
  );
}
