import React, { useState } from "react";
import { LayoutGrid } from "lucide-react";
import { api } from "../lib/api.js";
import { Field, inputStyle } from "../lib/ui.jsx";

export default function Login({ theme, onSuccess }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ email: "", password: "", fullName: "", position: "", phone: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    setError("");
    setBusy(true);
    try {
      const user = mode === "login"
        ? await api.login(form.email.trim(), form.password)
        : await api.register({ email: form.email.trim(), password: form.password, fullName: form.fullName.trim(), position: form.position.trim(), phone: form.phone.trim() });
      onSuccess(user);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ background: theme.bg }} className="min-h-screen flex items-center justify-center p-4">
      <div style={{ background: theme.surface, border: `1px solid ${theme.border}` }} className="w-full max-w-sm rounded-2xl p-6">
        <div className="flex items-center gap-2 mb-1">
          <LayoutGrid size={22} style={{ color: theme.accent }} />
          <span style={{ color: theme.text, fontFamily: "Space Grotesk, sans-serif" }} className="font-bold text-[19px]">Команда</span>
        </div>
        <p style={{ color: theme.textMuted }} className="text-[13px] mb-5">{mode === "login" ? "Вход в систему планирования задач" : "Создание учётной записи"}</p>

        {mode === "register" && (
          <>
            <Field label="ФИО" theme={theme}><input value={form.fullName} onChange={(e) => set("fullName", e.target.value)} style={inputStyle(theme)} className="w-full rounded-lg px-3 py-2 text-[13.5px] outline-none" placeholder="Иванов Иван" /></Field>
            <Field label="Должность" theme={theme}><input value={form.position} onChange={(e) => set("position", e.target.value)} style={inputStyle(theme)} className="w-full rounded-lg px-3 py-2 text-[13.5px] outline-none" placeholder="Frontend-разработчик" /></Field>
            <Field label="Телефон" theme={theme}><input value={form.phone} onChange={(e) => set("phone", e.target.value)} style={inputStyle(theme)} className="w-full rounded-lg px-3 py-2 text-[13.5px] outline-none" placeholder="+7 900 000-00-00" /></Field>
          </>
        )}

        <Field label="Электронная почта" theme={theme}>
          <input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} autoFocus style={inputStyle(theme)} className="w-full rounded-lg px-3 py-2 text-[13.5px] outline-none" placeholder="name@team.dev" />
        </Field>
        <Field label="Пароль" theme={theme} hint={mode === "register" ? "Не короче 10 символов" : undefined}>
          <input type="password" value={form.password} onChange={(e) => set("password", e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} style={inputStyle(theme)} className="w-full rounded-lg px-3 py-2 text-[13.5px] outline-none" />
        </Field>

        {error && <p style={{ color: theme.danger }} className="text-[12.5px] mb-3">{error}</p>}

        <button onClick={submit} disabled={busy} style={{ background: theme.accent, color: theme.accentText }} className="w-full rounded-lg py-2.5 text-[13.5px] font-semibold disabled:opacity-50">
          {busy ? "Подождите…" : mode === "login" ? "Войти" : "Зарегистрироваться"}
        </button>
        <button onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }} style={{ color: theme.textMuted }} className="w-full text-[12.5px] mt-3">
          {mode === "login" ? "Нет учётной записи? Зарегистрироваться" : "Уже есть учётная запись? Войти"}
        </button>

        {/* Регистрация по умолчанию закрыта — учётные записи заводит
            администратор. Форма остаётся доступной, потому что на
            совершенно пустой базе через неё создаётся первый
            администратор, и потому что установку можно перевести в
            открытый режим переменной ALLOW_SELF_REGISTRATION. */}
        {mode === "register" && (
          <p style={{ color: theme.textMuted }} className="text-[11.5px] mt-3 leading-relaxed text-center">
            Если регистрация закрыта, учётную запись создаст администратор.
            На пустой системе первая созданная запись получает права администратора.
          </p>
        )}
      </div>
    </div>
  );
}
