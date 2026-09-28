import type { TokenRequest, TokenResponse } from "../../shared/protocol";
import type { AudioIO } from "../audio/types";
import { TranslateStream, type Segment, type Speaker, type StreamStatus } from "./translate-stream";

export type Mode = "listen" | "converse";

export interface InterpreterConfig {
  /**
   * listen   — one-way: everything heard is translated into `myLang` (lectures, tours,
   *            the other person wearing nothing; you wearing earbuds).
   * converse — two-way on one phone: your speech → `partnerLang`, theirs → `myLang`.
   */
  mode: Mode;
  myLang: string;
  partnerLang: string;
  /**
   * Speakerphone mode (consecutive interpretation):
   *  - translated audio is held back while the local talker is still speaking, and
   *  - mic input is replaced with silence while translated audio plays (+ tail),
   * so the speaker's output is never re-translated and nobody is cut off mid-sentence.
   * Off = simultaneous interpretation (earbuds): audio plays as soon as it arrives.
   */
  halfDuplex: boolean;
  accessCode?: string;
}

export interface InterpreterEvents {
  onSegment(segment: Segment): void;
  onLevel(rms: number, gated: boolean): void;
  onStatus(status: StreamStatus, detail?: string): void;
}

/** Keep gating for this long after playback ends (room reverb + AEC settle time). */
const GATE_TAIL_MS = 300;
/** Mic RMS above this counts as someone talking (AGC'd speech sits around 0.02–0.2). */
const VAD_RMS = 0.02;
/** Talker is considered done after this much quiet. */
const VAD_HANGOVER_MS = 700;
/** Safety valve for noisy rooms: never hold translated audio longer than this. */
const MAX_HOLD_MS = 6_000;

export class Interpreter {
  private streams: TranslateStream[] = [];
  private readonly statuses = new Map<string, { status: StreamStatus; detail?: string }>();
  private silence = new Int16Array(1600);

  private halfDuplex = false;
  private lastVoiceAt = 0;
  private held: Int16Array[] = [];
  private heldSince = 0;

  constructor(
    private readonly audio: AudioIO,
    private readonly events: InterpreterEvents,
  ) {}

  async start(cfg: InterpreterConfig): Promise<void> {
    this.halfDuplex = cfg.halfDuplex;
    const fetchToken = (targetLanguageCode: string) => requestToken(targetLanguageCode, cfg.accessCode);

    const plan: { id: string; target: string; speaker: Speaker }[] =
      cfg.mode === "listen"
        ? [{ id: "to-me", target: cfg.myLang, speaker: "partner" }]
        : [
            { id: "to-partner", target: cfg.partnerLang, speaker: "me" },
            { id: "to-me", target: cfg.myLang, speaker: "partner" },
          ];

    this.streams = plan.map(
      (p) =>
        new TranslateStream({
          id: p.id,
          targetLanguageCode: p.target,
          speaker: p.speaker,
          fetchToken,
          onAudio: (pcm) => this.output(pcm),
          onSegment: (s) => this.events.onSegment(s),
          onStatus: (status, detail) => this.setStatus(p.id, status, detail),
        }),
    );

    // Ask for the mic first so a permission denial fails fast, before we spend tokens.
    // Chunks arriving while sessions connect are backlogged by each stream.
    await this.audio.start((chunk) => {
      const now = performance.now();
      const gated = this.halfDuplex && this.audio.isOutputBusy(GATE_TAIL_MS);
      let pcm = chunk.pcm;
      if (gated) {
        if (this.silence.length !== pcm.length) this.silence = new Int16Array(pcm.length);
        // Keep streaming silence (not nothing) so server-side VAD sees the pause.
        pcm = this.silence;
      } else if (chunk.rms > VAD_RMS) {
        this.lastVoiceAt = now;
      }
      for (const s of this.streams) s.send(pcm);
      this.events.onLevel(gated ? 0 : chunk.rms, gated);

      if (
        this.held.length > 0 &&
        (now - this.lastVoiceAt >= VAD_HANGOVER_MS || now - this.heldSince >= MAX_HOLD_MS)
      ) {
        this.releaseHeld();
      }
    });

    try {
      await Promise.all(this.streams.map((s) => s.start()));
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  /**
   * The translate model is simultaneous: it starts speaking ~2–3 s into a sentence.
   * On a speakerphone that would gate the mic while the talker is still mid-sentence,
   * so in half-duplex mode we hold output until they pause. Once playback is running
   * the mic is gated anyway, so further chunks can go straight to the player.
   */
  private output(pcm: Int16Array): void {
    const talking = performance.now() - this.lastVoiceAt < VAD_HANGOVER_MS;
    if (this.halfDuplex && talking && !this.audio.isOutputBusy(0)) {
      if (this.held.length === 0) this.heldSince = performance.now();
      this.held.push(pcm);
      return;
    }
    this.releaseHeld();
    this.audio.play(pcm);
  }

  private releaseHeld(): void {
    for (const pcm of this.held) this.audio.play(pcm);
    this.held = [];
  }

  async stop(): Promise<void> {
    for (const s of this.streams) s.stop();
    this.streams = [];
    this.held = [];
    this.statuses.clear();
    await this.audio.stop();
  }

  /** Worst status across streams wins, so the UI shows a single state. */
  private setStatus(id: string, status: StreamStatus, detail?: string): void {
    this.statuses.set(id, { status, detail });
    const order: StreamStatus[] = ["error", "reconnecting", "connecting", "live", "stopped"];
    const worst = [...this.statuses.values()].sort(
      (a, b) => order.indexOf(a.status) - order.indexOf(b.status),
    )[0];
    if (worst) this.events.onStatus(worst.status, worst.detail);
  }
}

export class TokenError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
  ) {
    super(code);
  }
}

async function requestToken(targetLanguageCode: string, accessCode?: string): Promise<TokenResponse> {
  const res = await fetch("/api/token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(accessCode ? { "x-access-code": accessCode } : {}),
    },
    body: JSON.stringify({ targetLanguageCode } satisfies TokenRequest),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new TokenError(body.error ?? `http_${res.status}`, res.status);
  }
  return res.json();
}
