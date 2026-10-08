import { Injectable } from '@nestjs/common';
import { Db } from './db.service';

/** Runtime-tunable platform configuration (spec 6.1 "Configuration"). 10 s in-process cache. */
@Injectable()
export class SettingsService {
  private cache = new Map<string, { v: unknown; at: number }>();
  constructor(private readonly db: Db) {}

  async get<T>(key: string, fallback: T): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 10_000) return hit.v as T;
    const row = await this.db.one<{ value: T }>('SELECT value FROM system_settings WHERE key = $1', [key]);
    const v = row ? row.value : fallback;
    this.cache.set(key, { v, at: Date.now() });
    return v;
  }

  async list(): Promise<{ key: string; value: unknown; description: string | null; updated_at: string }[]> {
    return this.db.many('SELECT key, value, description, updated_at FROM system_settings ORDER BY key');
  }

  async set(key: string, value: unknown, actorId: string | null): Promise<void> {
    await this.db.query(
      `INSERT INTO system_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), actorId],
    );
    this.cache.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return !!(await this.db.one('SELECT 1 FROM system_settings WHERE key = $1', [key]));
  }
  invalidate(): void { this.cache.clear(); }
}
