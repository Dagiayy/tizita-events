import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { E } from '../common/errors';
import { Db } from './db.service';

/**
 * Idempotency for upload completion, payment orders and exports (spec 15.3).
 * Same key + same request => stored response is replayed. Same key + different request => 422.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly db: Db) {}

  async run<T>(scope: string, key: string | undefined, request: unknown, fn: () => Promise<T>): Promise<T> {
    if (!key) return fn();
    if (!/^[A-Za-z0-9_\-:.]{8,128}$/.test(key)) throw E.badRequest('invalid_idempotency_key', 'Idempotency-Key must be 8-128 URL-safe characters');
    const hash = createHash('sha256').update(JSON.stringify(request ?? null)).digest('hex');
    const ins = await this.db.query(
      `INSERT INTO idempotency_keys (scope, key, request_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [scope, key, hash],
    );
    if (ins.rowCount === 0) {
      const prev = await this.db.one<{ request_hash: string; response: T | null; status_code: number | null }>(
        'SELECT request_hash, response, status_code FROM idempotency_keys WHERE scope = $1 AND key = $2', [scope, key]);
      if (!prev) return this.run(scope, key, request, fn);
      if (prev.request_hash !== hash) throw E.unprocessable('idempotency_key_reuse', 'This Idempotency-Key was used with a different request');
      if (prev.status_code === null) throw E.conflict('request_in_progress', 'A request with this Idempotency-Key is still in progress');
      return prev.response as T;
    }
    try {
      const out = await fn();
      await this.db.query('UPDATE idempotency_keys SET status_code = 200, response = $3::jsonb WHERE scope = $1 AND key = $2',
        [scope, key, JSON.stringify(out ?? null)]);
      return out;
    } catch (e) {
      await this.db.query('DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2', [scope, key]).catch(() => undefined);
      throw e;
    }
  }

  async purgeOld(hours = 48): Promise<number> {
    const r = await this.db.query(`DELETE FROM idempotency_keys WHERE created_at < now() - ($1 || ' hours')::interval`, [String(hours)]);
    return r.rowCount ?? 0;
  }
}
