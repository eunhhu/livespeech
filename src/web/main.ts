import { LANGUAGES, languageLabel } from "../shared/languages";
import type { HealthResponse } from "../shared/protocol";
import { WebAudioIO } from "./audio/web-audio-io";
import { Interpreter, TokenError, type InterpreterConfig, type Mode } from "./live/interpreter";
import type { Segment, StreamStatus } from "./live/translate-stream";
import { ScreenWakeLock } from "./platform/wake-lock";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// Served by the Bun server (not the bundler, which can't resolve root-absolute hrefs).
document.head.append(Object.assign(document.createElement("link"), { rel: "manifest", href: "/manifest.webmanifest" }));

const ui = {
  status: $<HTMLSpanElement>("status"),
  settings: $<HTMLElement>("settings"),
  modeButtons: [...document.querySelectorAll<HTMLButtonElement>("[data-mode]")],
  langs: document.querySelector<HTMLDivElement>(".langs")!,
  myLang: $<HTMLSelectElement>("myLang"),
  myLangLabel: $<HTMLSpanElement>("myLangLabel"),
  partnerLang: $<HTMLSelectElement>("partnerLang"),
  partnerField: $<HTMLLabelElement>("partnerField"),
  swap: $<HTMLButtonElement>("swap"),
  halfDuplex: $<HTMLInputElement>("halfDuplex"),
  accessRow: $<HTMLLabelElement>("accessRow"),
  accessCode: $<HTMLInputElement>("accessCode"),
  notice: $<HTMLDivElement>("notice"),
  transcript: $<HTMLElement>("transcript"),
  empty: $<HTMLParagraphElement>("empty"),
  mic: $<HTMLButtonElement>("mic"),
  hint: $<HTMLParagraphElement>("hint"),
};

// ---- settings persistence (per-device convenience only) ----

type Settings = Omit<InterpreterConfig, "accessCode"> & { accessCode: string };
const STORAGE_KEY = "livespeech.settings.v1";
const DEFAULTS: Settings = {
  mode: "converse",
  myLang: "ko",
  partnerLang: "en",
  halfDuplex: true,
  accessCode: "",
};

function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // private mode / storage blocked
  }
}

const settings = loadSettings();

// ---- settings UI ----

for (const select of [ui.myLang, ui.partnerLang]) {
  for (const { code, label } of LANGUAGES) select.add(new Option(label, code));
}

function renderSettings(): void {
  for (const b of ui.modeButtons) b.setAttribute("aria-checked", String(b.dataset.mode === settings.mode));
  const listen = settings.mode === "listen";
  ui.langs.classList.toggle("single", listen);
  ui.partnerField.hidden = listen;
  ui.myLangLabel.textContent = listen ? "이 언어로 들려주기" : "나";
  ui.myLang.value = settings.myLang;
  ui.partnerLang.value = settings.partnerLang;
  ui.halfDuplex.checked = settings.halfDuplex;
  ui.accessCode.value = settings.accessCode;
}

for (const b of ui.modeButtons) {
  b.addEventListener("click", () => {
    settings.mode = b.dataset.mode as Mode;
    // Earbuds are the common case for one-way listening; the speaker for conversations.
    settings.halfDuplex = settings.mode === "converse";
    saveSettings();
    renderSettings();
  });
}
ui.myLang.addEventListener("change", () => {
  settings.myLang = ui.myLang.value;
  saveSettings();
});
ui.partnerLang.addEventListener("change", () => {
  settings.partnerLang = ui.partnerLang.value;
  saveSettings();
});
ui.swap.addEventListener("click", () => {
  [settings.myLang, settings.partnerLang] = [settings.partnerLang, settings.myLang];
  saveSettings();
  renderSettings();
});
ui.halfDuplex.addEventListener("change", () => {
  settings.halfDuplex = ui.halfDuplex.checked;
  saveSettings();
});
ui.accessCode.addEventListener("change", () => {
  settings.accessCode = ui.accessCode.value.trim();
  saveSettings();
});

renderSettings();

// ---- status / notices ----

const STATUS_TEXT: Record<StreamStatus | "idle", string> = {
  idle: "대기",
  connecting: "연결 중",
  live: "통역 중",
  reconnecting: "재연결 중",
  error: "오류",
  stopped: "대기",
};

function setStatus(status: StreamStatus | "idle", detail?: string): void {
  ui.status.dataset.status = status;
  ui.status.textContent = STATUS_TEXT[status];
  ui.status.title = detail ?? "";
  if (status === "error") showNotice(`연결이 끊겼어요. 다시 시작해 주세요. (${detail ?? "unknown"})`);
}

function showNotice(text: string | null): void {
  ui.notice.hidden = !text;
  ui.notice.textContent = text ?? "";
}

// ---- transcript ----

const bubbles = new Map<string, { el: HTMLDivElement; src: HTMLDivElement; dst: HTMLDivElement }>();

