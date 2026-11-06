export interface HealthReport {
  status: 'up' | 'down';
  /** `skipped` when object storage is not configured (development/test). */
  storage: 'up' | 'down' | 'skipped';
  uptimeSeconds: number;
  checkedAt: string;
}
