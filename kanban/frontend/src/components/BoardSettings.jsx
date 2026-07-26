import React, { useRef, useState } from "react";
import { Trash2, Plus, ChevronLeft, ChevronRight, GripVertical, Upload, X, ImageOff } from "lucide-react";
import { api } from "../lib/api.js";
import { ALL_BACKGROUNDS, bgById, bgThumbUrl, ROLE_LABEL, resolveUser } from "../lib/theme.js";
import { Avatar, Modal, ModalHeader, Field, Toggle, ConfirmDialog, inputStyle } from "../lib/ui.jsx";

export default function BoardSettings({ theme, board, columns, tasks, directory, onClose, onSaved, onRequestDeleteBoard, onError }) {
  const [tab, setTab] = useState("general");
  const [title, setTitle] = useState(board.title);
  const [description, setDescription] = useState(board.description || "");
  const [bgPreset, setBgPreset] = useState(board.bgPreset || "none");
  const [bgBlur, setBgBlur] = useState(board.bgBlur || false);
  const [bgFileId, setBgFileId] = useState(board.bgFileId || null);
  const [bgStamp, setBgStamp] = useState(Date.now());
  const [cols, setCols] = useState(columns.map((c) => ({ ...c })));
  const [members, setMembers] = useState(board.members.map((m) => ({ ...m })));
  const [memberSearch, setMemberSearch] = useState("");
  const [columnWarning, setColumnWarning] = useState(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef();

  const save = async () => {
    setSaving(true);
    try {
      await api.updateBoard(board.id, { title: title.trim() || board.title, description, bgPreset, bgBlur });
      await api.saveColumns(board.id, cols.map((c) => ({
        id: c.id?.startsWith("new-") ? null : c.id,
        title: c.title, color: c.color, wipLimit: Number(c.wipLimit) || 0, isDone: Boolean(c.isDone),
      })));
      await api.setMembers(board.id, members.filter((m) => m.role !== "owner").map((m) => ({ userId: m.userId, role: m.role })));
      onSaved();
      onClose();
    } catch (e) {
      onError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const uploadBg = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const res = await api.uploadBackground(board.id, file);
      setBgFileId(res.fileId);
      setBgPreset("custom");
      setBgStamp(Date.now());
    } catch (e) {
      onError(e.message);
    } finally {
      setUploading(false);
    }
  };

  const dropBg = async () => {
    try {
      await api.deleteBackground(board.id);
      setBgFileId(null);
      setBgPreset("none");
    } catch (e) {
      onError(e.message);
    }
  };

  const patchCol = (id, p) => setCols((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));
  const addColumn = () => setCols((cs) => [...cs, { id: `new-${Date.now()}`, title: "Новая колонка", color: "#8892A8", wipLimit: 0, isDone: false }]);

  const moveCol = (index, dir) =>
    setCols((cs) => {
      const next = [...cs];
      const target = index + dir;
      if (target < 0 || target >= next.length) return cs;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const removeColumn = (col) => {
    if (cols.length === 1) return onError("На доске должна остаться хотя бы одна колонка");
    const count = tasks.filter((t) => t.columnId === col.id).length;
    if (count > 0) return setColumnWarning({ col, count });
    setCols((cs) => cs.filter((c) => c.id !== col.id));
  };

  const candidates = directory
    .filter((u) => !members.some((m) => m.userId === u.id))
    .filter((u) => `${u.fullName} ${u.position}`.toLowerCase().includes(memberSearch.toLowerCase()))
    .slice(0, 8);

  const activePreset = bgById(bgPreset);

  return (
    <Modal theme={theme} onClose={onClose} width="max-w-lg" padded={false}>
      <div className="p-5 pb-3"><ModalHeader theme={theme} title="Настройки проекта" onClose={onClose} /></div>

      <nav style={{ borderColor: theme.border }} className="flex border-t border-b px-5">
        {[["general", "Общее"], ["columns", "Колонки"], ["access", "Доступ"]].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            style={{ color: tab === key ? theme.text : theme.textMuted, borderColor: tab === key ? theme.accent : "transparent" }}
            className="px-3 py-2.5 text-[12.5px] font-medium border-b-2 -mb-px">
            {label}
          </button>
        ))}
      </nav>

      <div className="p-5">
        {tab === "general" && (
          <div>
            <Field label="Название проекта" theme={theme}>
              <input value={title} onChange={(e) => setTitle(e.target.value)} style={inputStyle(theme)} className="w-full rounded-lg px-3 py-2 text-[13.5px] outline-none" />
            </Field>
            <Field label="Описание" theme={theme}>
              <input value={description} onChange={(e) => setDescription(e.target.value)} style={inputStyle(theme)} className="w-full rounded-lg px-3 py-2 text-[13px] outline-none" />
            </Field>

            <Field label="Фон доски" theme={theme}>
              <div className="grid grid-cols-4 gap-2">
                {ALL_BACKGROUNDS.map((p) => {
                  // У фотографий вместо CSS-градиента показываем
                  // уменьшенную копию: тянуть ради плитки 80×48
                  // полноразмерный файл незачем.
                  const thumb = bgThumbUrl(p.id);
                  return (
                  <button key={p.id} onClick={() => setBgPreset(p.id)}
                    style={{
                      background: thumb ? `url(${thumb}) center/cover` : p.css || theme.surfaceAlt,
                      backgroundSize: thumb ? "cover" : p.size || "cover",
                      border: `2px solid ${bgPreset === p.id ? theme.accent : theme.border}`,
                    }}
                    className="h-12 rounded-lg flex items-end p-1" title={p.label}>
                    <span
                      style={{
                        color: p.css || thumb ? "#fff" : theme.textMuted,
                        textShadow: p.css || thumb ? "0 1px 3px rgba(0,0,0,.7)" : "none",
                      }}
                      className="text-[9.5px] font-medium leading-none">
                      {p.label}
                    </span>
                  </button>
                  );
                })}
              </div>

              <div className="mt-3">
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { uploadBg(e.target.files?.[0]); e.target.value = ""; }} />
                {bgFileId ? (
                  <div className="flex items-center gap-2">
                    <img src={api.backgroundUrl(board.id, bgStamp)} alt="Фон проекта" className="w-20 h-12 rounded-lg object-cover" style={{ border: `2px solid ${bgPreset === "custom" ? theme.accent : theme.border}` }} />
                    <button onClick={() => setBgPreset("custom")} style={{ color: theme.text, border: `1px solid ${theme.border}` }} className="text-[12px] px-2.5 py-1.5 rounded-lg">Использовать</button>
                    <button onClick={() => fileRef.current?.click()} style={{ color: theme.accent, border: `1px solid ${theme.border}` }} className="text-[12px] px-2.5 py-1.5 rounded-lg">Заменить</button>
                    <button onClick={dropBg} style={{ color: theme.danger }} title="Убрать изображение"><ImageOff size={15} /></button>
                  </div>
                ) : (
                  <button onClick={() => fileRef.current?.click()} disabled={uploading} style={{ color: theme.accent, border: `1px dashed ${theme.border}` }}
                    className="w-full flex items-center justify-center gap-1.5 text-[12.5px] font-medium rounded-lg py-2.5 disabled:opacity-50">
                    <Upload size={14} /> {uploading ? "Загружаем…" : "Загрузить своё изображение"}
                  </button>
                )}
              </div>

              <div className="mt-3">
                <Toggle theme={theme} checked={bgBlur} onChange={setBgBlur} label="Размыть фон" />
                <p style={{ color: theme.textMuted }} className="text-[11.5px] mt-1.5">Размытие приглушает фон, чтобы он не спорил с карточками.</p>
              </div>

              <div style={{ border: `1px solid ${theme.border}`, background: theme.bg }} className="mt-3 h-20 rounded-xl overflow-hidden relative">
                <div style={{
                  backgroundImage:
                    bgPreset === "custom" && bgFileId
                      ? `url(${api.backgroundUrl(board.id, bgStamp)})`
                      : bgThumbUrl(bgPreset)
                      ? `url(${bgThumbUrl(bgPreset)})`
                      : activePreset?.css || "none",
                  backgroundSize: bgPreset === "custom" ? "cover" : activePreset?.size || "cover",
                  backgroundPosition: "center",
                  filter: bgBlur ? "blur(14px)" : "none", transform: bgBlur ? "scale(1.15)" : "none",
                  opacity: theme.dark ? 0.5 : 0.65,
                }} className="absolute inset-0" />
                <div className="relative h-full flex items-center justify-center">
                  <span style={{ background: theme.surface, color: theme.text, border: `1px solid ${theme.border}` }} className="px-3 py-1.5 rounded-lg text-[12px] shadow-sm">Так будет выглядеть карточка</span>
                </div>
              </div>
            </Field>

            <button onClick={onRequestDeleteBoard} style={{ color: theme.danger }} className="flex items-center gap-1.5 text-[12.5px] font-medium mt-4">
              <Trash2 size={13} /> Удалить проект
            </button>
          </div>
        )}

        {tab === "columns" && (
          <div>
            {cols.map((c, i) => (
              <div key={c.id} style={{ background: theme.surfaceAlt, border: `1px solid ${theme.border}` }} className="rounded-xl p-2.5 mb-2">
                <div className="flex items-center gap-2 mb-2">
                  <GripVertical size={14} style={{ color: theme.textMuted }} />
                  <input value={c.title} onChange={(e) => patchCol(c.id, { title: e.target.value })} style={{ background: theme.surface, color: theme.text, border: `1px solid ${theme.border}` }} className="flex-1 rounded-lg px-2.5 py-1.5 text-[13px] outline-none" />
                  <input type="color" value={c.color} onChange={(e) => patchCol(c.id, { color: e.target.value })} className="w-8 h-8 rounded-lg cursor-pointer bg-transparent border-0" title="Цвет колонки" />
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <label style={{ color: theme.textMuted }} className="flex items-center gap-1.5 text-[12px]">
                    Не больше
                    <input type="number" min={0} value={c.wipLimit} onChange={(e) => patchCol(c.id, { wipLimit: e.target.value })} style={{ background: theme.surface, color: theme.text, border: `1px solid ${theme.border}` }} className="w-14 rounded-md px-1.5 py-1 text-[12px] outline-none" />
                    задач
                  </label>
                  <label style={{ color: theme.textMuted }} className="flex items-center gap-1.5 text-[12px] cursor-pointer">
                    <input type="checkbox" checked={c.isDone} onChange={(e) => patchCol(c.id, { isDone: e.target.checked })} />
                    Колонка завершения
                  </label>
                  <div className="ml-auto flex items-center gap-1">
                    <button onClick={() => moveCol(i, -1)} style={{ color: theme.textMuted }} title="Левее"><ChevronLeft size={15} /></button>
                    <button onClick={() => moveCol(i, 1)} style={{ color: theme.textMuted }} title="Правее"><ChevronRight size={15} /></button>
                    <button onClick={() => removeColumn(c)} style={{ color: theme.danger }} title="Удалить"><Trash2 size={14} /></button>
                  </div>
                </div>
              </div>
            ))}

            <button onClick={addColumn} style={{ color: theme.accent, border: `1px dashed ${theme.border}` }} className="w-full flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-[12.5px] font-medium">
              <Plus size={14} /> Добавить колонку
            </button>

            <p style={{ color: theme.textMuted }} className="text-[11.5px] mt-3 leading-relaxed">
              Ноль в поле «не больше» означает, что предел не задан.
            </p>

            {columnWarning && (
              <ConfirmDialog theme={theme} title="Колонка не пуста"
                message={`В колонке «${columnWarning.col.title}» ${columnWarning.count} задач. Они переедут в первую колонку доски. Продолжить?`}
                confirmLabel="Перенести и удалить" danger={false} onCancel={() => setColumnWarning(null)}
                onConfirm={() => { setCols((cs) => cs.filter((c) => c.id !== columnWarning.col.id)); setColumnWarning(null); }} />
            )}
          </div>
        )}

        {tab === "access" && (
          <div>
            <div style={{ color: theme.textMuted }} className="text-[11.5px] uppercase tracking-wide font-medium mb-2">Участники проекта</div>
            {members.map((m) => {
              const u = resolveUser(directory, m.userId);
              return (
                <div key={m.userId} className="flex items-center gap-2 mb-2">
                  <Avatar user={u} size={26} theme={theme} />
                  <div className="flex-1 min-w-0">
                    <div style={{ color: u.deleted ? theme.textMuted : theme.text, textDecoration: u.deleted ? "line-through" : "none" }} className="text-[13px] truncate">{u.fullName}</div>
                    <div style={{ color: theme.textMuted }} className="text-[11px] truncate">{u.deleted ? "Учётная запись отключена" : u.position || "Должность не указана"}</div>
                  </div>
                  <select value={m.role} disabled={m.role === "owner"}
                    onChange={(e) => setMembers((ms) => ms.map((x) => (x.userId === m.userId ? { ...x, role: e.target.value } : x)))}
                    style={inputStyle(theme)} className="rounded-lg px-1.5 py-1 text-[12px] outline-none">
                    {Object.entries(ROLE_LABEL).map(([k, l]) => <option key={k} value={k} disabled={k === "owner"}>{l}</option>)}
                  </select>
                  {m.role !== "owner" && (
                    <button onClick={() => setMembers((ms) => ms.filter((x) => x.userId !== m.userId))} style={{ color: theme.danger }}><X size={14} /></button>
                  )}
                </div>
              );
            })}

            <div style={{ color: theme.textMuted }} className="text-[11.5px] uppercase tracking-wide font-medium mt-4 mb-2">Добавить из справочника</div>
            <input value={memberSearch} onChange={(e) => setMemberSearch(e.target.value)} placeholder="Имя или должность" style={inputStyle(theme)} className="w-full rounded-lg px-3 py-2 text-[13px] outline-none mb-2" />

            {candidates.map((u) => (
              <div key={u.id} className="flex items-center gap-2 mb-1.5">
                <Avatar user={u} size={24} theme={theme} />
                <div className="flex-1 min-w-0">
                  <div style={{ color: theme.text }} className="text-[12.5px] truncate">{u.fullName}</div>
                  <div style={{ color: theme.textMuted }} className="text-[11px] truncate">{u.position}</div>
                </div>
                <button onClick={() => setMembers((ms) => [...ms, { userId: u.id, role: "reader" }])} style={{ color: theme.accent, border: `1px solid ${theme.border}` }} className="text-[11.5px] px-2 py-1 rounded-lg">Читатель</button>
                <button onClick={() => setMembers((ms) => [...ms, { userId: u.id, role: "editor" }])} style={{ background: theme.accent, color: theme.accentText }} className="text-[11.5px] px-2 py-1 rounded-lg">Редактор</button>
              </div>
            ))}

            <p style={{ color: theme.textMuted }} className="text-[11.5px] mt-3 leading-relaxed">
              Читатель видит всю доску, комментирует, отмечает шаги и загружает файлы, но не может создавать, перемещать и удалять задачи.
            </p>
          </div>
        )}
      </div>

      <div style={{ borderColor: theme.border }} className="border-t p-4 flex gap-2">
        <button onClick={onClose} style={{ background: theme.surfaceAlt, color: theme.text, border: `1px solid ${theme.border}` }} className="flex-1 rounded-lg py-2.5 text-[13px] font-medium">Отмена</button>
        <button onClick={save} disabled={saving} style={{ background: theme.accent, color: theme.accentText }} className="flex-1 rounded-lg py-2.5 text-[13px] font-semibold disabled:opacity-50">
          {saving ? "Сохраняем…" : "Сохранить"}
        </button>
      </div>
    </Modal>
  );
}
