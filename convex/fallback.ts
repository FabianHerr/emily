// Primary with a parallel backup (HANDOFF.md section 8). Pure helper: no Convex
// imports, so it runs in either runtime and in a plain Node script.

export type Winner = "primary" | "backup";
export type FallbackOutcome<T> = { value: T; winner: Winner } | null;
// Each attempt gets a signal that aborts as soon as the race is over, so the loser
// stops its request instead of running past the action.
export type Attempt<T> = (signal: AbortSignal) => Promise<T | null>;

// Starts primary. Starts backup at softMs, or earlier if primary fails or returns
// null. Returns the first non-null value and who gave it. Gives up at hardMs and
// returns null; also null when both fail. Never throws.
export function withFallback<T>(
  primary: Attempt<T>,
  backup: Attempt<T>,
  softMs: number,
  hardMs: number,
): Promise<FallbackOutcome<T>> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let done = false;
    let backupStarted = false;
    let running = 0;
    let softTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (outcome: FallbackOutcome<T>) => {
      if (done) return;
      done = true;
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
      controller.abort();
      resolve(outcome);
    };

    const run = (winner: Winner, attempt: Attempt<T>) => {
      running++;
      // Promise.resolve().then: a synchronous throw becomes a rejection too.
      Promise.resolve()
        .then(() => attempt(controller.signal))
        .then(
          (value) => (value === null || value === undefined ? null : value),
          () => null,
        )
        .then((value) => {
          running--;
          if (value !== null) return finish({ value, winner });
          if (!backupStarted) return startBackup();
          if (running === 0) finish(null);
        });
    };

    const startBackup = () => {
      if (done || backupStarted) return;
      backupStarted = true;
      clearTimeout(softTimer);
      run("backup", backup);
    };

    softTimer = setTimeout(startBackup, softMs);
    hardTimer = setTimeout(() => finish(null), hardMs);
    run("primary", primary);
  });
}
