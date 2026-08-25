import React, { useEffect, useState } from "react";
import { UserCheck, Trash2, Plus, ArrowRight } from "lucide-react";
import { api } from "../lib/api.js";
import { fmtDate, resolveUser } from "../lib/theme.js";
import { Avatar, Modal, ModalHeader, Field, ConfirmDialog, inputStyle } from "../lib/ui.jsx";

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

export default function Delegation({ theme, directory, currentUser, onClose, onError, onInfo }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [form, setForm] = useState({
    deputyId: "", startsAt: today(), endsAt: plusDays(14), note: "",
  });

  const load = async () => {
    setLoading(true);
    try {
      setItems(await api.delegations());
    } catch (e) {
      onError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Замещения делятся на две стороны: кого замещаю я и кто замещает
  // меня. Это принципиально разные записи — отменить можно только свои.
  const iDelegate = items.filter((d) => d.grantorId === currentUser.id);
  const iSubstitute = items.filter((d) => d.deputyId === currentUser.id);

  const submit = async () => {
    if (!form.deputyId) return onError("Выберите заместителя");
    if (form.endsAt < form.startsAt) return onError("Дата окончания раньше начала");
    try {
      await api.createDelegation(form);
      onInfo("Заместитель назначен");
      setAdding(false);
      setForm({ deputyId: "", startsAt: today(), endsAt: plusDays(14), note: "" });
      load();
    } catch (e) {
      onError(e.message);
    }
  };

  const remove = (d) => setConfirm({
    title: "Отменить замещение?",
    message: `${resolveUser(directory, d.deputyId).fullName} потеряет доступ к вашим проектам немедленно.`,
    confirmLabel: "Отменить",
    onConfirm: async () => {
      setConfirm(null);
      try {
        await api.deleteDelegation(d.id);
        onInfo("Замещение отменено");
        load();
      } catch (e) {
        onError(e.message);
      }
    },
  });

  const row = (d, mine) => {
    const other = resolveUser(directory, mine ? d.deputyId : d.grantorId);
    return (
      <div key={d.id}
        style={{ background: theme.surfaceAlt, border: `1px solid ${d.active ? theme.accent : theme.border}` }}
        className="rounded-xl p-2.5 mb-1.5 flex items-center gap-2.5">
        <Avatar user={other} size={30} theme={theme} />
        <div className="min-w-0 flex-1">
          <div style={{ color: theme.text }} className="text-[13px] font-medium truncate">
            {other.fullName}
          </div>
          <div style={{ color: theme.textMuted }} className="text-[11.5px]">
            {fmtDate(d.startsAt)} — {fmtDate(d.endsAt)}
            {d.active && (
              <span style={{ color: theme.accent }} className="mono ml-1.5 text-[10px] uppercase">
                действует
              </span>
            )}
          </div>
          {d.note && (
            <div style={{ color: theme.textMuted }} className="text-[11px] truncate mt-0.5">{d.note}</div>
          )}
        </div>
        {mine && (
          <button onClick={() => remove(d)} style={{ color: theme.danger }} className="p-1.5" title="Отменить">
            <Trash2 size={14} />
          </button>
        )}
      </div>
    );
  };

  const candidates = directory.filter((u) => !u.deleted && u.id !== currentUser.id);

  return (
    <Modal theme={theme} onClose={onClose} width="max-w-md">
      <ModalHeader theme={theme} title="Замещение"
        subtitle="Передача прав на время отпуска или командировки" onClose={onClose} />

      {loading && <p style={{ color: theme.textMuted }} className="text-[13px] py-6 text-center">Загружаем…</p>}

      {!loading && (
        <>
          <div className="mono text-[10px] uppercase tracking-wider mb-1.5" style={{ color: theme.textMuted }}>
            // меня замещают
          </div>
          {iDelegate.length === 0 && (
            <p style={{ color: theme.textMuted }} className="text-[12.5px] mb-3">
              Заместители не назначены.
            </p>
          )}
          {iDelegate.map((d) => row(d, true))}

          {adding ? (
            <div style={{ background: theme.surfaceAlt, border: `1px solid ${theme.border}` }}
              className="rounded-xl p-3 mt-2">
              <Field label="Заместитель" theme={theme}>
                <select value={form.deputyId} onChange={(e) => setForm((f) => ({ ...f, deputyId: e.target.value }))}
                  style={inputStyle(theme)} className="w-full rounded-lg px-2 py-2 text-[13px] outline-none">
                  <option value="">— выберите —</option>
                  {candidates.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.fullName}{u.position ? ` · ${u.position}` : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="С" theme={theme}>
                  <input type="date" value={form.startsAt}
                    onChange={(e) => setForm((f) => ({ ...f, startsAt: e.target.value }))}
                    style={inputStyle(theme)} className="w-full rounded-lg px-2 py-2 text-[13px] outline-none" />
                </Field>
                <Field label="По" theme={theme}>
                  <input type="date" value={form.endsAt}
                    onChange={(e) => setForm((f) => ({ ...f, endsAt: e.target.value }))}
                    style={inputStyle(theme)} className="w-full rounded-lg px-2 py-2 text-[13px] outline-none" />
                </Field>
              </div>
              <Field label="Примечание" theme={theme}
                hint="Заместитель получит все ваши права на проекты в этот период">
                <input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                  placeholder="например, отпуск" style={inputStyle(theme)}
                  className="w-full rounded-lg px-3 py-2 text-[13px] outline-none" />
              </Field>
              <div className="flex gap-2 mt-1">
                <button onClick={() => setAdding(false)}
                  style={{ background: theme.surface, color: theme.text, border: `1px solid ${theme.border}` }}
                  className="flex-1 rounded-lg py-2 text-[12.5px] font-medium">Отмена</button>
                <button onClick={submit}
                  style={{ background: theme.accent, color: theme.accentText, "--glow-color": theme.glow }}
                  className="glow flex-1 rounded-lg py-2 text-[12.5px] font-semibold">Назначить</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setAdding(true)}
              style={{ color: theme.accent, border: `1px dashed ${theme.border}` }}
              className="w-full flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-[12.5px] font-medium mt-1">
              <Plus size={14} /> Назначить заместителя
            </button>
          )}

          {iSubstitute.length > 0 && (
            <>
              <div className="mono text-[10px] uppercase tracking-wider mt-5 mb-1.5"
                style={{ color: theme.textMuted }}>
                // я замещаю
              </div>
              {iSubstitute.map((d) => row(d, false))}
              <p style={{ color: theme.textMuted }} className="text-[11.5px] mt-2 leading-relaxed">
                <ArrowRight size={11} className="inline" /> В период замещения вам доступны проекты
                этих коллег наравне с вашими собственными.
              </p>
            </>
          )}
        </>
      )}

      {confirm && <ConfirmDialog theme={theme} {...confirm} onCancel={() => setConfirm(null)} />}
    </Modal>
  );
}
