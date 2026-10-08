import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow, types } from 'pg';
import { AppConfig, CONFIG } from '../common/config';

// bigint (counts/bytes) -> number; numeric (ETB amounts, 2 dp) -> number. phash is always read via ::text.
types.setTypeParser(20, (v) => parseInt(v, 10));
types.setTypeParser(1700, (v) => parseFloat(v));

export type Q = { query: <R extends QueryResultRow = any>(sql: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }> };

@Injectable()
export class Db implements Q, OnModuleDestroy {
  readonly pool: Pool;
  constructor(@Inject(CONFIG) cfg: AppConfig) {
    this.pool = new Pool({
      connectionString: cfg.DATABASE_URL,
      max: cfg.DATABASE_POOL_MAX,
      ssl: cfg.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
      statement_timeout: 30_000,
      idle_in_transaction_session_timeout: 60_000,
    });
  }

  query<R extends QueryResultRow = any>(sql: string, params?: unknown[]) {
    return this.pool.query<R>(sql, params as any[]);
  }
  async one<R extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<R | null> {
    const r = await this.query<R>(sql, params);
    return r.rows[0] ?? null;
  }
  async many<R extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<R[]> {
    return (await this.query<R>(sql, params)).rows;
  }

  /** Runs fn inside a transaction; the supplied client has the same query() shape as Db. */
  async tx<T>(fn: (c: Q & { client: PoolClient }) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const wrapper = {
        client,
        query: <R extends QueryResultRow = any>(sql: string, params?: unknown[]) => client.query<R>(sql, params as any[]),
      };
      const out = await fn(wrapper);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
