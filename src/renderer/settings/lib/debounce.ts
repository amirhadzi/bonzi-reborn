export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  /** Runs the pending call now, if any. */
  flush(): void;
  cancel(): void;
  pending(): boolean;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;

  const run = (): void => {
    timer = null;
    const args = lastArgs;
    lastArgs = null;
    if (args) fn(...args);
  };

  const d = ((...args: A): void => {
    lastArgs = args;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(run, waitMs);
  }) as Debounced<A>;

  d.flush = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    run();
  };
  d.cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  d.pending = (): boolean => timer !== null;
  return d;
}
