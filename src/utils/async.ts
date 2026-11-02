export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // En un cierre ordenado no queremos que un temporizador mantenga vivo el proceso.
    timer.unref?.();
  });
}

export interface TimeoutSignal {
  signal: AbortSignal;
  cleanup: () => void;
}

/**
 * Crea una señal que se aborta por timeout o por la señal padre.
 * Compatible con Node 20 sin depender de AbortSignal.any.
 */
export function createTimeoutSignal(
  timeoutMs: number,
  parent?: AbortSignal,
): TimeoutSignal {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort(new Error(`Timeout after ${timeoutMs} ms`));
  }, timeoutMs);
  timer.unref?.();

  const onParentAbort = () => {
    controller.abort(parent?.reason ?? new Error('Aborted'));
  };

  if (parent) {
    if (parent.aborted) onParentAbort();
    else parent.addEventListener('abort', onParentAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

export function backoffDelayMs(attempt: number, baseMs = 1000, maxMs = 60_000): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * Math.max(1, exponential * 0.2));
  return exponential + jitter;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      (error as { name?: unknown }).name === 'AbortError')
  );
}
