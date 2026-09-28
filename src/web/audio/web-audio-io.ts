import { INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE } from "../../shared/protocol";
import type { AudioIO, MicChunk } from "./types";

/**
 * Capture worklet: downmixes to mono, decimates from the context rate (44.1/48 kHz)
 * to 16 kHz with a box filter (adequate for speech), and posts ~100 ms PCM16 chunks.
 *
 * Kept as a plain JS string and loaded via a Blob URL so it survives any bundler /
 * minifier and works unchanged inside a Capacitor WebView.
 */
const CAPTURE_WORKLET = /* js */ `
class Pcm16Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { targetRate, chunkMs } = options.processorOptions;
    this.ratio = sampleRate / targetRate;
    this.size = Math.round((targetRate * chunkMs) / 1000);
    this.buf = new Int16Array(this.size);
    this.idx = 0;
    this.acc = 0;
    this.n = 0;
    this.phase = 0;
    this.sumSq = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    const ch1 = input.length > 1 ? input[1] : null;
    for (let i = 0; i < ch0.length; i++) {
      this.acc += ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
      this.n++;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        let s = this.acc / this.n;
        this.acc = 0;
        this.n = 0;
        s = s < -1 ? -1 : s > 1 ? 1 : s;
        this.sumSq += s * s;
        this.buf[this.idx++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.idx === this.size) {
          const rms = Math.sqrt(this.sumSq / this.size);
          this.port.postMessage({ pcm: this.buf, rms }, [this.buf.buffer]);
          this.buf = new Int16Array(this.size);
          this.idx = 0;
          this.sumSq = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("pcm16-capture", Pcm16Capture);
`;

/** How far ahead of "now" the first chunk after silence is scheduled (jitter buffer). */
const PLAYBACK_LEAD_S = 0.08;

export class WebAudioIO implements AudioIO {
  onCaptureLost?: () => void;

  private readonly ctx: AudioContext;
  private readonly out: GainNode;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  private sink?: GainNode;

  private nextPlayTime = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();

  /**
   * Construct inside a user gesture (click handler): iOS Safari only lets an
   * AudioContext start from one.
   */
  constructor() {
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    void this.ctx.resume();
    this.out = this.ctx.createGain();
    this.out.connect(this.ctx.destination);
  }

  async start(onChunk: (chunk: MicChunk) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    for (const track of this.stream.getAudioTracks()) {
      track.addEventListener("ended", () => this.onCaptureLost?.());
    }

    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "text/javascript" }));
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.ctx, "pcm16-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: { targetRate: INPUT_SAMPLE_RATE, chunkMs: 100 },
    });
    this.worklet.port.onmessage = (e: MessageEvent<MicChunk>) => onChunk(e.data);

    // Some engines (Safari) only pull a worklet that is connected to the destination.
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.worklet).connect(this.sink).connect(this.ctx.destination);

    await this.ctx.resume();
  }

  play(pcm: Int16Array): void {
    if (pcm.length === 0) return;
    const buffer = this.ctx.createBuffer(1, pcm.length, OUTPUT_SAMPLE_RATE);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i]! / 0x8000;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.out);

    const startAt = Math.max(this.nextPlayTime, this.ctx.currentTime + PLAYBACK_LEAD_S);
    src.start(startAt);
    this.nextPlayTime = startAt + buffer.duration;

    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  flush(): void {
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }
    this.sources.clear();
    this.nextPlayTime = 0;
  }

  isOutputBusy(tailMs: number): boolean {
    return this.ctx.currentTime < this.nextPlayTime + tailMs / 1000;
  }

  async recover(): Promise<void> {
    if (this.ctx.state !== "running") await this.ctx.resume();
  }

  async stop(): Promise<void> {
    this.flush();
    if (this.worklet) this.worklet.port.onmessage = null;
    this.source?.disconnect();
    this.worklet?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx.close();
  }
}
