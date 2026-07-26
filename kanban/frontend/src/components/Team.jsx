import React, { useState } from "react";
import { Check, Video, Search } from "lucide-react";
import { Avatar, Modal, ModalHeader, inputStyle } from "../lib/ui.jsx";

export default function Team({ theme, directory, team, onClose, onSave, onOpenUser }) {
  const [selected, setSelected] = useState(new Set(team));
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);

  const list = directory.filter((u) => `${u.fullName} ${u.position} ${u.phone}`.toLowerCase().includes(query.toLowerCase()));

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const save = async () => { setSaving(true); await onSave([...selected]); setSaving(false); };

  return (
    <Modal theme={theme} onClose={onClose} padded={false}>
      <div className="p-5 pb-3">
        <ModalHeader theme={theme} title="Моя команда" subtitle="Отмеченных сотрудников можно назначать исполнителями задач" onClose={onClose} />
        <div className="relative">
          <Search size={14} style={{ color: theme.textMuted }} className="absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Имя, должность или телефон" style={inputStyle(theme)} className="w-full pl-8 pr-3 py-2 rounded-lg text-[13px] outline-none" />
        </div>
      </div>

      <div style={{ borderColor: theme.border }} className="border-t max-h-[50vh] overflow-y-auto px-3 py-2">
        {list.map((u) => (
          <div key={u.id} style={{ background: selected.has(u.id) ? theme.surfaceAlt : "transparent" }} className="flex items-center gap-2.5 p-2 rounded-xl mb-1">
            <button onClick={() => onOpenUser(u)} className="shrink-0" title="Карточка сотрудника"><Avatar user={u} size={32} theme={theme} /></button>
            <button onClick={() => onOpenUser(u)} className="flex-1 min-w-0 text-left">
              <div style={{ color: theme.text, textDecoration: u.deleted ? "line-through" : "none", opacity: u.deleted ? 0.6 : 1 }} className="text-[13px] font-medium truncate">{u.fullName}</div>
              <div style={{ color: theme.textMuted }} className="text-[11.5px] truncate">{u.deleted ? "Учётная запись удалена" : u.position || "Должность не указана"}</div>
            </button>
            {u.phone && !u.deleted && (
              <a href={`callto:${u.phone.replace(/[^\d+]/g, "")}`} style={{ color: theme.accent, border: `1px solid ${theme.border}` }} className="flex items-center gap-1 text-[11.5px] px-2 py-1 rounded-lg shrink-0" title={`Видеозвонок: ${u.phone}`}>
                <Video size={12} /> Видео
              </a>
            )}
            {!u.deleted && (
              <button onClick={() => toggle(u.id)} style={{ background: selected.has(u.id) ? theme.accent : "transparent", border: `1.5px solid ${selected.has(u.id) ? theme.accent : theme.border}` }} className="w-[18px] h-[18px] rounded-md flex items-center justify-center shrink-0" title={selected.has(u.id) ? "Убрать из команды" : "Добавить в команду"}>
                {selected.has(u.id) && <Check size={12} color={theme.accentText} />}
              </button>
            )}
          </div>
        ))}
        {list.length === 0 && <p style={{ color: theme.textMuted }} className="text-[13px] text-center py-6">Никого не найдено.</p>}
      </div>

      <div style={{ borderColor: theme.border }} className="border-t p-4 flex items-center gap-2">
        <span style={{ color: theme.textMuted }} className="text-[12px] flex-1">Выбрано: {selected.size}</span>
        <button onClick={onClose} style={{ background: theme.surfaceAlt, color: theme.text, border: `1px solid ${theme.border}` }} className="rounded-lg px-4 py-2.5 text-[13px] font-medium">Отмена</button>
        <button onClick={save} disabled={saving} style={{ background: theme.accent, color: theme.accentText }} className="rounded-lg px-4 py-2.5 text-[13px] font-semibold disabled:opacity-50">{saving ? "Сохраняем…" : "Сохранить"}</button>
      </div>
    </Modal>
  );
}
