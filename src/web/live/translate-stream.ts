import { baseLanguage } from "../../shared/languages";
import type { LiveTranscription, TokenResponse } from "../../shared/protocol";
import { isSilent } from "../audio/pcm";
import { LiveConnection } from "./live-connection";

export type Speaker = "me" | "partner";

export interface Segment {
  id: string;
  speaker: Speaker;
  /** What was said (input transcription). */
  source: string;
  sourceLang?: string;
  /** What the interpreter said (output transcription). */
  translation: string;
  done: boolean;
}

export type StreamStatus = "connecting" | "live" | "reconnecting" | "error" | "stopped";

export interface TranslateStreamOptions {
  id: string;
  targetLanguageCode: string;
  /** Who is speaking when this stream produces a translation. */
  speaker: Speaker;
  fetchToken(targetLanguageCode: string): Promise<TokenResponse>;
  onAudio(pcm: Int16Array): void;
  onSegment(segment: Segment): void;
  onStatus(status: StreamStatus, detail?: string): void;
}

/** Old connection keeps playing its tail for this long after a rotation. */
const DRAIN_MS = 4_000;
/** No server events for this long closes the current caption bubble. */
const SEGMENT_IDLE_MS = 2_500;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 8_000];
const MAX_PENDING_CHARS = 500;
/** Mic audio kept while (re)connecting, so the first words aren't lost. 100 ms chunks. */
const MAX_BACKLOG_CHUNKS = 50;

/**
 * A logical, never-ending translation stream into one target language.
 *
 * Live API WebSockets last ~10 min (server sends `goAway` first) and audio sessions
 * cap at 15 min. Translation needs no long-term context, so instead of session
 * resumption we open a fresh session on `goAway`, switch the mic over once it is
 * ready, and let the old one drain — no audible gap.
 */
export class TranslateStream {
  private active?: LiveConnection;
  private stopped = false;
  private rotating = false;
  private backlog: Int16Array[] = [];

  /** Base language of the most recent input fragment. */
  private inputLang?: string;

  private seq = 0;
  private current?: Segment;
  private pendingSource = "";
  private pendingLang?: string;
  private idleTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly opts: TranslateStreamOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.opts.onStatus("connecting");
    this.setActive(await this.openConnection());
    this.opts.onStatus("live");
  }

  send(pcm: Int16Array): void {
    if (this.active) {
      this.active.sendAudio(pcm);
    } else if (!this.stopped) {
      this.backlog.push(pcm);
      if (this.backlog.length > MAX_BACKLOG_CHUNKS) this.backlog.shift();
    }
  }

  private setActive(conn: LiveConnection): void {
    this.active = conn;
    for (const pcm of this.backlog) conn.sendAudio(pcm);
    this.backlog = [];
  }

  stop(): void {
    this.stopped = true;
    this.active?.endAudio();
    this.active?.close();
    this.active = undefined;
    this.backlog = [];
    this.finalizeSegment();
    this.opts.onStatus("stopped");
  }

  private async openConnection(): Promise<LiveConnection> {
    const conn: LiveConnection = new LiveConnection({
      onAudio: (pcm) => {
        if (!this.echoing && !isSilent(pcm)) this.opts.onAudio(pcm);
      },
      onInputTranscription: (t) => this.onInput(t),
      onOutputTranscription: (t) => this.onOutput(t),
      onTurnComplete: () => this.finalizeSegment(),
      // A translator should not drop output when new speech starts, and the output
      // queue is shared across streams — so we deliberately don't flush here.
      onInterrupted: () => {},
      onGoAway: () => {
        if (conn === this.active) void this.rotate();
      },
      onClose: (code, reason) => {
        if (conn === this.active) void this.reconnect(`${code} ${reason}`.trim());
      },
    });
    const token = await this.opts.fetchToken(this.opts.targetLanguageCode);
    await conn.open(token);
    return conn;
  }

  private async rotate(): Promise<void> {
    if (this.rotating || this.stopped) return;
    this.rotating = true;
    const old = this.active;
    try {
      const next = await this.openConnection();
      if (this.stopped) {
        next.close();
        return;
      }
      this.active = next;
      old?.endAudio();
      setTimeout(() => old?.close(), DRAIN_MS);
    } catch (err) {
      // The old socket is about to die; its onClose will drive reconnect().
      console.warn(`[${this.opts.id}] rotation failed`, err);
    } finally {
      this.rotating = false;
    }
  }

  private async reconnect(reason: string): Promise<void> {
    if (this.stopped) return;
    this.active = undefined;
    for (const delay of RECONNECT_DELAYS_MS) {
      this.opts.onStatus("reconnecting", reason);
      await new Promise((r) => setTimeout(r, delay));
      if (this.stopped) return;
      try {
        this.setActive(await this.openConnection());
        this.opts.onStatus("live");
        return;
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
      }
    }
    this.opts.onStatus("error", reason);
  }

  // ---- caption segmentation ----

  /**
   * True while the speaker is using this stream's target language. Such speech belongs
   * to the other stream (conversation mode) or needs no translation (listen mode).
   * echoTargetLanguage=false *mostly* silences the model here, but it still leaks short
   * audio blips and occasionally an echoed transcript, so we also drop output client-side.
   *
   * Transcripts lag audio by ~1–3 s, so with full-duplex (earbuds) the tail of a
   * translation can be clipped when the other person starts talking over it. In
   * half-duplex mode the mic is gated during playback, so that overlap can't happen.
   */
  private get echoing(): boolean {
    return this.inputLang === baseLanguage(this.opts.targetLanguageCode);
  }

  private onInput(t: LiveTranscription): void {
    if (t.languageCode) this.inputLang = baseLanguage(t.languageCode);
    if (this.echoing) return;
    this.touch();
    const text = t.text ?? "";
    if (this.current) {
      this.current.source += text;
      this.current.sourceLang ??= t.languageCode;
      this.emit();
    } else {
      this.pendingSource = (this.pendingSource + text).slice(-MAX_PENDING_CHARS);
      this.pendingLang = t.languageCode ?? this.pendingLang;
    }
  }

  private onOutput(t: LiveTranscription): void {
    if (this.echoing) return;
    this.ensureSegment();
    this.touch();
    this.current!.translation += t.text ?? "";
    this.emit();
  }

  private ensureSegment(): void {
    if (this.current) return;
    this.current = {
      id: `${this.opts.id}-${++this.seq}`,
      speaker: this.opts.speaker,
      source: this.pendingSource.trimStart(),
      sourceLang: this.pendingLang,
      translation: "",
      done: false,
    };
    this.pendingSource = "";
    this.pendingLang = undefined;
    this.emit();
  }

  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.finalizeSegment(), SEGMENT_IDLE_MS);
  }

  private finalizeSegment(): void {
    clearTimeout(this.idleTimer);
    // Input that never got translated was not ours to translate (see onInput).
    this.pendingSource = "";
    this.pendingLang = undefined;
    if (!this.current) return;
    this.current.done = true;
    this.emit();
    this.current = undefined;
  }

  private emit(): void {
    if (this.current) this.opts.onSegment({ ...this.current });
  }
}
