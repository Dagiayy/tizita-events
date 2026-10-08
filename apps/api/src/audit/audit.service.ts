import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { requestContext } from '../common/request-context';
import { Db, Q } from '../infra/db.service';

export interface AuditInput {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  eventId?: string | null;
  reason?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  actor?: { type: 'user' | 'staff' | 'guest' | 'system' | 'provider'; id?: string | null; role?: string | null };
}

const LOCK_KEY = 7_001_001;

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
}

/**
 * Immutable, hash-chained audit log (spec 6.1 Audit, 18). Rows are append-only: a DB trigger rejects
 * UPDATE/DELETE, and each row embeds the hash of its predecessor so tampering is detectable via verifyChain().
 * Summaries must hold identifiers/state only - never message bodies, photo content or secrets.
 */
@Injectable()
export class AuditService {
  constructor(private readonly db: Db) {}

  async record(input: AuditInput, q?: Q): Promise<void> {
    if (q) return this.insert(q, input);
    await this.db.tx((c) => this.insert(c, input));
  }

  private async insert(q: Q, input: AuditInput): Promise<void> {
    const ctx = requestContext();
    const p = ctx?.principal;
    const actor = input.actor ?? (
      p?.kind === 'user' ? { type: p.platformRole !== 'none' ? 'staff' as const : 'user' as const, id: p.userId, role: p.platformRole !== 'none' ? p.platformRole : null }
      : p?.kind === 'guest' ? { type: 'guest' as const, id: p.sessionId, role: 'guest' }
      : { type: 'system' as const, id: null, role: null });
    await q.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    const last = await q.query<{ hash: string }>('SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1');
    const prev = last.rows[0]?.hash ?? null;
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const hash = AuditService.computeHash(prev, id, createdAt, actor.type, actor.id ?? null, input.action, input.resourceType, input.resourceId ?? null, input.reason ?? null,
      input.before ?? null, input.after ?? null);
    await q.query(
      `INSERT INTO audit_events (id, actor_type, actor_id, actor_role, action, resource_type, resource_id, event_id, reason,
                                 before_summary, after_summary, ip, user_agent, device, request_id, created_at, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17,$18)`,
      [id, actor.type, actor.id ?? null, actor.role ?? null, input.action, input.resourceType, input.resourceId ?? null, input.eventId ?? null,
        input.reason ?? null, input.before ? JSON.stringify(input.before) : null, input.after ? JSON.stringify(input.after) : null,
        ctx?.ip ?? null, ctx?.userAgent ?? null, ctx?.userAgent ? ctx.userAgent.slice(0, 120) : null, ctx?.requestId ?? null, createdAt, prev, hash],
    );
  }

  static computeHash(prev: string | null, id: string, createdAt: string, actorType: string, actorId: string | null, action: string,
    resourceType: string, resourceId: string | null, reason: string | null, before: unknown, after: unknown): string {
    // jsonb does not preserve key order, so summaries are hashed in canonical (sorted-key) form.
    return createHash('sha256').update(canonical([prev, id, createdAt, actorType, actorId, action, resourceType, resourceId, reason, before, after])).digest('hex');
  }

  /** Re-computes the chain; returns the first broken sequence number or null when intact. */
  async verifyChain(limit = 10000): Promise<{ checked: number; brokenAtSeq: number | null }> {
    const rows = await this.db.many<any>('SELECT * FROM audit_events ORDER BY seq ASC LIMIT $1', [limit]);
    let prev: string | null = null;
    let first = true;
    for (const r of rows) {
      if (!first && r.prev_hash !== prev) return { checked: rows.length, brokenAtSeq: Number(r.seq) };
      const h = AuditService.computeHash(r.prev_hash, r.id, r.created_at.toISOString(), r.actor_type, r.actor_id, r.action, r.resource_type, r.resource_id, r.reason, r.before_summary, r.after_summary);
      if (h !== r.hash) return { checked: rows.length, brokenAtSeq: Number(r.seq) };
      prev = r.hash; first = false;
    }
    return { checked: rows.length, brokenAtSeq: null };
  }

  async search(f: { actorId?: string; action?: string; resourceType?: string; resourceId?: string; eventId?: string; before?: number; limit?: number }) {
    const where: string[] = []; const params: unknown[] = [];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (f.actorId) add('actor_id = ?', f.actorId);
    if (f.action) add('action LIKE ?', f.action.replace(/[%_]/g, '') + '%');
    if (f.resourceType) add('resource_type = ?', f.resourceType);
    if (f.resourceId) add('resource_id = ?', f.resourceId);
    if (f.eventId) add('event_id = ?', f.eventId);
    if (f.before) add('seq < ?', f.before);
    params.push(Math.min(f.limit ?? 50, 200));
    return this.db.many(
      `SELECT seq, id, actor_type, actor_id, actor_role, action, resource_type, resource_id, event_id, reason, before_summary, after_summary,
              host(ip) AS ip, device, request_id, created_at
         FROM audit_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq DESC LIMIT $${params.length}`, params);
  }
}
