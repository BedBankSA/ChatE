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

type UploadedFile = {
  id: string;
  name: string;
  detectedType: string;
  byteSize: number;
  status: "stored";
  textExtracted: boolean;
};

type FileRow = {
  key: string;
  name: string;
  status: "uploading" | "stored" | "failed";
  id: string | null;
  detectedType: string | null;
  textExtracted: boolean;
  error: string | null;
};

const empty = {
  question: "",
  evidenceMode: "native",
  answerModelIds: [...COMPARISON_MODEL_IDS],
};

function sameModelSet(current: readonly string[], expected: readonly string[]): boolean {
  return current.length === expected.length && expected.every((id) => current.includes(id));
}

/**
 * RFC 4122 v4 identifier. crypto.randomUUID exists only in secure contexts
 * (HTTPS or localhost), so an operator testing over plain HTTP on a LAN host
 * would otherwise get an English "crypto.randomUUID is not a function" error.
 * crypto.getRandomValues is available in insecure contexts; Math.random is the
 * last-resort fallback and only feeds a non-security idempotency key.
 */
function newIdempotencyKey(): string {
  const cryptoApi = typeof globalThis.crypto === "undefined" ? null : globalThis.crypto;
  try {
    if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  } catch {
    // fall through to the byte-based generator
  }
  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Only our own Arabic API messages are shown to the user. A raw runtime or
 * network error (English, possibly with internal detail) maps to the generic
 * Arabic message instead of leaking to the interface.
 */
function userFacingMessage(error: unknown): string {
  if (error instanceof Error && /[\u0600-\u06FF]/.test(error.message)) return error.message;
  return REQUEST_FAILED_MESSAGE;
}

function fileStatusText(file: FileRow): string {
  if (file.status === "uploading") return "قيد الرفع";
  if (file.status === "failed") return `تعذر الرفع${file.error ? `: ${file.error}` : ""}`;
  const type = file.detectedType ? ` (${file.detectedType})` : "";
  return `تم التخزين${type}${file.textExtracted ? " — استُخرج النص" : " — بلا نص مستخرج"}`;
}

export function Workspace() {
  const [models, setModels] = useState<PublicModel[]>([]);
  const [question, setQuestion] = useState(empty.question);
  const [selected, setSelected] = useState<string[]>(empty.answerModelIds);
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<FileRow[]>([]);
  const [uploaded, setUploaded] = useState<UploadedFile[]>([]);
  const [runs, setRuns] = useState<PublicRun[]>([]);
  const [asked, setAsked] = useState("");
  const sending = useRef(false);
  const uploading = useRef(false);
  const pollRef = useRef<number | null>(null);
  const pollBusy = useRef(false);

  useEffect(() => {
    void fetch("/api/models")
      .then((response) => response.json())
      .then((body: { data?: PublicModel[] }) => setModels(body.data ?? []))
      .catch(() => setMessage("تعذر تحميل سجل النماذج"));
  }, []);

  useEffect(() => () => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = null;
    pollBusy.current = false;
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

  function stopPolling() {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = null;
    pollBusy.current = false;
  }

  async function refreshComparison(id: string) {
    const response = await fetch(`/api/comparisons/${id}`, { signal: AbortSignal.timeout(15_000) });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(comparisonFailureMessage(body));
    const next = comparisonRuns(body);
    setRuns(next);
    if (runsSettled(next)) stopPolling();
  }

  function startPolling(id: string) {
    stopPolling();
    let failures = 0;
    pollRef.current = window.setInterval(() => {
      if (pollBusy.current) return;
      pollBusy.current = true;
      void refreshComparison(id)
        .then(() => {
          failures = 0;
        })
        .catch((error: unknown) => {
          failures += 1;
          setMessage(userFacingMessage(error));
          // Give up after three consecutive failures instead of polling forever.
          if (failures >= 3) stopPolling();
        })
        .finally(() => {
          pollBusy.current = false;
        });
    }, 1200);
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
        attachmentIds: uploaded.map((file) => file.id),
        idempotencyKey: newIdempotencyKey(),
      });
      const id = comparisonId(body);
      const next = comparisonRuns(body);
      setRuns(next);
      setMessage(id ? "أُرسلت المقارنة." : SENDING_MESSAGE);
      if (id && !runsSettled(next)) startPolling(id);
    } catch (error) {
      setMessage(userFacingMessage(error));
    } finally {
      sending.current = false;
    }
  }

  function startShortcut(modelId: string) {
    const answerModelIds = [modelId];
    setSelected(answerModelIds);
    void send(answerModelIds);
  }

  /**
   * Sends the real File objects as multipart/form-data with a Turnstile token
   * whose action is `upload`. Only after the server confirms storage do the
   * resulting ids become attachmentIds for the next comparison.
   */
  async function chooseFiles(list: FileList | null) {
    const picked = [...(list ?? [])];
    if (picked.length === 0 || uploading.current) return;
    uploading.current = true;
    const pending: FileRow[] = picked.map((file, index) => ({
      key: `${Date.now()}-${index}-${file.name}`,
      name: file.name,
      status: "uploading",
      id: null,
      detectedType: null,
      textExtracted: false,
      error: null,
    }));
    setFiles(pending);
    setUploaded([]);
    setMessage("جارٍ رفع الملفات.");
    let token = "";
    try {
      token = await issueTurnstileToken("upload");
    } catch {
      token = "";
    }
    const form = new FormData();
    form.set("cf-turnstile-response", token);
    for (const file of picked) form.append("files", file);
    try {
      let response: Response;
      try {
        response = await fetch("/api/uploads", { method: "POST", body: form });
      } catch {
        throw new Error(REQUEST_FAILED_MESSAGE);
      }
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(comparisonFailureMessage(body));
      const confirmed = uploadedFiles(body);
      setUploaded(confirmed);
      setFiles(pending.map((row, index) => {
        const saved = confirmed[index];
        return saved
          ? { ...row, status: "stored", id: saved.id, detectedType: saved.detectedType, textExtracted: saved.textExtracted }
          : { ...row, status: "failed", error: "لم يعُد الملف من الخادم" };
      }));
      setMessage(confirmed.length > 0 ? `رُفعت ${confirmed.length} ملفات وأصبحت مرفقة بالسؤال.` : "");
    } catch (error) {
      const reason = error instanceof Error ? error.message : REQUEST_FAILED_MESSAGE;
      setFiles(pending.map((row) => ({ ...row, status: "failed", error: reason })));
      setMessage(reason);
    } finally {
      uploading.current = false;
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
          <span className="file-caption">{files.length === 0 ? "لم يُختر ملف" : uploaded.length > 0 ? `${uploaded.length} ملف مرفق` : files.map((file) => file.name).join("، ")}</span>
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
          <li key={file.key}>{file.name} — {fileStatusText(file)}</li>
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
          stopPolling();
          setMessage("أُوقف العرض المحلي. قد لا يتوقف المزود فورًا.");
        }}>إيقاف</button>
      </div>
      {asked ? <p>{asked}</p> : null}
      {asked && uploaded.length > 0 ? <p>الملفات المرفقة: {uploaded.map((file) => file.name).join("، ")}</p> : null}
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

function uploadedFiles(body: unknown): UploadedFile[] {
  if (!body || typeof body !== "object") return [];
  const files = (body as { data?: { files?: unknown } }).data?.files;
  if (!Array.isArray(files)) return [];
  return files.flatMap((item) => (isUploadedFile(item) ? [item] : []));
}

function isUploadedFile(value: unknown): value is UploadedFile {
  if (!value || typeof value !== "object") return false;
  const file = value as UploadedFile;
  return typeof file.id === "string"
    && typeof file.name === "string"
    && typeof file.detectedType === "string"
    && typeof file.byteSize === "number"
    && file.status === "stored"
    && typeof file.textExtracted === "boolean";
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
