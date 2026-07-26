import React, { useCallback, useEffect, useState } from "react";
import {
  Search, Plus, Pencil, Trash2, KeyRound, RotateCcw, ShieldCheck, User as UserIcon,
  ChevronLeft, ChevronRight, X, Check,
} from "lucide-react";
import { api } from "../lib/api.js";
import { fmtDate } from "../lib/theme.js";
import { Avatar, Modal, ModalHeader, Field, ConfirmDialog, inputStyle } from "../lib/ui.jsx";

const PAGE_SIZE = 20;

export default function Admin({ theme, currentUser, onClose, onError, onInfo, onDirectoryChanged }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);   // объект пользователя или "new"
  const [resetting, setResetting] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const load = useCallback(async (targetPage = page, q = query) => {
    setLoading(true);
    try {
      const data = await api.adminUsers({ limit: PAGE_SIZE, offset: (targetPage - 1) * PAGE_SIZE, q });
      setItems(data.items);
      setTotal(data.total);
    } catch (e) {
      onError(e.message);
    } finally {
      setLoading(false);
    }
  }, [page, query, onError]);

  useEffect(() => { load(page, query); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  // Поиск с задержкой: панель открывают редко, но набор символов не
  // должен порождать запрос на каждое нажатие клавиши.
  useEffect(() => {
    const t = setTimeout(() => { setPage(1); load(1, query); }, 350);
    return () => clearTimeout(t);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const afterChange = () => {
    load(page, query);
    onDirectoryChanged();
  };

  const remove = (u) => setConfirm({
    title: "Удалить учётную запись?",
    message: `${u.fullName} потеряет доступ немедленно: все сессии будут завершены. Имя останется в задачах и комментариях, которые он создал, — история не пострадает. Учётную запись можно будет восстановить.`,
    confirmLabel: "Удалить",
    onConfirm: async () => {
      setConfirm(null);
      try {
        await api.adminDeleteUser(u.id);
        onInfo(`Учётная запись ${u.fullName} отключена`);
        afterChange();
      } catch (e) {
        onError(e.message);
      }
    },
  });

  const restore = async (u) => {
    try {
      await api.adminRestoreUser(u.id);
      onInfo(`${u.fullName} восстановлен. Доступ к проектам нужно выдать заново.`);
      afterChange();
    } catch (e) {
      onError(e.message);
    }
  };

  const toggleActive = async (u) => {
    try {
      await api.adminUpdateUser(u.id, { isActive: !u.isActive });
      onInfo(u.isActive ? `${u.fullName} заблокирован, сессии завершены` : `${u.fullName} разблокирован`);
      afterChange();
    } catch (e) {
      onError(e.message);
    }
  };

  return (
    <Modal theme={theme} onClose={onClose} width="max-w-3xl" padded={false}>
      <div className="p-5 pb-3">
        <ModalHeader theme={theme} title="Управление пользователями"
          subtitle="Создание, правка, блокировка и удаление учётных записей"
          onClose={onClose}
          extra={
            <button onClick={() => setEditing("new")} style={{ background: theme.accent, color: theme.accentText }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-semibold">
              <Plus size={14} /> Добавить
            </button>
          } />
        <div className="relative">
          <Search size={14} style={{ color: theme.textMuted }} className="absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Имя, должность, телефон или почта"
            style={inputStyle(theme)} className="w-full pl-8 pr-3 py-2 rounded-lg text-[13px] outline-none" />
        </div>
      </div>

      <div style={{ borderColor: theme.border }} className="border-t max-h-[55vh] overflow-y-auto px-3 py-2">
        {loading && <p style={{ color: theme.textMuted }} className="text-[13px] text-center py-8">Загружаем…</p>}

        {!loading && items.map((u) => {
          const isSelf = u.id === currentUser.id;
          return (
            <div key={u.id} style={{ background: theme.surfaceAlt, border: `1px solid ${theme.border}`, opacity: u.deleted ? 0.6 : 1 }}
              className="rounded-xl p-2.5 mb-1.5 flex items-center gap-2.5">
              <Avatar user={u} size={34} theme={theme} />

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span style={{ color: theme.text, textDecoration: u.deleted ? "line-through" : "none" }} className="text-[13px] font-medium truncate">
                    {u.fullName}
                  </span>
                  {u.role === "admin" && (
                    <span title="Администратор системы" style={{ background: theme.accent, color: theme.accentText }}
                      className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded font-semibold">
                      <ShieldCheck size={10} /> админ
                    </span>
                  )}
                  {isSelf && (
                    <span style={{ background: theme.surface, color: theme.textMuted, border: `1px solid ${theme.border}` }}
                      className="text-[10px] px-1.5 py-0.5 rounded">это вы</span>
                  )}
                  {u.deleted ? (
                    <span style={{ color: theme.danger }} className="text-[10.5px]">удалён</span>
                  ) : !u.isActive ? (
                    <span style={{ color: theme.warning }} className="text-[10.5px]">заблокирован</span>
                  ) : u.sessions > 0 ? (
                    <span style={{ color: theme.success }} className="text-[10.5px]" title="Активных сессий">
                      сессий: {u.sessions}
                    </span>
                  ) : null}
                </div>
                <div style={{ color: theme.textMuted }} className="text-[11.5px] truncate">
                  {u.email}{u.position ? ` · ${u.position}` : ""}{u.phone ? ` · ${u.phone}` : ""}
                </div>
                {u.createdAt && (
                  <div style={{ color: theme.textMuted }} className="text-[10.5px]">с {fmtDate(u.createdAt)}</div>
                )}
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {u.deleted ? (
                  <button onClick={() => restore(u)} style={{ color: theme.success, border: `1px solid ${theme.border}` }}
                    className="flex items-center gap-1 text-[11.5px] px-2 py-1 rounded-lg" title="Восстановить учётную запись">
                    <RotateCcw size={12} /> Вернуть
                  </button>
                ) : (
                  <>
                    <button onClick={() => setEditing(u)} style={{ color: theme.textMuted }} className="p-1.5" title="Редактировать">
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => setResetting(u)} style={{ color: theme.textMuted }} className="p-1.5" title="Задать новый пароль">
                      <KeyRound size={14} />
                    </button>
                    {/* Блокировать и удалять себя нельзя: иначе
                        администратор способен запереть сам себя. */}
                    {!isSelf && (
                      <>
                        <button onClick={() => toggleActive(u)}
                          style={{ color: u.isActive ? theme.warning : theme.success }} className="p-1.5"
                          title={u.isActive ? "Заблокировать (завершит все сессии)" : "Разблокировать"}>
                          {u.isActive ? <X size={14} /> : <Check size={14} />}
                        </button>
                        <button onClick={() => remove(u)} style={{ color: theme.danger }} className="p-1.5" title="Удалить">
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}

        {!loading && items.length === 0 && (
          <p style={{ color: theme.textMuted }} className="text-[13px] text-center py-8">Никого не найдено.</p>
        )}
      </div>

      <div style={{ borderColor: theme.border }} className="border-t p-3 flex items-center justify-between">
        <span style={{ color: theme.textMuted }} className="text-[12px]">Всего: {total}</span>
        {pages > 1 && (
          <div className="flex items-center gap-3">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
              style={{ color: theme.textMuted, opacity: page === 1 ? 0.4 : 1 }} className="flex items-center gap-1 text-[12px]">
              <ChevronLeft size={13} /> Назад
            </button>
            <span style={{ color: theme.textMuted }} className="text-[11.5px]">{page} из {pages}</span>
            <button onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page === pages}
              style={{ color: theme.textMuted, opacity: page === pages ? 0.4 : 1 }} className="flex items-center gap-1 text-[12px]">
              Далее <ChevronRight size={13} />
            </button>
          </div>
        )}
      </div>

      {editing && (
        <UserForm theme={theme} user={editing === "new" ? null : editing} currentUser={currentUser}
          onClose={() => setEditing(null)}
          onSaved={(msg) => { setEditing(null); onInfo(msg); afterChange(); }}
          onError={onError} />
      )}

      {resetting && (
        <PasswordForm theme={theme} user={resetting} onClose={() => setResetting(null)}
          onSaved={(msg) => { setResetting(null); onInfo(msg); afterChange(); }} onError={onError} />
      )}

      {confirm && <ConfirmDialog theme={theme} {...confirm} onCancel={() => setConfirm(null)} />}
    </Modal>
  );
}

function UserForm({ theme, user, currentUser, onClose, onSaved, onError }) {
  const isNew = !user;
  const [form, setForm] = useState({
    email: user?.email || "",
    fullName: user?.fullName || "",
    position: user?.position || "",
    phone: user?.phone || "",
    role: user?.role || "member",
    password: "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const isSelf = user && user.id === currentUser.id;

  const submit = async () => {
    if (!form.email.includes("@") || !form.fullName.trim()) {
      onError("Нужны корректный адрес почты и имя");
      return;
    }
    if (isNew && form.password.length < 10) {
      onError("Пароль должен быть не короче 10 символов");
      return;
    }
    setBusy(true);
    try {
      if (isNew) {
        await api.adminCreateUser({
          email: form.email.trim(), password: form.password, fullName: form.fullName.trim(),
          position: form.position.trim(), phone: form.phone.trim(), role: form.role,
        });
        onSaved(`Учётная запись ${form.fullName.trim()} создана`);
      } else {
        await api.adminUpdateUser(user.id, {
          email: form.email.trim(), fullName: form.fullName.trim(),
          position: form.position.trim(), phone: form.phone.trim(), role: form.role,
        });
        onSaved("Изменения сохранены");
      }
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal theme={theme} onClose={onClose} width="max-w-sm">
      <ModalHeader theme={theme} title={isNew ? "Новый пользователь" : "Редактирование"} onClose={onClose} />

      <Field label="ФИО" theme={theme}>
        <input value={form.fullName} onChange={(e) => set("fullName", e.target.value)} autoFocus
          style={inputStyle(theme)} className="w-full rounded-lg px-3 py-2 text-[13.5px] outline-none" placeholder="Иванов Иван" />
      </Field>
      <Field label="Электронная почта" theme={theme}>
        <input type="email" value={form.email} onChange={(e) => set("email", e.target.value)}
          style={inputStyle(theme)} className="w-full rounded-lg px-3 py-2 text-[13.5px] outline-none" placeholder="name@team.dev" />
      </Field>
      <Field label="Должность" theme={theme}>
        <input value={form.position} onChange={(e) => set("position", e.target.value)}
          style={inputStyle(theme)} className="w-full rounded-lg px-3 py-2 text-[13.5px] outline-none" />
      </Field>
      <Field label="Телефон" theme={theme}>
        <input value={form.phone} onChange={(e) => set("phone", e.target.value)}
          style={inputStyle(theme)} className="w-full rounded-lg px-3 py-2 text-[13.5px] outline-none" placeholder="+7 900 000-00-00" />
      </Field>

      {isNew && (
        <Field label="Пароль" theme={theme} hint="Не короче 10 символов. Сообщите его пользователю лично.">
          <input type="password" value={form.password} onChange={(e) => set("password", e.target.value)}
            style={inputStyle(theme)} className="w-full rounded-lg px-3 py-2 text-[13.5px] outline-none" />
        </Field>
      )}

      <Field label="Роль в системе" theme={theme}
        hint={isSelf
          ? "Снять права у себя нельзя, если вы единственный администратор."
          : "Администратор управляет всеми учётными записями. Роли на досках задаются отдельно, в настройках каждого проекта."}>
        <div className="flex gap-1.5">
          {[["member", "Участник", UserIcon], ["admin", "Администратор", ShieldCheck]].map(([value, label, Icon]) => (
            <button key={value} onClick={() => set("role", value)}
              style={{
                background: form.role === value ? theme.accent : theme.surfaceAlt,
                color: form.role === value ? theme.accentText : theme.text,
                border: `1px solid ${theme.border}`,
              }}
              className="flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-[12.5px] font-medium">
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>
      </Field>

      <button onClick={submit} disabled={busy} style={{ background: theme.accent, color: theme.accentText }}
        className="w-full rounded-lg py-2.5 text-[13.5px] font-semibold disabled:opacity-50 mt-2">
        {busy ? "Сохраняем…" : isNew ? "Создать" : "Сохранить"}
      </button>
    </Modal>
  );
}

function PasswordForm({ theme, user, onClose, onSaved, onError }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (password.length < 10) {
      onError("Пароль должен быть не короче 10 символов");
      return;
    }
    setBusy(true);
    try {
      await api.adminResetPassword(user.id, password);
      onSaved(`Пароль изменён, все сессии ${user.fullName} завершены`);
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal theme={theme} onClose={onClose} width="max-w-sm">
      <ModalHeader theme={theme} title="Новый пароль" subtitle={user.fullName} onClose={onClose} />
      <Field label="Пароль" theme={theme}
        hint="Не короче 10 символов. Все текущие сессии пользователя будут завершены — ему потребуется войти заново.">
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus
          onKeyDown={(e) => e.key === "Enter" && submit()}
          style={inputStyle(theme)} className="w-full rounded-lg px-3 py-2 text-[13.5px] outline-none" />
      </Field>
      <button onClick={submit} disabled={busy} style={{ background: theme.accent, color: theme.accentText }}
        className="w-full rounded-lg py-2.5 text-[13.5px] font-semibold disabled:opacity-50 mt-2">
        {busy ? "Сохраняем…" : "Задать пароль"}
      </button>
    </Modal>
  );
}