function renderSegment(s: Segment): void {
  ui.empty.hidden = true;
  let b = bubbles.get(s.id);
  if (!b) {
    const el = document.createElement("div");
    el.className = "bubble";
    el.dataset.speaker = s.speaker;
    const src = document.createElement("div");
    src.className = "src";
    const dst = document.createElement("div");
    dst.className = "dst";
    el.append(src, dst);
    ui.transcript.append(el);
    b = { el, src, dst };
    bubbles.set(s.id, b);
  }
  b.el.dataset.done = String(s.done);
  b.src.textContent = s.source.trim();
  b.src.lang = s.sourceLang ?? "";
  b.dst.textContent = s.translation.trim();

  const nearBottom =
    ui.transcript.scrollHeight - ui.transcript.scrollTop - ui.transcript.clientHeight < 120;
  if (nearBottom) ui.transcript.scrollTop = ui.transcript.scrollHeight;
}

// ---- session lifecycle ----

const wakeLock = new ScreenWakeLock();
let audio: WebAudioIO | null = null;
let interpreter: Interpreter | null = null;
let starting = false;

function setRunning(running: boolean): void {
  ui.mic.setAttribute("aria-pressed", String(running));
  ui.mic.setAttribute("aria-label", running ? "통역 중지" : "통역 시작");
  ui.settings.setAttribute("aria-disabled", String(running));
  ui.mic.style.setProperty("--level", "0");
  ui.mic.dataset.gated = "false";
  if (running) {
    ui.hint.textContent =
      settings.mode === "converse"
        ? `${languageLabel(settings.myLang)} ⇄ ${languageLabel(settings.partnerLang)} · 화면을 켜 둔 채로 사용하세요`
        : `→ ${languageLabel(settings.myLang)} · 화면을 켜 둔 채로 사용하세요`;
  } else {
    ui.hint.textContent = "";
  }
}

async function start(): Promise<void> {
  if (settings.mode === "converse" && settings.myLang === settings.partnerLang) {
    showNotice("나와 상대의 언어가 같아요. 다른 언어를 골라 주세요.");
    return;
  }
  starting = true;
  ui.mic.disabled = true;
  showNotice(null);
  setStatus("connecting");

  // Must be created synchronously inside the click for iOS Safari.
  audio = new WebAudioIO();
  audio.onCaptureLost = () => {
    void stop();
    showNotice("마이크 입력이 끊겼어요 (다른 앱이 마이크를 가져갔거나 장치가 분리됨).");
  };

  interpreter = new Interpreter(audio, {
    onSegment: renderSegment,
    onStatus: setStatus,
    onLevel: (rms, gated) => {
      // Speech RMS is typically 0.02–0.2; map to 0..1 for the ring.
      ui.mic.style.setProperty("--level", String(Math.min(1, rms * 6)));
      ui.mic.dataset.gated = String(gated);
    },
  });

  try {
    await interpreter.start({ ...settings, accessCode: settings.accessCode || undefined });
    setRunning(true);
    await wakeLock.enable();
  } catch (err) {
    interpreter = null;
    audio = null;
    setStatus("idle");
    showNotice(describeStartError(err));
  } finally {
    starting = false;
    ui.mic.disabled = false;
  }
}

async function stop(): Promise<void> {
  const it = interpreter;
  interpreter = null;
  audio = null;
  setRunning(false);
  setStatus("idle");
  await wakeLock.disable();
  await it?.stop();
}

function describeStartError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") return "마이크 권한이 거부되었어요. 브라우저/시스템 설정에서 허용해 주세요.";
    if (err.name === "NotFoundError") return "사용할 수 있는 마이크가 없어요.";
    if (err.name === "NotReadableError") return "다른 앱이 마이크를 사용 중이에요.";
  }
  if (err instanceof TokenError) {
    if (err.code === "bad_access_code") {
      ui.accessRow.hidden = false;
      return "접근 코드가 올바르지 않아요.";
    }
    if (err.code === "server_missing_api_key") return "서버에 GEMINI_API_KEY가 설정되지 않았어요.";
    if (err.code === "rate_limited") return "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.";
    return `세션 토큰 발급 실패: ${err.code}`;
  }
  return `시작하지 못했어요: ${err instanceof Error ? err.message : String(err)}`;
}

ui.mic.addEventListener("click", () => {
  if (starting) return;
  if (interpreter) void stop();
  else void start();
});

document.addEventListener("visibilitychange", () => {
  if (!interpreter) return;
  if (document.visibilityState === "visible") {
    void audio?.recover();
    showNotice(null);
  } else {
    // Web limitation: iOS suspends capture when hidden; Android may throttle it.
    showNotice("앱이 백그라운드에 있는 동안 통역이 멈췄을 수 있어요.");
  }
});

// ---- environment checks ----

if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
  ui.mic.disabled = true;
  showNotice("마이크를 쓰려면 HTTPS(또는 localhost)로 접속해야 해요.");
}

fetch("/api/health")
  .then((r) => r.json() as Promise<HealthResponse>)
  .then((h) => {
    if (h.accessCodeRequired) ui.accessRow.hidden = false;
  })
  .catch(() => showNotice("서버에 연결할 수 없어요."));
