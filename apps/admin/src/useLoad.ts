import { useCallback, useEffect, useState } from "react";

/** Loads data, exposes reload and the last error. Optional polling. */
export function useLoad<T>(fn: () => Promise<T>, pollMs?: number) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string>("");
  const reload = useCallback(
    () =>
      fn()
        .then((d) => {
          setData(d);
          setError("");
        })
        .catch((e: Error) => setError(e.message)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => {
    void reload();
    if (!pollMs) return;
    const t = setInterval(() => void reload(), pollMs);
    return () => clearInterval(t);
  }, [reload, pollMs]);
  return { data, error, reload, setError };
}

/** Wraps an action: runs it, reports errors, then reloads. */
export function useAction(reload: () => unknown, setError: (e: string) => void) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      await reload();
    }
  };
  return { busy, run };
}
