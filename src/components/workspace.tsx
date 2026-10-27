"use client";

import { useEffect, useRef, useState } from "react";
import { issueTurnstileToken } from "@/components/turnstile";
import { runStatusText, runsSettled, type PublicRun } from "@/domain/comparison/view";
import {
  CHAT_SHORTCUT_MODEL,
  CODE_SHORTCUT_MODEL,
  COMPARISON_MODEL_IDS,
  LIGHT_SHORTCUT_MODEL,
  REQUEST_FAILED_MESSAGE,
  SENDING_MESSAGE,
  comparisonFailureMessage,
  emptyQuestionMessage,
} from "@/domain/workspace-start";

type PublicModel = {
  id: string;
  displayName: string;
  taskType: string;
  availability: string;
  usagePolicy: string;
};

const empty = {
  question: "",
  evidenceMode: "native",
  answerModelIds: [...COMPARISON_MODEL_IDS],
};

function sameModelSet(current: readonly string[], expected: readonly string[]): boolean {
  return current.length === expected.length && expected.every((id) => current.includes(id));
}

export function Workspace() {
  const [models, setModels] = useState<PublicModel[]>([]);
  const [question, setQuestion] = useState(empty.question);
  const [selected, setSelected] = useState<string[]>(empty.answerModelIds);
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<{ name: string; status: string }[]>([]);
  const [runs, setRuns] = useState<PublicRun[]>([]);
  const [asked, setAsked] = useState("");
  const sending = useRef(false);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    void fetch("/api/models")
      .then((response) => response.json())
      .then((body: { data?: PublicModel[] }) => setModels(body.data ?? []))
      .catch(() => setMessage("تعذر تحميل سجل النماذج"));
  }, []);

  useEffect(() => () => {
    if (pollRef.current) window.clearInterval(pollRef.current);
  }, []);

  function toggle(id: string) {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  async function protectedPost(path: string, action: string, payload: Record<string, unknown>) {
    let token = "";
    try {
      token = await issueTurnstileToken(action);
    } catch {
      token = "";
    }
    let response: Response;
    try {
      response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, "cf-turnstile-response": token }),
      });
    } catch {
      throw new Error(REQUEST_FAILED_MESSAGE);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(comparisonFailureMessage(body));
    return body;
  }

  async function refreshComparison(id: string) {
    const response = await fetch(`/api/comparisons/${id}`);
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(comparisonFailureMessage(body));
    const next = comparisonRuns(body);
    setRuns(next);
    if (runsSettled(next) && pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function send(answerModelIds: string[]) {
    const missing = emptyQuestionMessage(question);
    if (missing) {
      setMessage(missing);
      return;
    }
    if (sending.current) return;
    sending.current = true;
    setMessage(SENDING_MESSAGE);
    setRuns([]);
    setAsked(question.trim());
    try {
      const body = await protectedPost("/api/comparisons", "comparison", {
        question: question.trim(),
        evidenceMode: "native",
        answerModelIds,
        idempotencyKey: crypto.randomUUID(),
      });
      const id = comparisonId(body);
      const next = comparisonRuns(body);
      setRuns(next);
      setMessage(id ? "أُرسلت المقارنة." : SENDING_MESSAGE);
      if (id && !runsSettled(next)) {
        if (pollRef.current) window.clearInterval(pollRef.current);
        pollRef.current = window.setInterval(() => {
          void refreshComparison(id).catch((error: unknown) => {
            setMessage(error instanceof Error ? error.message : REQUEST_FAILED_MESSAGE);
          });
        }, 1200);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : REQUEST_FAILED_MESSAGE);
    } finally {
      sending.current = false;
    }
  }

  function startShortcut(modelId: string) {
    const answerModelIds = [modelId];
    setSelected(answerModelIds);
    void send(answerModelIds);
  }

  async function chooseFiles(list: FileList | null) {
    const next = [...(list ?? [])].map((file) => ({ name: file.name, status: "بانتظار الرفع" }));
    setFiles(next);
    if (next.length === 0) return;
    setMessage("");
    try {
      await protectedPost("/api/uploads", "upload", { files: next.map((file) => file.name) });
      setFiles(next.map((file) => ({ ...file, status: "قُبل طلب الرفع" })));
    } catch (error) {
      const status = error instanceof Error ? error.message : REQUEST_FAILED_MESSAGE;
      setFiles(next.map((file) => ({ ...file, status: "تعذر الرفع" })));
      setMessage(status);
    }
  }

  const groups = new Map<string, PublicModel[]>();
  for (const model of models) {
    const list = groups.get(model.taskType) ?? [];
    list.push(model);
    groups.set(model.taskType, list);
  }

  const compareSelected = sameModelSet(selected, empty.answerModelIds);
  const chatSelected = selected.length === 1 && selected[0] === CHAT_SHORTCUT_MODEL;
  const codeSelected = selected.length === 1 && selected[0] === CODE_SHORTCUT_MODEL;
  const lightSelected = selected.length === 1 && selected[0] === LIGHT_SHORTCUT_MODEL;

  return (
    <section className="shell workspace" style={{ display: "grid", gap: "1.2rem", paddingBottom: "3rem" }}>
      <div>
        <p style={{ margin: 0, color: "var(--copper)" }}>مقارنة بأقصى إعدادات كل نموذج</p>
        <h1 style={{ margin: "0.2rem 0" }}>مساحة العمل</h1>
      </div>
      <label className="question">
        السؤال
        <textarea className="area" value={question} onChange={(event) => setQuestion(event.target.value)} aria-label="السؤال" />
      </label>
      <label className="card upload">
        <span>أفلت الملفات هنا أو اخترها. الأنواع تُكتشف من المحتوى.</span>
        <span className="file-actions">
          <span className="btn secondary">اختيار الملفات</span>
          <span className="file-caption">{files.length === 0 ? "لم يُختر ملف" : files.map((file) => file.name).join("، ")}</span>
        </span>
        <input
          className="file-input"
          type="file"
          multiple
          aria-label="اختيار الملفات"
          onChange={(event) => void chooseFiles(event.target.files)}
        />
      </label>
      <ul className="file-list">
        {files.map((file) => (
          <li key={file.name}>{file.name} — {file.status}</li>
        ))}
      </ul>
      <div className="shortcuts" role="group" aria-label="اختصارات النماذج" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button className={chatSelected ? "btn is-selected" : "btn secondary"} type="button" aria-pressed={chatSelected} onClick={() => startShortcut(CHAT_SHORTCUT_MODEL)}>محادثة</button>
        <button className={codeSelected ? "btn is-selected" : "btn secondary"} type="button" aria-pressed={codeSelected} onClick={() => startShortcut(CODE_SHORTCUT_MODEL)}>برمجة</button>
        <button className={lightSelected ? "btn is-selected" : "btn secondary"} type="button" aria-pressed={lightSelected} onClick={() => startShortcut(LIGHT_SHORTCUT_MODEL)}>خفيف</button>
        <button className={compareSelected ? "btn is-selected" : "btn secondary"} type="button" aria-pressed={compareSelected} onClick={() => setSelected([...empty.answerModelIds])}>مقارنة</button>
      </div>
      {message ? <p role="status">{message}</p> : null}
      {[...groups.entries()].map(([task, items]) => (
        <fieldset key={task} className="card" style={{ padding: "1rem" }}>
          <legend>{task}</legend>
          {items.map((model) => (
            <label key={model.id} style={{ display: "flex", gap: "0.6rem", margin: "0.35rem 0" }}>
              <input type="checkbox" checked={selected.includes(model.id)} onChange={() => toggle(model.id)} />
              <span>
                <span className="model-name">{model.displayName}</span>
                <small className="ltr meta" style={{ display: "block" }}>{model.id}</small>
                <small className="meta">{model.availability}</small>
              </span>
            </label>
          ))}
        </fieldset>
      ))}
      <div style={{ display: "flex", gap: "0.6rem" }}>
        <button className="btn" type="button" onClick={() => void send(selected)}>إرسال</button>
        <button className="btn secondary" type="button" onClick={() => {
          if (pollRef.current) window.clearInterval(pollRef.current);
          pollRef.current = null;
          setMessage("أُوقف العرض المحلي. قد لا يتوقف المزود فورًا.");
        }}>إيقاف</button>
      </div>
      {asked ? <p>{asked}</p> : null}
      <div className="results" aria-label="الأعمدة">
        {runs.length === 0 ? <article className="card answer-card">عمود لكل نتيجة عند وصولها.</article> : null}
        {runs.map((run) => (
          <article className="card answer-card" key={run.modelId}>
            <h2 className="model-name">{run.displayName}</h2>
            <p className="ltr meta">{run.modelId}</p>
            <p>{run.provider === "anthropic" ? "Anthropic" : "OpenRouter"}</p>
            {run.effort ? <p>الجهد المرسل: {run.effort}</p> : null}
            {run.labels.map((label) => <p key={label}>{label}</p>)}
            <p>{runStatusText(run.status)}</p>
            {run.outputText.trim() ? <pre style={{ whiteSpace: "pre-wrap" }}>{run.outputText}</pre> : null}
            {run.message ? <p>{run.message}</p> : null}
            {run.costUsd != null ? <p>تكلفة تقديرية منفصلة: {run.costUsd} USD</p> : null}
            {run.completionMs != null ? <p>زمن النموذج: {run.completionMs} مللي ثانية</p> : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function comparisonId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const id = (body as { data?: { id?: unknown } }).data?.id;
  return typeof id === "string" ? id : null;
}

function comparisonRuns(body: unknown): PublicRun[] {
  if (!body || typeof body !== "object") return [];
  const runs = (body as { data?: { runs?: unknown } }).data?.runs;
  if (!Array.isArray(runs)) return [];
  return runs.flatMap((item) => (isPublicRun(item) ? [item] : []));
}

function isPublicRun(value: unknown): value is PublicRun {
  if (!value || typeof value !== "object") return false;
  const run = value as PublicRun;
  return typeof run.modelId === "string"
    && typeof run.displayName === "string"
    && typeof run.status === "string"
    && typeof run.outputText === "string"
    && Array.isArray(run.labels);
}
