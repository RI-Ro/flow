import React, { useEffect, useRef } from "react";
import { X, UserX, Video, Mail, Check } from "lucide-react";
import { initials, DELETED_USER, videoCallLink } from "./theme.js";

export const inputStyle = (t) => ({ background: t.surfaceAlt, color: t.text, border: `1px solid ${t.border}` });

export function Avatar({ user, size = 24, theme, onClick }) {
  if (!user) return null;
  const deleted = user.deleted;
  const title = deleted
    ? user.fullName === DELETED_USER.fullName ? "Учётная запись удалена" : `${user.fullName} — учётная запись отключена`
    : `${user.fullName}${user.position ? ` · ${user.position}` : ""}`;

  return (
    <span
      title={title}
      onClick={onClick}
      style={{
        width: size, height: size, fontSize: Math.round(size * 0.38),
        background: deleted ? "transparent" : user.avatarColor,
        border: deleted ? `1.5px dashed currentColor` : "none",
        color: deleted ? theme?.textMuted : "#fff",
        cursor: onClick ? "pointer" : "default",
      }}
      className="rounded-full inline-flex items-center justify-center font-semibold shrink-0 select-none"
    >
      {deleted ? <UserX size={Math.round(size * 0.5)} /> : initials(user.fullName)}
    </span>
  );
}

export function Modal({ theme, onClose, children, width = "max-w-md", padded = true }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,.55)" }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{ background: theme.surface, border: `1px solid ${theme.border}` }}
        // 80vh — потолок для всего окна. Прокрутка живёт здесь, на
        // внешнем контейнере: содержимое вроде списка комментариев или
        // истории заранее неизвестной высоты, и без ограничения окно
        // вырастало за пределы экрана вместе с кнопками действий.
        className={`rounded-2xl w-full ${width} max-h-[80vh] overflow-y-auto overscroll-contain ${padded ? "p-5" : ""}`}
      >
        {children}
      </div>
    </div>
  );
}

