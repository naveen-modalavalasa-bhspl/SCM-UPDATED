export interface SyncResult {
  entity: string;
  status: string; // RUNNING | SUCCESS | FAILED
  records_fetched: number;
  records_upserted: number;
  error_message?: string | null;
}

export interface SyncStatus {
  running: boolean;
  items: SyncResult[];
}

export interface Schedule {
  enabled: boolean;
  interval_minutes: number;
  next_run: string | null;
}
