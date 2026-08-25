import React, { useEffect, useRef, useState } from "react";
import {
  Pencil, Trash2, Calendar, Users as UsersIcon, Eye, Lock, Share2, Send, Upload,
  Paperclip, Download, ExternalLink, Check, X, Plus, CircleDot, CheckCircle2, RotateCcw, Video, Mail,
} from "lucide-react";
import { api } from "../lib/api.js";
import { onRealtimeMessage } from "../lib/realtime.js";
import { PRIORITIES, GRANT_LABEL, fmtDate, fmtDateTime, fmtRelative, fmtSize, resolveUser, conferenceLink, conferenceNames, taskMailLink } from "../lib/theme.js";
import { Avatar, Modal, ModalHeader, Checkbox, ConfirmDialog, inputStyle } from "../lib/ui.jsx";

// Заменяет элемент списка по id или добавляет новый в конец — общая
// операция и для собственных оптимистичных правок, и для событий,
// пришедших по WebSocket от других участников.
function upsertById(list, item) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = [...list];
  next[i] = item;
  return next;
}

export default function TaskDetail({ theme, task, directory, currentUser, onClose, onEdit, onTaskPatched, onRequestDelete, onError, onOpenUser, onOpenTask }) {
  const [tab, setTab] = useState("details");
  const [comments, setComments] = useState([]);
  const [files, setFiles] = useState([]);
  const [activity, setActivity] = useState([]);
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(true);

  const access = task.access;
  const canEdit = access === "edit";
  const readOnly = access === "read";
  const completed = Boolean(task.completedAt);
  const pr = PRIORITIES[task.priority] || PRIORITIES.medium;
  const assignees = task.assignees.map((id) => resolveUser(directory, id));

  // В конференцию зовём исполнителей, автора задачи и тех, кому она
  // открыта точечно, — то есть всех, кто по ней работает. Дубли
  // убираются по идентификатору, удалённые и безтелефонные отсеиваются
  // внутри conferenceLink.
  const confParticipants = [
    ...new Set([
      ...task.assignees,
      task.createdBy,
      ...(task.grants || []).map((g) => g.userId),
    ].filter(Boolean)),
  ]
    .map((id) => resolveUser(directory, id))
    .filter((u) => !u.deleted && u.phone);
  const confLink =
    confParticipants.length >= 2 ? conferenceLink(confParticipants, currentUser.id) : null;
  const confNames = conferenceNames(confParticipants, currentUser.id);

  // Незавершённые задачи, блокирующие эту.
  const blockedBy = links.filter(
    (l) => l.kind === "blocks" && l.toTask === task.id && !l.completed);

  // Отметка исполнителя: доступна, только если текущий пользователь сам
  // в списке исполнителей. Автор задачи, не будучи исполнителем, кнопки
  // не увидит — за него отметиться нельзя.
  const iAmAssignee = task.assignees.includes(currentUser.id);
  const doneIds = task.assigneesDone || [];
  const iMarkedDone = doneIds.includes(currentUser.id);

  const markAssignment = async (next) => {
    try {
      const updated = await api.completeAssignment(task.id, next);
      onTaskPatched(updated);
      reloadActivity();
    } catch (e) {
      onError(e.message);
    }
  };
  const mailLink = taskMailLink(confParticipants, task.title, currentUser.id);
  // Вызов уходит только после подтверждения: случайное нажатие
  // мгновенно поднимает трубку у нескольких человек сразу.
  const [pendingCall, setPendingCall] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([api.comments(task.id), api.attachments(task.id), api.activity(task.id),
                 api.taskLinks(task.id)])
      .then(([c, f, a, l]) => {
        if (!alive) return;
        setComments(c);
        setFiles(f);
        setActivity(a);
        setLinks(l);
      })
      .catch((e) => onError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [task.id, onError]);

  // Пока карточка открыта, подписываемся на события именно этой задачи —
  // так все её вкладки (и других пользователей с доступом) видят новый
  // комментарий, файл или отметку в чек-листе без перезапроса всей доски.
  useEffect(() => {
    const offComment = onRealtimeMessage("comment", (e) => {
      if (e.payload.taskId !== task.id) return;
      setComments((prev) =>
        e.action === "deleted" ? prev.filter((c) => c.id !== e.payload.id) : upsertById(prev, e.payload)
      );
    });
    const offAttachment = onRealtimeMessage("attachment", (e) => {
      if (e.payload.taskId !== task.id) return;
      setFiles((prev) =>
        e.action === "deleted" ? prev.filter((f) => f.id !== e.payload.id) : upsertById(prev, e.payload)
      );
    });
    return () => { offComment(); offAttachment(); };
  }, [task.id]);

  const reloadActivity = () => api.activity(task.id).then(setActivity).catch(() => {});

  const toggleComplete = async () => {
    try {
      const updated = await api.completeTask(task.id, !completed);
      onTaskPatched(updated);
      reloadActivity();
    } catch (e) {
      onError(e.message);
    }
  };

  return (
    <Modal theme={theme} onClose={onClose} width="max-w-lg" padded={false}>
      <div className="p-5 pb-3">
        <ModalHeader theme={theme} onClose={onClose} title={task.title}
          extra={canEdit && (
            <button onClick={() => onEdit(task)} style={{ color: theme.textMuted }} title="Редактировать"><Pencil size={16} /></button>
          )} />

        <div className="flex items-center gap-2 flex-wrap -mt-2 mb-3">
          <span style={{ background: theme[pr.color] }} className="w-2 h-2 rounded-full" />
          <span style={{ color: theme.textMuted }} className="text-[11px] uppercase tracking-wide font-medium">{pr.label}</span>
          {task.boardTitle && <span style={{ background: theme.surfaceAlt, color: theme.textMuted }} className="text-[10.5px] px-1.5 py-0.5 rounded">{task.boardTitle}</span>}
          {readOnly && (
            <span style={{ background: theme.surfaceAlt, color: theme.textMuted }} className="flex items-center gap-1 text-[10.5px] px-1.5 py-0.5 rounded">
              <Eye size={11} /> только просмотр
            </span>
          )}
          {access === "contribute" && (
            <span style={{ background: theme.surfaceAlt, color: theme.textMuted }} className="flex items-center gap-1 text-[10.5px] px-1.5 py-0.5 rounded">
              <Lock size={11} /> участие без редактирования
            </span>
          )}
          {completed && (
            <span style={{ background: theme.success, color: "#fff" }} className="flex items-center gap-1 text-[10.5px] px-1.5 py-0.5 rounded">
              <Check size={11} /> завершена
            </span>
          )}
        </div>

        {task.description && (
          <p style={{ color: theme.textMuted }} className="text-[13px] leading-relaxed mb-3 whitespace-pre-wrap">{task.description}</p>
        )}

        <div className="flex items-center gap-4 text-[12.5px]" style={{ color: theme.textMuted }}>
          <span className="flex items-center gap-1"><Calendar size={13} />{fmtDate(task.dueDate)}</span>
          <span className="flex items-center gap-1"><UsersIcon size={13} />{assignees.length}</span>
        </div>

        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          {assignees.map((u, i) => (
            <button key={`${u.id}-${i}`} onClick={() => onOpenUser(u)} style={{ background: theme.surfaceAlt }} className="flex items-center gap-1.5 pr-2 rounded-full">
              <Avatar user={u} size={24} theme={theme} />
              <span style={{ color: u.deleted ? theme.textMuted : theme.text, textDecoration: u.deleted ? "line-through" : "none" }} className="text-[12px]">
                {u.fullName}
              </span>
              {doneIds.includes(u.id) && (
                <Check size={12} style={{ color: theme.success }}
                  title="Исполнитель отметил свою часть выполненной" />
              )}
            </button>
          ))}
        </div>

        {/* Видеоконференция со всеми участниками задачи. Схема
            callto://n1&n2 собирает несколько номеров в один вызов —
            её понимают корпоративные клиенты связи, регистрирующие
            обработчик callto. Кнопка появляется, только когда есть
            хотя бы два участника с телефонами: звать на «конференцию»
            одного человека смысла нет, для этого есть видеозвонок
            в его карточке. */}
        {mailLink && (
          <a href={mailLink}
            style={{ background: theme.surfaceAlt, color: theme.text, border: `1px solid ${theme.border}` }}
            className="w-full mt-3 rounded-lg py-2.5 text-[12.5px] font-semibold flex items-center justify-center gap-2"
            title={`Написать: ${confNames}`}>
            <Mail size={15} style={{ color: theme.accent }} />
            <span className="flex flex-col items-start leading-tight">
              <span>Написать участникам</span>
              <span style={{ color: theme.textMuted }} className="text-[10.5px] font-normal">
                {confNames}
              </span>
            </span>
          </a>
        )}

        {confLink && (
          <button onClick={() => setPendingCall({ href: confLink, names: confNames })}
            style={{ background: theme.surfaceAlt, color: theme.text, border: `1px solid ${theme.border}` }}
            className="w-full mt-3 rounded-lg py-2.5 text-[13px] font-semibold flex items-center justify-center gap-2"
            title={`Собрать участников: ${confNames}`}>
            <Video size={15} style={{ color: theme.accent }} />
            <span className="flex flex-col items-start leading-tight">
              <span>Видеоконференция</span>
              <span style={{ color: theme.textMuted }} className="text-[11px] font-normal">
                {confNames}
              </span>
            </span>
          </button>
        )}

        {iAmAssignee && (
          <button onClick={() => markAssignment(!iMarkedDone)}
            style={{
              background: iMarkedDone ? theme.surfaceAlt : theme.accent,
              color: iMarkedDone ? theme.text : theme.accentText,
              border: `1px solid ${theme.border}`,
            }}
            className="w-full mt-3 rounded-lg py-2 text-[12.5px] font-semibold flex items-center justify-center gap-2">
            {iMarkedDone ? <RotateCcw size={14} /> : <Check size={14} />}
            {iMarkedDone ? "Снять мою отметку о выполнении" : "Я выполнил свою часть"}
          </button>
        )}

        {blockedBy.length > 0 && !completed && (
          <div style={{ background: theme.surfaceAlt, border: `1px solid ${theme.danger}` }}
            className="w-full mt-3 rounded-lg p-2.5 text-[12px] leading-snug"
            role="status">
            <span style={{ color: theme.danger }} className="font-semibold">Заблокирована. </span>
            <span style={{ color: theme.text }}>
              Нельзя завершить, пока не закрыты: {blockedBy.map((l) => `«${l.title}»`).join(", ")}.
            </span>
          </div>
        )}

        {canEdit && (
          <button onClick={toggleComplete}
            style={{ background: completed ? theme.surfaceAlt : theme.success, color: completed ? theme.text : "#fff", border: `1px solid ${theme.border}` }}
            className="w-full mt-4 rounded-lg py-2.5 text-[13px] font-semibold flex items-center justify-center gap-2">
            {completed ? <RotateCcw size={15} /> : <CheckCircle2 size={15} />}
            {completed ? "Вернуть в работу" : "Пометить завершённой"}
          </button>
        )}
      </div>

      <nav style={{ borderColor: theme.border }} className="flex border-t border-b px-5 overflow-x-auto">
        {[["details", "Детали"], ["comments", `Комментарии (${comments.length})`], ["files", `Файлы (${files.length})`], ["links", `Связи (${links.length})`], ["activity", "История"]].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            style={{ color: tab === key ? theme.text : theme.textMuted, borderColor: tab === key ? theme.accent : "transparent" }}
            className="px-3 py-2.5 text-[12.5px] font-medium border-b-2 -mb-px whitespace-nowrap">
            {label}
          </button>
        ))}
      </nav>

      {/* Содержимое вкладки прокручивается отдельно от шапки: иначе
          при длинной переписке приходилось бы листать всё окно, теряя
          из виду название задачи и переключатель вкладок. */}
      <div className="p-5 overflow-y-auto overscroll-contain" style={{ maxHeight: "42vh" }}>
        {loading && <p style={{ color: theme.textMuted }} className="text-[13px]">Загружаем…</p>}

        {!loading && tab === "details" && (
          <DetailsTab theme={theme} task={task} directory={directory} canEdit={canEdit} readOnly={readOnly}
            onTaskPatched={onTaskPatched} onError={onError} onRequestDelete={onRequestDelete} reloadActivity={reloadActivity} />
        )}

        {!loading && tab === "comments" && (
          <CommentsTab theme={theme} task={task} directory={directory} currentUser={currentUser}
            comments={comments} setComments={setComments} readOnly={readOnly} onError={onError} onOpenUser={onOpenUser} />
        )}

        {!loading && tab === "files" && (
          <FilesTab theme={theme} task={task} directory={directory} files={files} setFiles={setFiles} readOnly={readOnly} onError={onError} />
        )}

        {!loading && tab === "links" && (
          <LinksTab theme={theme} task={task} links={links} setLinks={setLinks}
            canEdit={canEdit} onError={onError} onOpenTask={onOpenTask} />
        )}

        {!loading && tab === "activity" && (
          <div>
            {activity.map((h) => (
              <div key={h.id} className="flex items-start gap-2 mb-2.5">
                <CircleDot size={12} style={{ color: theme.accent, marginTop: 3 }} />
                <div>
                  <div style={{ color: theme.text }} className="text-[13px]">{h.body}</div>
                  <div style={{ color: theme.textMuted }} className="text-[11px]">
                    {fmtDateTime(h.createdAt)}{h.actorId ? ` · ${resolveUser(directory, h.actorId).fullName}` : ""}
                  </div>
                </div>
              </div>
            ))}
            {activity.length === 0 && <p style={{ color: theme.textMuted }} className="text-[13px]">Записей нет.</p>}
          </div>
        )}
      </div>

      {pendingCall && (
        <ConfirmDialog theme={theme}
          title="Начать видеоконференцию?"
          message={`Вызов будет отправлен участникам: ${pendingCall.names}. Убедитесь, что это не случайное нажатие.`}
          confirmLabel="Позвонить" danger={false}
          onCancel={() => setPendingCall(null)}
          onConfirm={() => {
            const href = pendingCall.href;
            setPendingCall(null);
            window.location.href = href;
          }} />
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------- детали */

function DetailsTab({ theme, task, directory, canEdit, readOnly, onTaskPatched, onError, onRequestDelete, reloadActivity }) {
  const [newStep, setNewStep] = useState("");
  const [editingStep, setEditingStep] = useState(null);
  const [stepText, setStepText] = useState("");
  const [grantOpen, setGrantOpen] = useState(false);
  const [grantSearch, setGrantSearch] = useState("");

  // Патчим только массив steps внутри задачи и отдаём наверх — без
  // похода за всей задачей целиком. Именно это чинит прежде «неработавшую»
  // отметку выполнения: раньше клик по чекбоксу дожидался ответа и следом
  // перечитывал всю доску, и если пользователь успевал кликнуть дважды,
  // более медленный первый ответ перезаписывал уже обновлённое состояние.
  const patchSteps = (updater) => onTaskPatched({ ...task, steps: updater(task.steps) });

  const toggleStep = async (stepId, done) => {
    patchSteps((steps) => steps.map((s) => (s.id === stepId ? { ...s, done } : s)));
    try {
      const updated = await api.toggleStep(task.id, stepId, done);
      patchSteps((steps) => steps.map((s) => (s.id === stepId ? updated : s)));
    } catch (e) {
      patchSteps((steps) => steps.map((s) => (s.id === stepId ? { ...s, done: !done } : s)));
      onError(e.message);
    }
  };

  const renameStep = async (stepId, body) => {
    try {
      const updated = await api.renameStep(task.id, stepId, body);
      patchSteps((steps) => steps.map((s) => (s.id === stepId ? updated : s)));
    } catch (e) {
      onError(e.message);
    }
  };

  const addStep = async () => {
    const body = newStep.trim();
    if (!body) return;
    setNewStep("");
    try {
      const created = await api.createStep(task.id, body);
      patchSteps((steps) => [...steps, created]);
    } catch (e) {
      onError(e.message);
    }
  };

  const deleteStep = async (stepId) => {
    const prev = task.steps;
    patchSteps((steps) => steps.filter((s) => s.id !== stepId));
    try {
      await api.deleteStep(task.id, stepId);
    } catch (e) {
      onTaskPatched({ ...task, steps: prev });
      onError(e.message);
    }
  };

  const saveGrants = async (grants) => {
    try {
      const updated = await api.setGrants(task.id, grants);
      onTaskPatched(updated);
      reloadActivity();
    } catch (e) {
      onError(e.message);
    }
  };

  const candidates = directory
    .filter((u) => !u.deleted && !task.assignees.includes(u.id) && !task.grants.some((g) => g.userId === u.id))
    .filter((u) => u.fullName.toLowerCase().includes(grantSearch.toLowerCase()))
    .slice(0, 6);

  return (
    <div>
      {task.tags?.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {task.tags.map((t) => (
            <span key={t} style={{ background: theme.surfaceAlt, color: theme.textMuted }} className="text-[11px] px-2 py-1 rounded-md">#{t}</span>
          ))}
        </div>
      )}

      <div className="mb-4">
        <div style={{ color: theme.text }} className="text-[13px] font-medium mb-2">Чек-лист</div>

        {task.steps.length === 0 && <p style={{ color: theme.textMuted }} className="text-[12.5px] mb-2">Шаги не заданы.</p>}

        {task.steps.map((s) => (
          <div key={s.id} className="flex items-center gap-2 mb-1.5 group">
            {editingStep === s.id ? (
              <>
                <input value={stepText} onChange={(e) => setStepText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && stepText.trim()) { setEditingStep(null); renameStep(s.id, stepText.trim()); }
                    if (e.key === "Escape") setEditingStep(null);
                  }}
                  autoFocus style={inputStyle(theme)} className="flex-1 rounded-lg px-2.5 py-1.5 text-[13px] outline-none" />
                <button onClick={() => { setEditingStep(null); if (stepText.trim()) renameStep(s.id, stepText.trim()); }} style={{ color: theme.success }}><Check size={15} /></button>
                <button onClick={() => setEditingStep(null)} style={{ color: theme.textMuted }}><X size={15} /></button>
              </>
            ) : (
              <>
                <Checkbox theme={theme} checked={s.done} disabled={readOnly} strike label={s.body}
                  onChange={(next) => toggleStep(s.id, next)} />
                {canEdit && (
                  <span className="ml-auto flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => { setEditingStep(s.id); setStepText(s.body); }} style={{ color: theme.textMuted }} title="Изменить текст"><Pencil size={13} /></button>
                    <button onClick={() => deleteStep(s.id)} style={{ color: theme.danger }} title="Удалить шаг"><Trash2 size={13} /></button>
                  </span>
                )}
              </>
            )}
          </div>
        ))}

        {canEdit && (
          <div className="flex items-center gap-2 mt-2">
            <input value={newStep} onChange={(e) => setNewStep(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addStep()}
              placeholder="Новый шаг" style={inputStyle(theme)} className="flex-1 rounded-lg px-2.5 py-1.5 text-[13px] outline-none" />
            <button onClick={addStep} style={{ background: theme.accent, color: theme.accentText }} className="rounded-lg p-2"><Plus size={14} /></button>
          </div>
        )}
      </div>

      {canEdit && (
        <div className="mb-4">
          <button onClick={() => setGrantOpen((v) => !v)} style={{ color: theme.accent }} className="flex items-center gap-1.5 text-[12.5px] font-medium">
            <Share2 size={13} /> Доступ к задаче{task.grants.length > 0 && ` (${task.grants.length})`}
          </button>

          {task.grants.map((g) => {
            const u = resolveUser(directory, g.userId);
            return (
              <div key={g.userId} className="flex items-center gap-2 mt-2">
                <Avatar user={u} size={22} theme={theme} />
                <span style={{ color: theme.text }} className="text-[12.5px] flex-1 truncate">{u.fullName}</span>
                <span style={{ color: theme.textMuted }} className="text-[11.5px]">{GRANT_LABEL[g.access]}</span>
                <button onClick={() => saveGrants(task.grants.filter((x) => x.userId !== g.userId))} style={{ color: theme.danger }} title="Отозвать доступ"><X size={13} /></button>
              </div>
            );
          })}

          {grantOpen && (
            <div style={{ background: theme.surfaceAlt, border: `1px solid ${theme.border}` }} className="rounded-xl p-2.5 mt-2">
              <input value={grantSearch} onChange={(e) => setGrantSearch(e.target.value)} placeholder="Найти сотрудника"
                style={inputStyle(theme)} className="w-full rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none mb-2" />
              {candidates.map((u) => (
                <div key={u.id} className="flex items-center gap-2 py-1">
                  <Avatar user={u} size={20} theme={theme} />
                  <span style={{ color: theme.text }} className="text-[12.5px] flex-1 truncate">{u.fullName}</span>
                  <button onClick={() => saveGrants([...task.grants, { userId: u.id, access: "read" }])} style={{ color: theme.textMuted, border: `1px solid ${theme.border}` }} className="text-[11px] px-1.5 py-0.5 rounded">Просмотр</button>
                  <button onClick={() => saveGrants([...task.grants, { userId: u.id, access: "contribute" }])} style={{ color: theme.accent, border: `1px solid ${theme.border}` }} className="text-[11px] px-1.5 py-0.5 rounded">Участие</button>
                </div>
              ))}
              {candidates.length === 0 && <p style={{ color: theme.textMuted }} className="text-[12px]">Никого не найдено.</p>}
              <p style={{ color: theme.textMuted }} className="text-[11.5px] mt-2 leading-relaxed">
                Человек получит только эту задачу — остальная доска останется закрытой. Она появится у него в разделе «Входящие».
              </p>
            </div>
          )}
        </div>
      )}

      {canEdit && (
        <button onClick={() => onRequestDelete(task.id)} style={{ color: theme.danger }} className="flex items-center gap-1.5 text-[12.5px] font-medium">
          <Trash2 size={13} /> Удалить задачу
        </button>
      )}
    </div>
  );
}