export function ModalHeader({ theme, title, subtitle, onClose, extra }) {
  return (
    <div className="flex items-start justify-between mb-4 gap-3">
      <div className="min-w-0">
        <h3 style={{ color: theme.text, fontFamily: "Manrope, sans-serif" }} className="font-semibold text-[17px] leading-tight">
          {title}
        </h3>
        {subtitle && <p style={{ color: theme.textMuted }} className="text-[12px] mt-1">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {extra}
        <button onClick={onClose} style={{ color: theme.textMuted }} aria-label="Закрыть"><X size={18} /></button>
      </div>
    </div>
  );
}

export function ConfirmDialog({ theme, title, message, confirmLabel = "Удалить", danger = true, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,.6)" }}
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div style={{ background: theme.surface, border: `1px solid ${theme.border}` }} className="rounded-2xl w-full max-w-sm p-5">
        <h4 style={{ color: theme.text, fontFamily: "Manrope, sans-serif" }} className="font-semibold text-[16px] mb-2">{title}</h4>
        <p style={{ color: theme.textMuted }} className="text-[13px] leading-relaxed mb-5">{message}</p>
        <div className="flex gap-2">
          <button onClick={onCancel} style={{ background: theme.surfaceAlt, color: theme.text, border: `1px solid ${theme.border}` }}
            className="flex-1 rounded-lg py-2.5 text-[13px] font-medium">Отмена</button>
          <button onClick={onConfirm} style={{ background: danger ? theme.danger : theme.accent, color: "#fff" }}
            className="flex-1 rounded-lg py-2.5 text-[13px] font-semibold">{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

export function Field({ label, theme, hint, children }) {
  return (
    <div className="mb-3">
      <label style={{ color: theme.textMuted }} className="text-[11.5px] font-medium uppercase tracking-wide">{label}</label>
      <div className="mt-1">{children}</div>
      {hint && <p style={{ color: theme.textMuted }} className="text-[11.5px] mt-1">{hint}</p>}
    </div>
  );
}

export function Chip({ active, theme, onClick, children, title }) {
  return (
    <button title={title} onClick={onClick}
      style={{ background: active ? theme.accent : theme.surfaceAlt, color: active ? theme.accentText : theme.text, border: `1px solid ${theme.border}` }}
      className="px-2.5 py-1 rounded-full text-[11.5px] font-medium">
      {children}
    </button>
  );
}

export function Toggle({ theme, checked, onChange, label }) {
  return (
    <button onClick={() => onChange(!checked)} className="flex items-center gap-2">
      <span style={{ background: checked ? theme.accent : theme.surfaceAlt, border: `1px solid ${theme.border}` }}
        className="w-9 h-5 rounded-full relative transition-colors shrink-0">
        <span style={{ background: checked ? theme.accentText : theme.textMuted, left: checked ? 18 : 3 }}
          className="absolute top-[3px] w-3.5 h-3.5 rounded-full transition-all" />
      </span>
      <span style={{ color: theme.text }} className="text-[13px]">{label}</span>
    </button>
  );
}

export function UserCard({ theme, user, onClose, delegation, directory }) {
  // Хук объявляется до раннего возврата: порядок вызовов хуков должен
  // быть одинаковым при каждом рендере.
  const [confirmCall, setConfirmCall] = React.useState(null);
  if (!user) return null;
  const phone = (user.phone || "").replace(/[^\d+]/g, "");

  return (
    <Modal theme={theme} onClose={onClose} width="max-w-xs">
      <div className="flex flex-col items-center text-center">
        <Avatar user={user} size={64} theme={theme} />
        <h3 style={{ color: theme.text, fontFamily: "Manrope, sans-serif" }} className="font-semibold text-[17px] mt-3">{user.fullName}</h3>
        {user.deleted ? (
          <p style={{ color: theme.warning }} className="text-[12.5px] mt-1">Учётная запись отключена</p>
        ) : (
          <p style={{ color: theme.textMuted }} className="text-[13px] mt-0.5">{user.position || "Должность не указана"}</p>
        )}
        {/* Факт замещения виден всем, кто открыл карточку: без этого
            задачи уходят человеку в отпуске и повисают. Показываем
            заместителя, причину и срок — этого достаточно, чтобы
            понять, к кому обращаться. */}
        {delegation && (
          <div style={{ background: theme.surfaceAlt, border: `1px solid ${theme.warning}` }}
            className="w-full mt-3 rounded-lg p-2.5 text-left">
            <div className="mono text-[9.5px] uppercase tracking-wider mb-1"
              style={{ color: theme.warning }}>// отсутствует</div>
            <div style={{ color: theme.text }} className="text-[12px] leading-snug">
              Замещает: <b>{delegation.deputyName}</b>
            </div>
            <div style={{ color: theme.textMuted }} className="text-[11px] mt-0.5">
              {delegation.note ? `${delegation.note} · ` : ""}
              до {delegation.endsAtLabel}
            </div>
          </div>
        )}

        <div className="w-full mt-4 space-y-2">
          {user.email && (
            <a href={`mailto:${user.email}`} style={{ background: theme.surfaceAlt, color: theme.text }}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-[13px]">
              <Mail size={14} style={{ color: theme.textMuted }} /><span className="truncate">{user.email}</span>
            </a>
          )}
          {/* Номер показан как обычная строка, а не ссылка на звонок:
              единственный способ связи в интерфейсе — видеозвонок ниже,
              и две разные кнопки вызова рядом только путали. */}
          {user.phone && (
            <div style={{ background: theme.surfaceAlt, color: theme.text }}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-[13px]">
              <Video size={14} style={{ color: theme.textMuted }} /><span>{user.phone}</span>
            </div>
          )}
        </div>
        {user.phone && !user.deleted && (
          // Ссылку собирает videoCallLink — там единый формат команды
          // клиента телефонии. Собирать её здесь строкой нельзя: формат
          // уже расходился между карточкой сотрудника и задачей.
          //
          // Вызов уходит только после подтверждения: нажатие мгновенно
          // поднимает вызов у человека, и случайный клик по кнопке в
          // открытой карточке — вполне реальный сценарий.
          <button onClick={() => setConfirmCall(videoCallLink(user))}
            style={{ background: theme.accent, color: theme.accentText }}
            className="w-full mt-3 rounded-lg py-2.5 text-[13.5px] font-semibold flex items-center justify-center gap-2">
            <Video size={15} /> Видеозвонок
          </button>
        )}
        {!user.phone && <p style={{ color: theme.textMuted }} className="text-[12px] mt-3">Телефон не указан — видеозвонок недоступен.</p>}
      </div>

      {confirmCall && (
        <ConfirmDialog theme={theme}
          title="Начать видеозвонок?"
          message={`Вызов будет отправлен: ${user.fullName} (${user.phone}).`}
          confirmLabel="Позвонить"
          danger={false}
          onCancel={() => setConfirmCall(null)}
          onConfirm={() => {
            const href = confirmCall;
            setConfirmCall(null);
            window.location.href = href;
          }} />
      )}
    </Modal>
  );
}

export function Checkbox({ theme, checked, onChange, disabled, label, strike }) {
  return (
    <button onClick={() => !disabled && onChange(!checked)} disabled={disabled} className="flex items-center gap-2 text-left disabled:cursor-default min-w-0">
      <span style={{ background: checked ? theme.success : "transparent", border: `1.5px solid ${checked ? theme.success : theme.border}` }}
        className="w-4 h-4 rounded-md flex items-center justify-center shrink-0">
        {checked && <Check size={11} color="#fff" />}
      </span>
      <span style={{ color: checked ? theme.textMuted : theme.text, textDecoration: checked && strike ? "line-through" : "none" }} className="text-[13px] truncate">
        {label}
      </span>
    </button>
  );
}

export function Toast({ theme, message, kind = "error", onDismiss }) {
  const timer = useRef();
  useEffect(() => {
    timer.current = setTimeout(onDismiss, 5000);
    return () => clearTimeout(timer.current);
  }, [message, onDismiss]);

  if (!message) return null;
  return (
    <div style={{ background: kind === "error" ? theme.danger : theme.success, color: "#fff" }}
      className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[80] px-4 py-2.5 rounded-xl text-[13px] font-medium shadow-lg max-w-sm" role="status">
      {message}
    </div>
  );
}

export function Spinner({ theme, label = "Загрузка…" }) {
  return <div style={{ color: theme.textMuted }} className="text-[13px] py-10 text-center">{label}</div>;
}

// Индикатор соединения реального времени — маленькая точка рядом с
// колокольчиком уведомлений: зелёная — события приходят мгновенно,
// серая — идёт переподключение, и данные обновляются только обычными
// REST-запросами до его восстановления.
export function RealtimeDot({ theme, status }) {
  const color = status === "connected" ? theme.success : theme.textMuted;
  const title = status === "connected" ? "Синхронизация в реальном времени" : "Переподключение…";
  return <span title={title} style={{ background: color }} className="w-1.5 h-1.5 rounded-full inline-block" />;
}
