import React, { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "../lib/api.js";
import { onRealtimeMessage } from "../lib/realtime.js";
import { fmtRelative, fmtDateTime } from "../lib/theme.js";

const PAGE_SIZE = 10;

export default function Notifications({ theme, onCountChange, onOpenTask }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [includeRead, setIncludeRead] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (targetPage = page, read = includeRead) => {
    setLoading(true);
    try {
      const data = await api.notifications({ limit: PAGE_SIZE, offset: (targetPage - 1) * PAGE_SIZE, includeRead: read });
      setItems(data.items);
      setTotal(data.total);
      onCountChange(data.unread);
    } finally {
      setLoading(false);
    }
  }, [page, includeRead, onCountChange]);

  useEffect(() => { load(page, includeRead); }, [page, includeRead, load]);

  // Пока панель открыта на первой странице непрочитанных, новое
  // уведомление подставляется в список сразу — обновление счётчика на
  // колокольчике происходит централизованно в App.jsx независимо от
  // того, открыта ли эта панель вообще.
  useEffect(() => {
    return onRealtimeMessage("notification", () => {
      if (page === 1) load(1, includeRead);
    });
  }, [page, includeRead, load]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const markRead = async (n) => {
    if (!n.read) {
      await api.readNotification(n.id);
      load(page, includeRead);
    }
    if (n.taskId) onOpenTask(n);
  };

  const markAll = async () => {
    await api.readAllNotifications();
    setPage(1);
    load(1, includeRead);
  };

  return (
    <div style={{ background: theme.surface, border: `1px solid ${theme.border}` }} className="absolute top-full mt-1 right-0 rounded-xl shadow-xl z-30 w-80">
      <div style={{ borderColor: theme.border }} className="flex items-center justify-between px-3 py-2.5 border-b">
        <span style={{ color: theme.text }} className="text-[13px] font-semibold">Уведомления</span>
        <div className="flex items-center gap-2.5">
          <button onClick={() => { setPage(1); setIncludeRead((v) => !v); }} style={{ color: theme.textMuted }} title={includeRead ? "Скрыть прочитанные" : "Показать прочитанные"}>
            {includeRead ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          <button onClick={markAll} style={{ color: theme.accent }} className="text-[11.5px] font-medium">Прочитать все</button>
        </div>
      </div>

      <div className="max-h-72 overflow-y-auto p-1.5">
        {loading && <p style={{ color: theme.textMuted }} className="text-[12.5px] text-center py-6">Загружаем…</p>}
        {!loading && items.map((n) => (
          <button key={n.id} onClick={() => markRead(n)} style={{ background: n.read ? "transparent" : theme.surfaceAlt, color: theme.text }} className="w-full text-left px-2.5 py-2 rounded-lg text-[12.5px] flex items-start gap-2 mb-0.5">
            {!n.read && <span style={{ background: theme.accent }} className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0" />}
            <span className="flex-1">
              {n.body}
              <span style={{ color: theme.textMuted }} className="block text-[11px] mt-0.5" title={fmtDateTime(n.createdAt)}>{fmtRelative(n.createdAt)}</span>
            </span>
          </button>
        ))}
        {!loading && items.length === 0 && (
          <p style={{ color: theme.textMuted }} className="text-[12.5px] text-center py-6 px-3 leading-relaxed">
            {includeRead ? (
              "Уведомлений нет."
            ) : (
              <>
                Непрочитанных нет.
                <button onClick={() => { setPage(1); setIncludeRead(true); }}
                  style={{ color: theme.accent }} className="block mx-auto mt-1.5 font-medium">
                  Показать прочитанные
                </button>
              </>
            )}
          </p>
        )}
      </div>

      {pages > 1 && (
        <div style={{ borderColor: theme.border }} className="flex items-center justify-between px-3 py-2 border-t">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} style={{ color: theme.textMuted, opacity: page === 1 ? 0.4 : 1 }} className="flex items-center gap-1 text-[12px]">
            <ChevronLeft size={13} /> Назад
          </button>
          <span style={{ color: theme.textMuted }} className="text-[11.5px]">{page} из {pages}</span>
          <button onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page === pages} style={{ color: theme.textMuted, opacity: page === pages ? 0.4 : 1 }} className="flex items-center gap-1 text-[12px]">
            Далее <ChevronRight size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
