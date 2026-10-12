'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

interface Settled<T> {
  load: () => Promise<T>;
  attempt: number;
  result: T;
}

/**
 * Runs `load` (memoize it: a new function starts a new request) and keeps its latest answer. An
 * `unauthenticated` answer sends the user back to the login (the session handling of the portal); `retry` re-runs
 * the request. `state` is `undefined` while the request is in flight.
 */
export function useRemote<T extends { kind: string }>(load: () => Promise<T>) {
  const router = useRouter();
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled<T>>();

  useEffect(() => {
    let active = true;
    void load().then((result) => {
      if (!active) return;
      if (result.kind === 'unauthenticated') router.replace('/login');
      else setSettled({ load, attempt, result });
    });
    return () => {
      active = false;
    };
  }, [load, attempt, router]);

  const state = settled?.load === load && settled.attempt === attempt ? settled.result : undefined;
  return {
    state,
    /** The last answer, kept while a newer request is in flight (so the screen can stay mounted). */
    previous: settled?.result,
    retry: () => {
      setAttempt((n) => n + 1);
    },
  };
}
