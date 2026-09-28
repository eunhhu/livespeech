import {
  INPUT_MIME,
  type LiveServerMessage,
  type LiveTranscription,
  type TokenResponse,
} from "../../shared/protocol";
import { base64ToPcm16, pcm16ToBase64 } from "../audio/pcm";

export interface LiveConnectionHandlers {
  onAudio(pcm: Int16Array): void;
  onInputTranscription(t: LiveTranscription): void;
  onOutputTranscription(t: LiveTranscription): void;
  onTurnComplete(): void;
  onInterrupted(): void;
  onGoAway(timeLeft?: string): void;
  onClose(code: number, reason: string): void;
}

const SETUP_TIMEOUT_MS = 10_000;

/**
 * One WebSocket to the Gemini Live API (raw protocol, no SDK — keeps the client
 * bundle small). Resolves `open()` once `setupComplete` arrives.
 */
export class LiveConnection {
  private ws?: WebSocket;
  private closedByUs = false;
  private readonly decoder = new TextDecoder();

  constructor(private readonly handlers: LiveConnectionHandlers) {}

  open(token: TokenResponse): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(token.wsUrl);
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      let ready = false;
      const timer = setTimeout(() => {
        if (!ready) {
          reject(new Error("Live setup timed out"));
          this.close();
        }
      }, SETUP_TIMEOUT_MS);

      ws.onopen = () => ws.send(JSON.stringify({ setup: token.setup }));

      ws.onmessage = (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : this.decoder.decode(ev.data);
        let msg: LiveServerMessage;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (msg.setupComplete && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve();
        }
        this.dispatch(msg);
      };

      ws.onclose = (ev) => {
        clearTimeout(timer);
        if (!ready) reject(new Error(`Live socket closed during setup (${ev.code} ${ev.reason})`));
        if (!this.closedByUs) this.handlers.onClose(ev.code, ev.reason);
      };
      // onerror is always followed by onclose; nothing extra to do.
      ws.onerror = () => {};
    });
  }

  sendAudio(pcm: Int16Array): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({ realtimeInput: { audio: { data: pcm16ToBase64(pcm), mimeType: INPUT_MIME } } }),
    );
  }

  /** Tell the server no more audio is coming (flushes any buffered speech). */
  endAudio(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  }

  close(): void {
    this.closedByUs = true;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close(1000);
  }

  private dispatch(msg: LiveServerMessage): void {
    if (msg.goAway) this.handlers.onGoAway(msg.goAway.timeLeft);

    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.interrupted) this.handlers.onInterrupted();
    if (sc.inputTranscription?.text) this.handlers.onInputTranscription(sc.inputTranscription);

    for (const part of sc.modelTurn?.parts ?? []) {
      const data = part.inlineData;
      if (data?.data && data.mimeType?.startsWith("audio/")) {
        this.handlers.onAudio(base64ToPcm16(data.data));
      }
    }

    if (sc.outputTranscription?.text) this.handlers.onOutputTranscription(sc.outputTranscription);
    if (sc.turnComplete) this.handlers.onTurnComplete();
  }
}
