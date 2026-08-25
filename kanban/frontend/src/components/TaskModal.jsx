import React, { useState } from "react";
import { Trash2 } from "lucide-react";
import { PRIORITIES, resolveUser, TASK_COLORS, taskColorFill } from "../lib/theme.js";
import { Avatar, Modal, ModalHeader, Field, inputStyle } from "../lib/ui.jsx";

const today = () => new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

const emptyTask = (columnId) => ({
  title: "", description: "", priority: "normal", color: "none",
  incomingNumber: "", incomingDate: "",
  columnId, dueDate: today(), assignees: [], tags: [],
});

export default function TaskModal({ theme, directory, team, boardMemberIds, columns, initial, onClose, onSave, onRequestDelete, busy }) {
  const [form, setForm] = useState(() => ({
    ...emptyTask(columns[0]?.id),
    ...(initial || {}),
    dueDate: initial?.dueDate || today(),
  }));
  const [tagText, setTagText] = useState((initial?.tags || []).join(", "));
  const [error, setError] = useState("");

  const isEdit = Boolean(initial?.id);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  // Список кандидатов — объединение личной команды, участников проекта
  // и тех, кто уже назначен. Иначе возникала тихая потеря данных:
  // форма отправляет полный список исполнителей, а видел редактор
  // только свою личную команду — все назначенные владельцем люди, не
  // входящие в неё, просто не попадали в отправляемый список и
  // снимались с задачи при первом же сохранении.
  const candidateIds = [...new Set([
    ...team,
    ...(boardMemberIds || []),
    ...(initial?.assignees || []),
  ])];
  const candidates = candidateIds.map((id) => resolveUser(directory, id));

  // Назначенные, которых нет ни в личной команде, ни в проекте —
  // помечаем, чтобы снятие было осознанным действием, а не случайным.
  const outsideMyTeam = new Set(
    (initial?.assignees || []).filter((id) => !team.includes(id))
  );

  const toggleAssignee = (id) =>
    set("assignees", form.assignees.includes(id) ? form.assignees.filter((a) => a !== id) : [...form.assignees, id]);

  const submit = () => {
    if (!form.title.trim()) return setError("Укажите название задачи");
    if (!form.columnId) return setError("Выберите колонку");
    // Приоритет «установлен срок» без даты теряет смысл — он именно про
    // то, что дата назначена.
    if (form.priority === "dated" && !form.dueDate) {
      return setError("Для приоритета «Установлен срок» укажите срок исполнения");
    }
    onSave({ ...form, title: form.title.trim(), tags: tagText.split(",").map((t) => t.trim().replace(/^#/, "")).filter(Boolean) });
  };

  const hasDeletedAssignee = form.assignees.some((id) => resolveUser(directory, id).deleted);

  return (
    <Modal theme={theme} onClose={onClose}>
      <ModalHeader theme={theme} title={isEdit ? "Редактировать задачу" : "Новая задача"} onClose={onClose} />

      <Field label="Название" theme={theme}>
        <input value={form.title} onChange={(e) => set("title", e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()}
          autoFocus style={inputStyle(theme)} className="w-full rounded-lg px-3 py-2 text-[13.5px] outline-none"
          placeholder="Новая задача" />
      </Field>

      <Field label="Описание" theme={theme}>
        <textarea value={form.description} onChange={(e) => set("description", e.target.value)} rows={3}
          style={inputStyle(theme)} className="w-full rounded-lg px-3 py-2 text-[13px] outline-none resize-none" />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Входящий №" theme={theme}>
          <input value={form.incomingNumber || ""} onChange={(e) => set("incomingNumber", e.target.value)}
            placeholder="например, 01-15/238" style={inputStyle(theme)}
            className="w-full rounded-lg px-3 py-2 text-[13px] outline-none" />
        </Field>
        <Field label="Дата документа" theme={theme}>
          <input type="date" value={String(form.incomingDate || "").slice(0, 10)}
            onChange={(e) => set("incomingDate", e.target.value)} style={inputStyle(theme)}
            className="w-full rounded-lg px-3 py-2 text-[13px] outline-none" />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Приоритет" theme={theme}>
          <select value={form.priority} onChange={(e) => set("priority", e.target.value)} style={inputStyle(theme)}
            className="w-full rounded-lg px-2 py-2 text-[13px] outline-none">
            {Object.entries(PRIORITIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </Field>
        <Field label="Колонка" theme={theme}>
          <select value={form.columnId || ""} onChange={(e) => set("columnId", e.target.value)} style={inputStyle(theme)}
            className="w-full rounded-lg px-2 py-2 text-[13px] outline-none">
            {columns.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
        </Field>
      </div>

      <Field label="Срок исполнения" theme={theme}>
        <input type="date" value={String(form.dueDate || "").slice(0, 10)} onChange={(e) => set("dueDate", e.target.value)}
          style={inputStyle(theme)} className="w-full rounded-lg px-3 py-2 text-[13px] outline-none" />
      </Field>

      <Field label="Исполнители" theme={theme}
        hint={candidates.length === 0 ? "Команда пуста — добавьте сотрудников в разделе «Моя команда»."
          : hasDeletedAssignee ? "Среди исполнителей есть удалённая учётная запись — назначьте замену."
          : outsideMyTeam.size > 0 ? "Отмеченные точкой назначены не из вашей команды — снимайте их осознанно."
          : undefined}>
        <div className="flex flex-wrap gap-1.5">
          {candidates.map((u) => {
            const active = form.assignees.includes(u.id);
            return (
              <button key={u.id} onClick={() => !u.deleted && toggleAssignee(u.id)} disabled={u.deleted}
                style={{ background: active ? theme.accent : theme.surfaceAlt, color: active ? theme.accentText : theme.text, border: `1px solid ${theme.border}`, opacity: u.deleted ? 0.45 : 1 }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium max-w-full">
                <Avatar user={u} size={16} theme={theme} />
                {/* Полное имя, а не только первое слово: однофамильцы
                    и просто похожие имена в списке из тридцати человек
                    делают выбор по имени лотереей. */}
                <span className="truncate max-w-[190px]">{u.fullName}</span>
                {u.position && (
                  <span style={{ opacity: 0.7 }} className="text-[10.5px] truncate max-w-[120px] hidden sm:inline">
                    · {u.position}
                  </span>
                )}
                {outsideMyTeam.has(u.id) && (
                  <span title="Назначен не из вашей команды"
                    style={{ background: active ? theme.accentText : theme.warning }}
                    className="w-1 h-1 rounded-full" />
                )}
              </button>
            );
          })}
        </div>
      </Field>

      <Field label="Цвет карточки" theme={theme}
        hint="Заливка полупрозрачная — карточка остаётся читаемой в любой теме и на любом фоне доски.">
        <div className="flex flex-wrap gap-1.5">
          {TASK_COLORS.map((c) => {
            const fill = taskColorFill(c.id, theme);
            const active = (form.color || "none") === c.id;
            return (
              <button key={c.id} onClick={() => set("color", c.id)} title={c.label}
                style={{
                  background: fill
                    ? `linear-gradient(${fill}, ${fill}), ${theme.surface}`
                    : theme.surfaceAlt,
                  border: `2px solid ${active ? theme.accent : theme.border}`,
                }}
                className="w-8 h-8 rounded-lg flex items-center justify-center">
                {c.id === "none" && (
                  <span style={{ color: theme.textMuted }} className="text-[15px] leading-none">×</span>
                )}
              </button>
            );
          })}
        </div>
      </Field>

      <Field label="Теги через запятую" theme={theme}>
        <input value={tagText} onChange={(e) => setTagText(e.target.value)} style={inputStyle(theme)}
          className="w-full rounded-lg px-3 py-2 text-[13px] outline-none" placeholder="интерфейс, сервер, срочно" />
      </Field>

      {error && <p style={{ color: theme.danger }} className="text-[12.5px] mb-2">{error}</p>}

      <div className="flex items-center gap-2 mt-4">
        <button onClick={submit} disabled={busy} style={{ background: theme.accent, color: theme.accentText }}
          className="flex-1 rounded-lg py-2.5 text-[13.5px] font-semibold disabled:opacity-50">
          {busy ? "Сохраняем…" : isEdit ? "Сохранить изменения" : "Создать задачу"}
        </button>
        {isEdit && (
          <button onClick={() => onRequestDelete(form.id)} style={{ color: theme.danger, border: `1px solid ${theme.border}` }}
            className="rounded-lg px-3 py-2.5" title="Удалить задачу">
            <Trash2 size={16} />
          </button>
        )}
      </div>
    </Modal>
  );
}
