import * as XLSX from "xlsx";
import { PRIORITIES, fmtDate, resolveUser, dueLevel } from "./theme.js";

// Экспорт формируется на клиенте из уже загруженных задач.
//
// Причина: выгружается ровно то, что человек видит на экране, с
// применёнными фильтрами. Серверный экспорт пришлось бы кормить теми
// же параметрами фильтрации, дублируя их логику, и рано или поздно
// выгрузка разошлась бы с экраном — а именно этому отчёту потом верят.
//
// Ограничение подхода: очень большие выгрузки (десятки тысяч строк)
// упрутся в память вкладки. Для таких объёмов понадобится серверная
// генерация потоком, но на обычной доске это не встречается.

const COLUMNS = [
  // Порядок для чтения человеком, а не для удобства кода: сначала
  // «где и что», затем «кто и в каком состоянии», и только потом
  // реквизиты и подробности.
  { key: "boardTitle",     label: "Проект", width: 26 },
  { key: "title",          label: "Задача", width: 46 },
  { key: "author",         label: "Автор", width: 24 },
  { key: "status",         label: "Статус", width: 16 },
  { key: "priority",       label: "Приоритет", width: 18 },
  { key: "incomingNumber", label: "Входящий №", width: 16 },
  { key: "incomingDate",   label: "Дата документа", width: 15 },
  { key: "columnTitle",    label: "Этап", width: 18 },
  { key: "dueDate",        label: "Срок исполнения", width: 16 },
  { key: "dueState",       label: "Состояние срока", width: 22 },
  { key: "assignees",      label: "Исполнители", width: 34 },
  { key: "doneBy",         label: "Отметили выполнение", width: 34 },
  { key: "steps",          label: "Чек-лист", width: 12 },
  { key: "comments",       label: "Комментариев", width: 14 },
  { key: "createdAt",      label: "Создана", width: 14 },
];

function taskRow(task, { directory, columns, boardTitle }) {
  const column = columns.find((c) => c.id === task.columnId);
  const completed = Boolean(task.completedAt);
  const level = dueLevel(task.dueDate, completed);
  const names = (ids) =>
    (ids || []).map((id) => resolveUser(directory, id).fullName).join(", ");

  return {
    incomingNumber: task.incomingNumber || "",
    incomingDate: task.incomingDate ? fmtDate(task.incomingDate) : "",
    title: task.title,
    boardTitle: task.boardTitle || boardTitle || "",
    columnTitle: column?.title || "",
    priority: PRIORITIES[task.priority]?.label || task.priority,
    dueDate: task.dueDate ? fmtDate(task.dueDate) : "",
    dueState: completed ? "—" : level?.label || "",
    assignees: names(task.assignees),
    doneBy: names(task.assigneesDone),
    author: resolveUser(directory, task.createdBy).fullName,
    status: completed ? "Завершена" : "В работе",
    steps: task.steps?.length
      ? `${task.steps.filter((s) => s.done).length} из ${task.steps.length}`
      : "",
    comments: task.commentCount || 0,
    createdAt: fmtDate(task.createdAt),
  };
}

export function exportTasksToExcel(tasks, { directory, columns = [], boardTitle = "", fileName } = {}) {
  const rows = tasks.map((t) => taskRow(t, { directory, columns, boardTitle }));

  const sheet = XLSX.utils.json_to_sheet(rows, {
    header: COLUMNS.map((c) => c.key),
  });

  // Подписи вместо служебных ключей: без этого в первой строке будет
  // incomingNumber и boardTitle, что читателю отчёта ничего не говорит.
  XLSX.utils.sheet_add_aoa(sheet, [COLUMNS.map((c) => c.label)], { origin: "A1" });

  sheet["!cols"] = COLUMNS.map((c) => ({ wch: c.width }));
  // Закрепление шапки: на длинной выгрузке без него уже к сотой строке
  // непонятно, какой столбец что означает.
  sheet["!freeze"] = { xSplit: 0, ySplit: 1 };
  sheet["!autofilter"] = {
    ref: XLSX.utils.encode_range({
      s: { c: 0, r: 0 },
      e: { c: COLUMNS.length - 1, r: rows.length },
    }),
  };

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Задачи");

  // Метка времени до секунды: выгрузки делают подряд, и файлы с
  // одинаковым именем перезаписывали бы друг друга в папке загрузок.
  // Заодно из имени видно, на какой момент собраны данные.
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const safeName = (boardTitle || "задачи").replace(/[\\/:*?"<>|]/g, "-").slice(0, 60);
  XLSX.writeFile(book, fileName || `${safeName} ${stamp}.xlsx`);

  return rows.length;
}
