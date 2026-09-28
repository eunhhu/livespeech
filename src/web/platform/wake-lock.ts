/**
 * Keeps the screen on while interpreting. On the web this is the main defence against
 * the OS suspending mic capture: a locked screen or backgrounded tab stops audio on
 * iOS Safari, and is unreliable on Android Chrome.
 */
export class ScreenWakeLock {
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;

  constructor() {
    document.addEventListener("visibilitychange", () => {
      // The lock is released automatically when the page is hidden.
      if (this.wanted && document.visibilityState === "visible") void this.acquire();
    });
  }

  get supported(): boolean {
    return "wakeLock" in navigator;
  }

  async enable(): Promise<void> {
    this.wanted = true;
    await this.acquire();
  }

  async disable(): Promise<void> {
    this.wanted = false;
    await this.sentinel?.release().catch(() => {});
    this.sentinel = null;
  }

  private async acquire(): Promise<void> {
    if (!this.supported || this.sentinel) return;
    try {
      this.sentinel = await navigator.wakeLock.request("screen");
      this.sentinel.addEventListener("release", () => (this.sentinel = null));
    } catch {
      // Denied (battery saver, not visible, etc.) — non-fatal.
    }
  }
}
