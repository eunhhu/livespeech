export interface MicChunk {
  /** 16 kHz mono PCM16, ~100 ms. */
  pcm: Int16Array;
  /** 0..1 RMS level, for the meter. */
  rms: number;
}

/**
 * Platform audio boundary. `WebAudioIO` implements it with getUserMedia + Web Audio.
 * A native shell (Capacitor plugin on AVAudioEngine / AudioRecord) can implement the
 * same interface to get background capture and hardware echo cancellation without
 * touching the interpreter logic.
 */
export interface AudioIO {
  start(onChunk: (chunk: MicChunk) => void): Promise<void>;
  /** Queue 24 kHz mono PCM16 for gapless playback. */
  play(pcm: Int16Array): void;
  /** Drop everything queued for playback. */
  flush(): void;
  /** True while output audio is (or was within `tailMs`) playing. */
  isOutputBusy(tailMs: number): boolean;
  /** Re-resume after the OS/browser suspended audio (tab switch, call, etc). */
  recover(): Promise<void>;
  stop(): Promise<void>;
  /** Called when capture dies (track ended, device lost). */
  onCaptureLost?: () => void;
}
