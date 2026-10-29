"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { issueTurnstileToken } from "@/components/turnstile";
import {
  comparisonSettledNotice,
  runStatusText,
  runsSettled,
  successSummaryText,
  successfulComparisonRuns,
  visibleComparisonRuns,
  type PublicRun,
} from "@/domain/comparison/view";
import {
  MAX_COMPARISON_MODELS,
  MODEL_LIMIT_MESSAGE,
  REQUEST_FAILED_MESSAGE,
  comparisonFailureMessage,
  emptyQuestionMessage,
} from "@/domain/workspace-start";

/**
 * Workspace: one question is sent to the selected answer models and every
 * answer arrives in its own card. The interface is deliberately arranged like
 * a chat composer: the question and the primary action stay next to each other,
 * every rejected send leaves a visible message, and the model picker only lists
 * models that can actually answer a comparison question.
 */

type PublicModel = {
  id: string;
  displayName: string;
  family?: string;
  taskType: string;
  availability: string;
  usagePolicy?: string;
  contextLimits?: { contextLength?: number };
  /** Server-gated model whose live call is currently disabled. */
  liveCallsDisabled?: boolean;
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

type Notice = {
  kind: "info" | "success" | "error";
  text: string;
};

type RunTone = "queued" | "running" | "ok" | "warn" | "bad";

const MAX_QUESTION_LENGTH = 8_000;
const MAX_ATTACHMENT_COUNT = 5;
/**
 * Stop polling even when the server keeps reporting a non-terminal run. The
 * provider deadline is MODEL_TIMEOUT_MS (180s by default) and the response is
 * written afterwards; five minutes leaves room for the retry/backoff path
 * without leaving a polling tab alive forever after a server crash.
 */
const POLL_DEADLINE_MS = 5 * 60_000;
const ANSWER_TASK_TYPES = ["محادثة", "برمجة", "إجابة"] as const;
const SPECIALIST_LABELS: Record<string, string> = {
  قرار: "اتخاذ قرار",
  تقييم: "تقييم",
  تصنيف: "تصنيف",
  كلام: "صوت",
  تضمين: "تضمين وبحث دلالي",
  "إعادة ترتيب": "إعادة ترتيب",
  موجّه: "توجيه الطلبات",
};
const RUN_STATUS_TONE: Record<string, RunTone> = {
  queued: "queued",
  running: "running",
  completed: "ok",
  incomplete: "warn",
  failed: "bad",
  policy_blocked: "warn",
  unfit: "warn",
  context_exceeded: "warn",
  live_disabled: "warn",
  cancelled: "warn",
};

function isAnswerTask(taskType: string): boolean {
  return (ANSWER_TASK_TYPES as readonly string[]).includes(taskType);
}

function isSelectableModel(model: PublicModel): boolean {
  return isAnswerTask(model.taskType) && model.availability === "متاح" && model.liveCallsDisabled !== true;
}

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

function userFacingMessage(error: unknown): string {
  if (error instanceof Error && /[\u0600-\u06FF]/.test(error.message)) return error.message;
  return REQUEST_FAILED_MESSAGE;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function formatContext(length: number | undefined): string {
  if (!length || length <= 0) return "";
  if (length >= 1024) return `${Math.round(length / 1024)} ألف رمز`;
  return `${length} رمز`;
}

function fileStatusText(file: FileRow): string {
  if (file.status === "uploading") return "قيد الرفع…";
  if (file.status === "failed") return `تعذر الرفع${file.error ? `: ${file.error}` : ""}`;
  const extracted = file.textExtracted ? " · استُخرج النص" : " · بلا نص مستخرج";
  return `تم الرفع${file.detectedType ? ` (${file.detectedType})` : ""}${extracted}`;
}

function providerLabel(run: PublicRun): string {
  return run.provider === "anthropic" ? "Anthropic" : "OpenRouter";
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

function SendIcon() {
  return (
    <svg className="ws-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M3.4 11.2 20.2 4.1c.6-.3 1.2.3 1 1l-4.4 15.4c-.2.7-1.1.9-1.6.4l-3.6-3.4-2.2 2.1c-.4.4-1.1.2-1.2-.4l-.7-4.1-3.7-2.1c-.6-.4-.5-1.4.2-1.7Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg className="ws-icon" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
      <path d="M8.5 12.5 14 7a3 3 0 0 1 4.2 4.2l-7.1 7.1a5 5 0 0 1-7.1-7.1l6.6-6.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg className="ws-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

export function Workspace() {
  const [models, setModels] = useState<PublicModel[]>([]);
  const [modelsState, setModelsState] = useState<"loading" | "ready" | "error">("loading");
  const [question, setQuestion] = useState("");
  // Models are auto-selected in loadModels once GET /api/models answers, so the
  // user never has to pick anything before typing a question.
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("الكل");
  const [files, setFiles] = useState<FileRow[]>([]);
  const [uploaded, setUploaded] = useState<UploadedFile[]>([]);
  const [runs, setRuns] = useState<PublicRun[]>([]);
  const [asked, setAsked] = useState("");
  const [askedModels, setAskedModels] = useState<string[]>([]);
  const [askedAttachments, setAskedAttachments] = useState<UploadedFile[]>([]);
  const [sending, setSending] = useState(false);
  const [pollId, setPollId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const sendingRef = useRef(false);
  const uploadingRef = useRef(false);
  const questionRef = useRef<HTMLTextAreaElement | null>(null);
  const resultsRef = useRef<HTMLElement | null>(null);
  const initialized = useRef(false);
  const userTouchedSelection = useRef(false);

  const selectable = useMemo(() => models.filter(isSelectableModel), [models]);
  const restricted = useMemo(
    () => models.filter((model) => isAnswerTask(model.taskType) && !isSelectableModel(model)),
    [models],
  );
  const specialists = useMemo(() => models.filter((model) => !isAnswerTask(model.taskType)), [models]);
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const model of selectable) counts.set(model.taskType, (counts.get(model.taskType) ?? 0) + 1);
    return ["الكل", ...ANSWER_TASK_TYPES.filter((task) => counts.has(task))];
  }, [selectable]);
  const visibleModels = useMemo(() => {
    const term = query.trim().toLowerCase();
    return selectable.filter((model) => {
      if (category !== "الكل" && model.taskType !== category) return false;
      if (!term) return true;
      return [model.displayName, model.family ?? "", model.id, model.taskType]
        .some((value) => value.toLowerCase().includes(term));
    });
  }, [selectable, category, query]);
  const visibleRuns = useMemo(() => visibleComparisonRuns(runs), [runs]);
  const successCount = useMemo(() => successfulComparisonRuns(runs).length, [runs]);
  const busyRuns = runs.some((run) => run.status === "queued" || run.status === "running");
  const hiddenFailures = runs.length - visibleRuns.length;
  const successSummary = successSummaryText(successCount);
  const atLimit = selected.length >= MAX_COMPARISON_MODELS;
  const dockHint =
    question.trim().length === 0
      ? "اكتب سؤالك أولًا"
      : selected.length === 0
        ? "اختر نموذجًا واحدًا على الأقل"
        : `جاهز للإرسال إلى ${selected.length} نماذج`;

  useEffect(() => {
    const controller = new AbortController();
    void loadModels(controller.signal);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadModels();
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadModels();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (!pollId) return;
    let cancelled = false;
    let failures = 0;
    const deadline = Date.now() + POLL_DEADLINE_MS;

    async function tick(): Promise<void> {
      if (Date.now() > deadline) {
        setPollId(null);
        setNotice({
          kind: "error",
          text: "تأخرت الإجابات أكثر من المتوقع، فأُوقف تحديث الصفحة. قد تكون بعض النماذج ما تزال تعمل لدى المزود.",
        });
        return;
      }
      try {
        const response = await fetch(`/api/comparisons/${pollId}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(15_000),
        });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(comparisonFailureMessage(body));
        const next = comparisonRuns(body);
        if (cancelled) return;
        failures = 0;
        setRuns(next);
        if (runsSettled(next)) {
          setPollId(null);
          // Zero completed answers is a failure, not a success with an empty body.
          setNotice(comparisonSettledNotice(next));
        }
      } catch (error) {
        if (cancelled) return;
        failures += 1;
        if (failures >= 4) {
          setPollId(null);
          setNotice({ kind: "error", text: `تعذر تحديث النتائج: ${userFacingMessage(error)}` });
        }
      }
    }

    void tick();
    const timer = window.setInterval(() => void tick(), 1_500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pollId]);

  /**
   * Fetches the catalog and re-syncs runtime capabilities. Called on mount and
   * again whenever the tab becomes visible / every minute, because a provider
   * key can be changed from /admin/settings while this tab stays open; without
   * this the picker kept showing a stale "restricted" classification.
   */
  async function loadModels(signal?: AbortSignal): Promise<void> {
    if (!initialized.current) setModelsState("loading");
    try {
      const response = await fetch("/api/models", { cache: "no-store", signal });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(comparisonFailureMessage(body));
      const list = publicModels(body);
      const available = list.filter(isSelectableModel).map((model) => model.id).slice(0, MAX_COMPARISON_MODELS);
      const availableSet = new Set(available);
      setModels(list);
      setModelsState("ready");
      setSelected((current) => {
        // Auto-select everything active while the human has not customized the
        // selection; afterwards only prune ids that are no longer available.
        if (!userTouchedSelection.current) return available;
        return current.filter((id) => availableSet.has(id));
      });
      initialized.current = true;
    } catch (error) {
      if (signal?.aborted) return;
      if (initialized.current) return; // A background refresh must stay silent.
      setModelsState("error");
      setNotice({ kind: "error", text: "تعذر تحميل سجل النماذج. أعد المحاولة قبل الإرسال." });
      void error;
    }
  }

  function toggleModel(id: string): void {
    userTouchedSelection.current = true;
    if (selected.includes(id)) {
      setSelected(selected.filter((item) => item !== id));
      return;
    }
    if (selected.length >= MAX_COMPARISON_MODELS) {
      setNotice({ kind: "info", text: MODEL_LIMIT_MESSAGE });
      return;
    }
    setSelected([...selected, id]);
    setNotice(null);
  }

  function selectAllModels(): void {
    userTouchedSelection.current = true;
    if (selectable.length === 0) return;
    const ids = selectable.slice(0, MAX_COMPARISON_MODELS).map((model) => model.id);
    setSelected(ids);
    setNotice(
      selectable.length > MAX_COMPARISON_MODELS
        ? { kind: "info", text: MODEL_LIMIT_MESSAGE }
        : { kind: "success", text: `تم اختيار ${ids.length} نماذج للمقارنة.` },
    );
  }

  function clearModels(): void {
    userTouchedSelection.current = true;
    setSelected([]);
    setNotice({ kind: "info", text: "لم يبق نموذج مختار. اختر نموذجًا واحدًا على الأقل قبل الإرسال." });
  }

  async function protectedPost(path: string, action: string, payload: Record<string, unknown>): Promise<unknown> {
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

  function scrollToResults(): void {
    const target = resultsRef.current;
    if (!target) return;
    target.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  }

  function stopPolling(): void {
    const wasPolling = Boolean(pollId);
    setPollId(null);
    setNotice({
      kind: "info",
      text: wasPolling
        ? "أُوقف تحديث العرض محليًا. قد تواصل النماذج العمل لدى المزود."
        : "لا يوجد تحديث جارٍ الآن. المعروض هو آخر النتائج التي وصلت.",
    });
  }

  async function send(questionText: string = question, modelIds: string[] = selected): Promise<void> {
    if (sendingRef.current) return;
    const missing = emptyQuestionMessage(questionText);
    if (missing) {
      setNotice({ kind: "error", text: missing });
      questionRef.current?.focus();
      return;
    }
    if (questionText.length > MAX_QUESTION_LENGTH) {
      setNotice({ kind: "error", text: "السؤال أطول من الحد المسموح (8,000 حرف)." });
      questionRef.current?.focus();
      return;
    }
    if (modelIds.length === 0) {
      setNotice({ kind: "error", text: "اختر نموذجًا واحدًا على الأقل قبل الإرسال." });
      return;
    }
    if (modelIds.length > MAX_COMPARISON_MODELS) {
      setNotice({ kind: "error", text: MODEL_LIMIT_MESSAGE });
      return;
    }
    if (uploadingRef.current) {
      setNotice({ kind: "info", text: "انتظر حتى ينتهي رفع الملفات." });
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setNotice({ kind: "info", text: `جارٍ إرسال سؤالك إلى ${modelIds.length} نماذج…` });
    const attachments = [...uploaded];
    try {
      const body = await protectedPost("/api/comparisons", "comparison", {
        question: questionText.trim(),
        evidenceMode: "native",
        answerModelIds: modelIds,
        attachmentIds: attachments.map((file) => file.id),
        idempotencyKey: newIdempotencyKey(),
      });
      const id = comparisonId(body);
      const next = comparisonRuns(body);
      setRuns(next);
      setAsked(questionText.trim());
      setAskedModels([...modelIds]);
      setAskedAttachments(attachments);
      const settled = runsSettled(next);
      const settledNotice = comparisonSettledNotice(next);
      setNotice(
        settled
          ? settledNotice
          : {
              kind: "success",
              text:
                next.length > 0
                  ? `تم إرسال السؤال إلى ${next.length} نماذج. تصل الإجابات تباعًا.`
                  : "أُرسلت المقارنة.",
            },
      );
      setPollId(id && !settled ? id : null);
      window.setTimeout(scrollToResults, 60);
    } catch (error) {
      setNotice({ kind: "error", text: userFacingMessage(error) });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function chooseFiles(list: FileList | null): Promise<void> {
    const picked = [...(list ?? [])];
    if (picked.length === 0 || uploadingRef.current) return;
    if (uploaded.length + picked.length > MAX_ATTACHMENT_COUNT) {
      setNotice({ kind: "error", text: `أقصى عدد للمرفقات ${MAX_ATTACHMENT_COUNT} ملفات.` });
      return;
    }
    uploadingRef.current = true;
    const pending: FileRow[] = picked.map((file, index) => ({
      key: `${Date.now()}-${index}-${file.name}`,
      name: file.name,
      status: "uploading",
      id: null,
      detectedType: null,
      textExtracted: false,
      error: null,
    }));
    setFiles((current) => [...current, ...pending]);
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
      setUploaded((current) => [...current, ...confirmed]);
      setFiles((current) =>
        current.map((row) => {
          const index = pending.findIndex((item) => item.key === row.key);
          if (index === -1) return row;
          const saved = confirmed[index];
          return saved
            ? { ...row, status: "stored", id: saved.id, detectedType: saved.detectedType, textExtracted: saved.textExtracted }
            : { ...row, status: "failed", error: "لم يعد الملف من الخادم" };
        }),
      );
      setNotice({
        kind: confirmed.length > 0 ? "success" : "error",
        text: confirmed.length > 0 ? `رُفعت ${confirmed.length} ملفات وأصبحت مرفقة بالسؤال.` : "لم يُرفع أي ملف.",
      });
    } catch (error) {
      const reason = userFacingMessage(error);
      setFiles((current) =>
        current.map((row) => (pending.some((item) => item.key === row.key) ? { ...row, status: "failed", error: reason } : row)),
      );
      setNotice({ kind: "error", text: reason });
    } finally {
      uploadingRef.current = false;
    }
  }

  function removeFile(key: string): void {
    const row = files.find((item) => item.key === key);
    setFiles((current) => current.filter((item) => item.key !== key));
    if (row?.id) setUploaded((current) => current.filter((file) => file.id !== row.id));
  }

  async function copyRun(run: PublicRun): Promise<void> {
    try {
      await navigator.clipboard.writeText(run.outputText);
      setCopiedId(run.modelId);
      window.setTimeout(() => setCopiedId((current) => (current === run.modelId ? null : current)), 2_000);
    } catch {
      setNotice({ kind: "error", text: "تعذر نسخ الإجابة من المتصفح." });
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void send();
  }

  return (
    <section className="shell workspace ws" aria-labelledby="ws-title">
      <p className="sr-only" role="alert">{notice?.kind === "error" ? notice.text : ""}</p>
      <p className="sr-only" role="status">{notice && notice.kind !== "error" ? notice.text : ""}</p>

      <header className="ws-head">
        <div>
          <p className="ws-eyebrow">مقارنة النماذج في مساحة واحدة</p>
          <h1 className="ws-title" id="ws-title">مساحة العمل</h1>
        </div>
        <p className="ws-sub">
          اكتب سؤالك مرة واحدة، واختر حتى {MAX_COMPARISON_MODELS} نماذج، ثم قارن الإجابات وهي تصل في بطاقات مستقلة.
        </p>
      </header>

      <div className="ws-layout">
        <div className="ws-main">
        <form className="card ws-composer" id="ws-composer" onSubmit={handleSubmit} noValidate>
          <label className="ws-question" htmlFor="ws-question">
            <span className="ws-label">السؤال</span>
            <textarea
              className="ws-textarea"
              id="ws-question"
              ref={questionRef}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder="اكتب سؤالك هنا… مثال: لخّص الملف المرفق ثم اقترح خطة عمل من ثلاث خطوات."
              rows={4}
              maxLength={MAX_QUESTION_LENGTH}
              aria-label="السؤال"
              aria-describedby="ws-question-hint"
            />
          </label>
          <div className="ws-question-meta" id="ws-question-hint">
            <span>سؤال واحد يُرسل إلى كل النماذج المختارة. Ctrl + Enter للإرسال.</span>
            <span className={question.length > MAX_QUESTION_LENGTH - 500 ? "ws-counter is-near-limit" : "ws-counter"}>
              {question.length} / {MAX_QUESTION_LENGTH}
            </span>
          </div>

          <div className="ws-attachments">
            <label className="ws-attach-button">
              <input
                className="ws-file-input"
                type="file"
                multiple
                aria-label="إرفاق ملفات"
                onChange={(event) => {
                  void chooseFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              <PaperclipIcon />
              <span>إرفاق ملفات</span>
            </label>
            <span className="ws-attach-count">{uploaded.length} من {MAX_ATTACHMENT_COUNT} مرفقة</span>
          </div>
          {files.length > 0 ? (
            <ul className="ws-file-list" aria-label="الملفات المرفقة">
              {files.map((file) => (
                <li key={file.key} className={`ws-file ws-file-${file.status}`}>
                  <span className="ws-file-name">{file.name}</span>
                  <span className="ws-file-status">{fileStatusText(file)}</span>
                  <button
                    type="button"
                    className="ws-file-remove"
                    onClick={() => removeFile(file.key)}
                    aria-label={`إزالة الملف ${file.name}`}
                  >
                    إزالة
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="ws-actions">
            <button className="btn ws-send" type="submit" disabled={sending}>
              {sending ? "جارٍ الإرسال…" : "إرسال السؤال"}
              <SendIcon />
            </button>
            {runs.length > 0 ? (
              <button className="btn secondary" type="button" onClick={stopPolling}>
                <StopIcon />
                إيقاف العرض
              </button>
            ) : null}
            <span className="ws-actions-note">سيُرسل إلى {selected.length} نماذج مختارة</span>
          </div>

          {notice ? (
            <p className={`ws-notice ws-notice-${notice.kind}`} aria-hidden="true">
              {notice.text}
            </p>
          ) : null}
        </form>


        <section className="ws-results" ref={resultsRef} aria-labelledby="ws-results-title">
          <header className="ws-results-head">
            <h2 className="ws-results-title" id="ws-results-title">النتائج</h2>
            <div className="ws-results-actions">
              {runs.length > 0 || asked ? (
                <p className="ws-results-summary">{busyRuns ? "جارٍ استلام الإجابات…" : successSummary}</p>
              ) : null}
              {hiddenFailures > 0 && asked && !sending ? (
                <button type="button" className="btn secondary ws-small-btn" onClick={() => void send(asked, askedModels)}>
                  إعادة إرسال السؤال
                </button>
              ) : null}
            </div>
          </header>

          {asked ? (
            <div className="card ws-asked">
              <p className="ws-asked-label">السؤال المُرسل</p>
              <p className="ws-asked-text">{asked}</p>
              {askedAttachments.length > 0 ? (
                <p className="ws-asked-files">المرفقات: {askedAttachments.map((file) => file.name).join("، ")}</p>
              ) : null}
            </div>
          ) : null}

          {visibleRuns.length === 0 ? (
            <div className="card ws-empty">
              {!asked ? (
                <div className="ws-empty-steps" aria-hidden="true">
                  <span>1</span>
                  <span>2</span>
                  <span>3</span>
                </div>
              ) : null}
              <h3 className="ws-empty-title">{asked ? "لم تصل إجابات ناجحة" : "لا نتائج بعد"}</h3>
              <p className="ws-empty-text">
                {asked
                  ? "لم تُرجع النماذج المختارة إجابة ناجحة بعد. أعد المحاولة بعد قليل."
                  : "اكتب سؤالك ثم اضغط «إرسال السؤال» أو Ctrl + Enter. ستظهر هنا الإجابات الناجحة فقط."}
              </p>
            </div>
          ) : (
            <div className="ws-result-grid">
              {visibleRuns.map((run) => {
                const tone = RUN_STATUS_TONE[run.status] ?? "warn";
                const busy = run.status === "queued" || run.status === "running";
                return (
                  <article className={`card run-card run-card-${tone}`} key={run.modelId} lang="ar">
                    <header className="run-head">
                      <div className="run-title">
                        <h3 className="run-name"><bdi>{run.displayName}</bdi></h3>
                        <p className="run-sub">
                          <span>{providerLabel(run)}</span>
                          <span className="ltr run-id">{run.modelId}</span>
                        </p>
                      </div>
                      <span className={`ws-badge ws-badge-${tone}`}>{runStatusText(run.status)}</span>
                    </header>

                    {run.labels.length > 0 ? (
                      <ul className="run-labels" aria-label="إعدادات النموذج">
                        {run.labels.map((label) => (
                          <li key={label}>{label}</li>
                        ))}
                      </ul>
                    ) : null}

                    {busy ? (
                      <div className="run-loading" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </div>
                    ) : null}

                    {run.outputText.trim() ? (
                      <div className="run-output-wrap">
                        <pre className="run-output" dir="auto">{run.outputText}</pre>
                        <button
                          type="button"
                          className="btn secondary ws-small-btn run-copy"
                          onClick={() => void copyRun(run)}
                        >
                          {copiedId === run.modelId ? "نُسخت الإجابة" : "نسخ الإجابة"}
                        </button>
                      </div>
                    ) : null}

                    {run.message ? <p className={`run-message run-message-${tone}`}>{run.message}</p> : null}

                    {run.effort || run.completionMs != null ? (
                      <footer className="run-footer">
                        {run.effort ? <span>الجهد: {run.effort}</span> : null}
                        {run.completionMs != null ? <span>زمن النموذج: {(run.completionMs / 1000).toFixed(1)} ثانية</span> : null}
                      </footer>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </section>
        </div>

        <aside className="ws-side" aria-label="اختيار النماذج">
          <section className="card ws-picker" aria-labelledby="ws-picker-title">
            <header className="ws-picker-head">
              <h2 className="ws-picker-title" id="ws-picker-title">النماذج</h2>
              <span className={atLimit ? "ws-count is-at-limit" : "ws-count"} dir="ltr">
                {selected.length} / {MAX_COMPARISON_MODELS}
              </span>
            </header>
            <p className="ws-picker-hint">
              تُقارن إجابات النماذج المختارة فقط. الحد الأقصى {MAX_COMPARISON_MODELS} نماذج.
            </p>

            <div className="ws-search">
              <input
                type="search"
                className="ws-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="ابحث باسم النموذج أو العائلة"
                aria-label="ابحث في النماذج"
              />
            </div>
            <div className="ws-categories" role="group" aria-label="تصفية حسب المهمة">
              {categories.map((task) => (
                <button
                  key={task}
                  type="button"
                  className={task === category ? "ws-chip is-on" : "ws-chip"}
                  aria-pressed={task === category}
                  onClick={() => setCategory(task)}
                >
                  {task}
                </button>
              ))}
            </div>

            <div className="ws-picker-actions">
              <button type="button" className="btn secondary ws-small-btn" onClick={selectAllModels}>
                تحديد الكل ({selectable.length})
              </button>
              <button type="button" className="btn secondary ws-small-btn" onClick={clearModels} disabled={selected.length === 0}>
                إفراغ
              </button>
            </div>

            {modelsState === "loading" ? (
              <p className="ws-picker-state" role="status">جارٍ تحميل سجل النماذج…</p>
            ) : null}
            {modelsState === "error" ? (
              <p className="ws-picker-state ws-picker-error">
                تعذر تحميل سجل النماذج.
                <button type="button" className="ws-link-button" onClick={() => void loadModels()}>إعادة المحاولة</button>
              </p>
            ) : null}
            {modelsState === "ready" && visibleModels.length === 0 ? (
              <p className="ws-picker-state">لا يوجد نموذج مطابق لبحثك.</p>
            ) : null}

            <ul className="ws-model-list" aria-label="نماذج الإجابة المتاحة">
              {visibleModels.map((model) => {
                const checked = selected.includes(model.id);
                const disabled = !checked && atLimit;
                return (
                  <li key={model.id}>
                    <label className={`ws-model${checked ? " is-on" : ""}${disabled ? " is-disabled" : ""}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => toggleModel(model.id)}
                      />
                      <span className="ws-model-body">
                        <span className="ws-model-name"><bdi>{model.displayName}</bdi></span>
                        <span className="ws-model-meta">
                          {model.taskType}
                          {model.family ? ` · ${model.family}` : ""}
                          {model.contextLimits?.contextLength ? ` · ${formatContext(model.contextLimits.contextLength)}` : ""}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>

            {restricted.length > 0 ? (
              <details className="ws-more">
                <summary>نماذج مقيدة بشروط المزود ({restricted.length})</summary>
                <ul className="ws-muted-list">
                  {restricted.map((model) => (
                    <li key={model.id}>
                      <span className="ws-model-name"><bdi>{model.displayName}</bdi></span>
                      <span className="ws-model-meta">
                        {model.availability !== "متاح" ? model.availability : "الاستدعاء الحي متوقف على هذا الخادم — أضف مفتاح Anthropic من الإدارة"}
                      </span>
                      {model.usagePolicy && model.availability !== "متاح" ? <span className="ws-model-policy">{model.usagePolicy}</span> : null}
                    </li>
                  ))}
                </ul>
                <p className="ws-more-note">لا يمكن إرسال المقارنة إلى هذه النماذج حسب شروط مزودها.</p>
              </details>
            ) : null}

            {specialists.length > 0 ? (
              <details className="ws-more">
                <summary>نماذج متخصصة غير مخصصة لأسئلة المقارنة ({specialists.length})</summary>
                <ul className="ws-muted-list">
                  {specialists.map((model) => (
                    <li key={model.id}>
                      <span className="ws-model-name"><bdi>{model.displayName}</bdi></span>
                      <span className="ws-model-meta">
                        {SPECIALIST_LABELS[model.taskType] ?? model.taskType} · لا تصلح سؤالًا عامًا
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>

          <section className="card ws-tips" aria-labelledby="ws-tips-title">
            <h2 className="ws-tips-title" id="ws-tips-title">كيف تعمل المقارنة؟</h2>
            <ol className="ws-tips-list">
              <li>اكتب سؤالك أو أرفق ملفًا لتحليل محتواه.</li>
              <li>النماذج النشطة محددة تلقائيًا، ويمكنك تعديلها من القائمة.</li>
              <li>أرسل مرة واحدة وقارن الإجابات الناجحة كلمة بكلمة.</li>
            </ol>
            <p className="ws-tips-note">
              تُعرض الإجابات الناجحة فقط؛ النماذج المتعذرة أو المزدحمة تُستبعد من الشبكة تلقائيًا.
            </p>
          </section>
        </aside>
      </div>

      <div className="ws-dock" role="region" aria-label="إرسال سريع">
        <div className="ws-dock-info">
          <span className="ws-dock-count"><bdi dir="ltr">{selected.length} / {MAX_COMPARISON_MODELS}</bdi> نماذج مختارة</span>
          <span className={`ws-dock-status${notice ? ` is-${notice.kind}` : ""}`} aria-hidden="true">
            {notice?.text ?? dockHint}
          </span>
        </div>
        <button className="btn ws-dock-send" type="submit" form="ws-composer" disabled={sending}>
          {sending ? "جارٍ الإرسال…" : "إرسال"}
          <SendIcon />
        </button>
      </div>
    </section>
  );
}

function publicModels(body: unknown): PublicModel[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((item) => (isPublicModel(item) ? [item] : []));
}

function isPublicModel(value: unknown): value is PublicModel {
  if (!value || typeof value !== "object") return false;
  const model = value as PublicModel;
  return typeof model.id === "string"
    && typeof model.displayName === "string"
    && typeof model.taskType === "string"
    && typeof model.availability === "string";
}