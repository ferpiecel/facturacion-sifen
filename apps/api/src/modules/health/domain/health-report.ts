export interface HealthReport {
  status: 'up' | 'down';
  uptimeSeconds: number;
  checkedAt: string;
}