/* -------------------------------------------------------- комментарии */

function CommentsTab({ theme, task, directory, currentUser, comments, setComments, readOnly, onError, onOpenUser }) {
  const [text, setText] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    try {
      const created = await api.addComment(task.id, body);
      setComments((prev) => upsertById(prev, created));
    } catch (e) {
      onError(e.message);
    }
  };

  const saveEdit = async (id) => {
    const body = editText.trim();
    if (!body) return;
    try {
      const updated = await api.editComment(id, body);
      setComments((prev) => upsertById(prev, updated));
      setEditingId(null);
    } catch (e) {
      onError(e.message);
    }
  };

  const remove = async (id) => {
    try {
      await api.deleteComment(id);
      setComments((prev) => prev.filter((c) => c.id !== id));
    } catch (e) {
      onError(e.message);
    }
  };

  return (
    <div>
      {comments.map((c) => {
        const author = resolveUser(directory, c.authorId);
        const mine = c.authorId === currentUser.id;
        return (
          <div key={c.id} className="flex gap-2 mb-3.5 group">
            <button onClick={() => onOpenUser(author)} className="shrink-0"><Avatar user={author} size={26} theme={theme} /></button>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span style={{ color: author.deleted ? theme.textMuted : theme.text }} className="text-[12.5px] font-semibold">{author.fullName}</span>
                <span style={{ color: theme.textMuted }} className="text-[11px]" title={fmtDateTime(c.createdAt)}>{fmtRelative(c.createdAt)}</span>
                {c.editedAt && (
                  <span style={{ color: theme.textMuted }} className="text-[11px] italic" title={`Изменено ${fmtDateTime(c.editedAt)}`}>изменено {fmtRelative(c.editedAt)}</span>
                )}
                {mine && editingId !== c.id && (
                  <span className="ml-auto flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => { setEditingId(c.id); setEditText(c.body); }} style={{ color: theme.textMuted }}><Pencil size={12} /></button>
                    <button onClick={() => remove(c.id)} style={{ color: theme.danger }}><Trash2 size={12} /></button>
                  </span>
                )}
              </div>

              {editingId === c.id ? (
                <div className="flex items-center gap-2 mt-1">
                  <input value={editText} onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") saveEdit(c.id); if (e.key === "Escape") setEditingId(null); }}
                    autoFocus style={inputStyle(theme)} className="flex-1 rounded-lg px-2.5 py-1.5 text-[13px] outline-none" />
                  <button onClick={() => saveEdit(c.id)} style={{ color: theme.success }}><Check size={15} /></button>
                  <button onClick={() => setEditingId(null)} style={{ color: theme.textMuted }}><X size={15} /></button>
                </div>
              ) : (
                <p style={{ color: theme.text }} className="text-[13px] leading-snug break-words whitespace-pre-wrap">{c.body}</p>
              )}
            </div>
          </div>
        );
      })}

      {comments.length === 0 && <p style={{ color: theme.textMuted }} className="text-[13px]">Комментариев пока нет. Начните обсуждение.</p>}

      {readOnly ? (
        <p style={{ color: theme.textMuted }} className="text-[12px] mt-4">Доступ только на просмотр — комментировать нельзя.</p>
      ) : (
        <div className="flex items-center gap-2 mt-4">
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Написать комментарий" style={inputStyle(theme)} className="flex-1 rounded-lg px-3 py-2 text-[13px] outline-none" />
          <button onClick={send} style={{ background: theme.accent, color: theme.accentText }} className="rounded-lg p-2.5"><Send size={15} /></button>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- файлы */

function FilesTab({ theme, task, directory, files, setFiles, readOnly, onError }) {
  const inputRef = useRef();
  const [uploading, setUploading] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [renameText, setRenameText] = useState("");

  const upload = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const created = await api.uploadAttachment(task.id, file);
      setFiles((prev) => upsertById(prev, created));
    } catch (e) {
      onError(e.message);
    } finally {
      setUploading(false);
    }
  };

  const rename = async (id) => {
    const title = renameText.trim();
    if (!title) return;
    try {
      const updated = await api.renameAttachment(id, title);
      setFiles((prev) => upsertById(prev, updated));
      setRenamingId(null);
    } catch (e) {
      onError(e.message);
    }
  };

  const remove = async (id) => {
    try {
      await api.deleteAttachment(id);
      setFiles((prev) => prev.filter((f) => f.id !== id));
    } catch (e) {
      onError(e.message);
    }
  };

  return (
    <div>
      {files.map((f) => {
        const author = resolveUser(directory, f.authorId);
        const isImage = f.mime?.startsWith("image/");
        return (
          <div key={f.id} style={{ background: theme.surfaceAlt, border: `1px solid ${theme.border}` }} className="rounded-xl p-2.5 mb-2 group">
            <div className="flex items-center gap-2">
              {isImage ? (
                <img src={api.attachmentUrl(f.id)} alt={f.title} className="w-10 h-10 rounded-lg object-cover shrink-0" style={{ border: `1px solid ${theme.border}` }} />
              ) : (
                <span style={{ background: theme.surface, color: theme.textMuted }} className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"><Paperclip size={16} /></span>
              )}

              <div className="min-w-0 flex-1">
                {renamingId === f.id ? (
                  <div className="flex items-center gap-1.5">
                    <input value={renameText} onChange={(e) => setRenameText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") rename(f.id); if (e.key === "Escape") setRenamingId(null); }}
                      autoFocus style={inputStyle(theme)} className="flex-1 rounded-lg px-2 py-1 text-[12.5px] outline-none" />
                    <button onClick={() => rename(f.id)} style={{ color: theme.success }}><Check size={14} /></button>
                    <button onClick={() => setRenamingId(null)} style={{ color: theme.textMuted }}><X size={14} /></button>
                  </div>
                ) : (
                  <div style={{ color: theme.text }} className="text-[12.5px] font-medium truncate">{f.title || f.filename}</div>
                )}
                <div style={{ color: theme.textMuted }} className="text-[11px] truncate">
                  {fmtSize(f.size)} · {author.fullName} · {fmtRelative(f.createdAt)}
                  {f.editedAt && <span title={`Изменено ${fmtDateTime(f.editedAt)}`}> · изменено</span>}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {f.previewable && (
                  <a href={api.attachmentUrl(f.id)} target="_blank" rel="noreferrer" style={{ color: theme.textMuted }} title="Открыть в браузере"><ExternalLink size={14} /></a>
                )}
                <a href={api.attachmentUrl(f.id, true)} style={{ color: theme.textMuted }} title="Скачать" download><Download size={14} /></a>
                {f.canEdit && (
                  <>
                    <button onClick={() => { setRenamingId(f.id); setRenameText(f.title || f.filename); }} style={{ color: theme.textMuted }} title="Переименовать"><Pencil size={13} /></button>
                    <button onClick={() => remove(f.id)} style={{ color: theme.danger }} title="Удалить"><Trash2 size={13} /></button>
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {files.length === 0 && <p style={{ color: theme.textMuted }} className="text-[13px] mb-3">Файлов нет.</p>}

      {!readOnly && (
        <>
          <input ref={inputRef} type="file" className="hidden" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ""; }} />
          <button onClick={() => inputRef.current?.click()} disabled={uploading} style={{ color: theme.accent, border: `1px dashed ${theme.border}` }}
            className="w-full flex items-center justify-center gap-1.5 text-[12.5px] font-medium rounded-lg py-2.5 mt-2 disabled:opacity-50">
            <Upload size={14} /> {uploading ? "Загружаем…" : "Загрузить файл"}
          </button>
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- связи */

// У связи два конца, и читается она с них по-разному. Раньше подпись
// бралась одна и та же в обе стороны — из-за этого и подзадача, и её
// родитель показывались как «Подзадача», что бессмысленно.
const LINK_KINDS = {
  blocks: {
    out: "Блокирует", in: "Заблокирована задачей",
    hint: "пока блокирующая задача не завершена, эту закрыть нельзя",
  },
  relates: {
    out: "Связана с", in: "Связана с",
    hint: "задачи касаются одного вопроса",
  },
  subtask: {
    // Направление: from — родитель, to — часть работы.
    out: "Подзадача", in: "Родительская задача",
    hint: "часть более крупной работы",
  },
};

function LinksTab({ theme, task, links, setLinks, canEdit, onError, onOpenTask }) {
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("relates");
  const [found, setFound] = useState([]);
  const [searching, setSearching] = useState(false);

  // Поиск задач для связывания идёт по уже загруженной доске, а не
  // отдельным запросом: связывают почти всегда внутри одного проекта,
  // а серверный поиск по всем доступным задачам — отдельная работа.
  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) { setFound([]); return; }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const all = await api.tasks(task.boardId);
        setFound(all
          .filter((t) => t.id !== task.id && t.title.toLowerCase().includes(q))
          .filter((t) => !links.some((l) => l.toTask === t.id || l.fromTask === t.id))
          .slice(0, 6));
      } catch (e) {
        onError(e.message);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, task.id, task.boardId, links, onError]);

  const add = async (toTask) => {
    try {
      const created = await api.createTaskLink(task.id, toTask, kind);
      setLinks((prev) => [...prev, created]);
      setAdding(false);
      setQuery("");
    } catch (e) {
      onError(e.message);
    }
  };

  const remove = async (id) => {
    try {
      await api.deleteTaskLink(id);
      setLinks((prev) => prev.filter((l) => l.id !== id));
    } catch (e) {
      onError(e.message);
    }
  };

  return (
    <div>
      {links.map((l) => {
        // Направление важно: «блокирует» и «заблокирована» — это одна
        // строка, прочитанная с разных концов.
        const outgoing = l.fromTask === task.id;
        const info = LINK_KINDS[l.kind] || LINK_KINDS.relates;
        const label = outgoing ? info.out : info.in;
        // Незакрытая блокирующая задача — причина, по которой эту
        // нельзя завершить. Показываем это явно, а не оставляем
        // человека гадать над отказом сервера.
        const blocking = l.kind === "blocks" && !outgoing && !l.completed;
        return (
          <div key={l.id} style={{ background: theme.surfaceAlt, border: `1px solid ${theme.border}` }}
            className="rounded-xl p-2.5 mb-1.5 flex items-center gap-2 group">
            <span className="mono text-[9.5px] uppercase px-1.5 py-0.5 rounded shrink-0"
              style={{
                background: blocking ? theme.danger : theme.surface,
                color: blocking ? "#fff" : theme.textMuted,
              }}
              title={info.hint}>
              {label}
            </span>
            <button onClick={() => onOpenTask && onOpenTask(l.toTask === task.id ? l.fromTask : l.toTask)}
              className="flex-1 min-w-0 text-left">
              <span style={{
                color: theme.text,
                textDecoration: l.completed ? "line-through" : "none",
                opacity: l.completed ? 0.65 : 1,
              }} className="text-[12.5px] truncate block">
                {l.title}
              </span>
            </button>
            {canEdit && (
              <button onClick={() => remove(l.id)} style={{ color: theme.danger }}
                className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                <X size={13} />
              </button>
            )}
          </div>
        );
      })}

      {links.length === 0 && (
        <p style={{ color: theme.textMuted }} className="text-[13px] mb-3">Связей нет.</p>
      )}

      {canEdit && !adding && (
        <button onClick={() => setAdding(true)}
          style={{ color: theme.accent, border: `1px dashed ${theme.border}` }}
          className="w-full flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-[12.5px] font-medium mt-2">
          <Plus size={14} /> Связать с задачей
        </button>
      )}

      {adding && (
        <div style={{ background: theme.surfaceAlt, border: `1px solid ${theme.border}` }}
          className="rounded-xl p-2.5 mt-2">
          <div className="flex gap-1.5 mb-2">
            {Object.entries(LINK_KINDS).map(([k, v]) => (
              <button key={k} onClick={() => setKind(k)} title={v.hint}
                style={{
                  background: kind === k ? theme.accent : theme.surface,
                  color: kind === k ? theme.accentText : theme.text,
                  border: `1px solid ${theme.border}`,
                }}
                className="flex-1 rounded-lg py-1.5 text-[11.5px] font-medium">
                {v.label}
              </button>
            ))}
          </div>
          <input value={query} onChange={(e) => setQuery(e.target.value)} autoFocus
            placeholder="Название задачи (от двух символов)" style={inputStyle(theme)}
            className="w-full rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none mb-1.5" />

          {searching && (
            <p style={{ color: theme.textMuted }} className="text-[12px] py-1">Ищем…</p>
          )}
          {found.map((t) => (
            <button key={t.id} onClick={() => add(t.id)}
              style={{ color: theme.text }}
              className="w-full text-left px-2 py-1.5 rounded-lg text-[12.5px] truncate hover:opacity-80">
              {t.title}
            </button>
          ))}
          {!searching && query.trim().length >= 2 && found.length === 0 && (
            <p style={{ color: theme.textMuted }} className="text-[12px] py-1">
              Ничего не найдено в этом проекте.
            </p>
          )}

          <button onClick={() => { setAdding(false); setQuery(""); }}
            style={{ color: theme.textMuted }} className="text-[12px] mt-1.5">
            Отмена
          </button>
        </div>
      )}
    </div>
  );
}
