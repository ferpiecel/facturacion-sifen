'use client';

import { useCallback } from 'react';

import type { SummaryClient } from './summary-client';
import { periodRange } from './summary-metrics';
import { useRemote } from './use-remote';

/** Loads the period summary of the last `days` days (re-requested when `days` changes). */
export function useSummary(client: SummaryClient, days: number) {
  const load = useCallback(() => client.get(periodRange(days)), [client, days]);
  return useRemote(load);
}
