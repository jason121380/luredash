/**
 * Simple async Semaphore for rate-limiting concurrent operations.
 *
 * Used to gate eager prefetch fan-outs (e.g. 安全監控's 30 parallel
 * /api/accounts/:id/activities calls) so the browser doesn't open
 * 30 sockets at once and so the backend's per-account FB semaphore
 * doesn't queue every request behind the same global 40-slot pool.
 *
 *   const sem = new Semaphore(5);
 *   await sem.run(() => api.accounts.activities(id, ...));
 */
export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error("Semaphore capacity must be >= 1");
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.capacity) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}
