/** Little-endian PCM16 <-> base64. Every platform we target is little-endian. */

export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = "";
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP) as unknown as number[]);
  }
  return btoa(bin);
}

/**
 * The translate model streams audio continuously, including digital silence between
 * utterances. Those chunks must not reach the player: they would keep it "busy" forever
 * and half-duplex gating would never release the mic.
 */
export function isSilent(pcm: Int16Array, rmsThreshold = 0.001): boolean {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!;
  return Math.sqrt(sum / Math.max(1, pcm.length)) / 0x8000 < rmsThreshold;
}

export function base64ToPcm16(b64: string): Int16Array {
  const bin = atob(b64);
  const len = bin.length & ~1; // drop a dangling odd byte, if any
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}
