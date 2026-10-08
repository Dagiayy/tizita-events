import { Inject, Injectable } from '@nestjs/common';
import { AppConfig, CONFIG } from '../common/config';
import { E } from '../common/errors';
import { Db, Q } from '../infra/db.service';

export interface EffectiveEntitlement {
  has_package: boolean;
  storage_bytes: number;
  max_media: number;
  retention_days: number;
  original_storage: boolean;
  allow_original_export: boolean;
  max_collaborators: number;
  photographer_seats: number;
  concurrent_uploads: number;
  branding: boolean;
  watermark: boolean;
}

const EMPTY: EffectiveEntitlement = {
  has_package: false, storage_bytes: 0, max_media: 0, retention_days: 0, original_storage: false, allow_original_export: false,
  max_collaborators: 1, photographer_seats: 0, concurrent_uploads: 2, branding: false, watermark: false,
};

/**
 * Entitlements are only ever created from (a) a payment order that the provider verified as paid,
 * (b) the once-per-owner free trial, or (c) an audited staff grant. Add-ons are explicit purchases:
 * storage overages are never billed silently (spec D60).
 */
@Injectable()
export class EntitlementsService {
  constructor(private readonly db: Db, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  async effective(eventId: string, q: Pick<Db, 'query'> | Q = this.db): Promise<EffectiveEntitlement> {
    const rows = (await q.query<any>(
      `SELECT e.*, p.kind FROM entitlements e JOIN plans p ON p.id = e.plan_id
        WHERE e.event_id = $1 AND e.state = 'active' AND (e.effective_to IS NULL OR e.effective_to > now()) ORDER BY e.created_at`, [eventId])).rows;
    if (!rows.length) return { ...EMPTY };
    const pkg = [...rows].reverse().find((r) => r.kind === 'package');
    const addons = rows.filter((r) => r.kind === 'addon');
    if (!pkg) return { ...EMPTY };
    const sum = (k: string) => addons.reduce((a, r) => a + Number(r[k]), 0);
    return {
      has_package: true,
      storage_bytes: Number(pkg.storage_bytes) + sum('storage_bytes'),
      max_media: pkg.max_media + sum('max_media'),
      retention_days: pkg.retention_days + sum('retention_days'),
      original_storage: pkg.original_storage || addons.some((a) => a.original_storage),
      allow_original_export: pkg.allow_original_export || addons.some((a) => a.allow_original_export),
      max_collaborators: pkg.max_collaborators,
      photographer_seats: pkg.photographer_seats,
      concurrent_uploads: pkg.concurrent_uploads,
      branding: pkg.branding,
      watermark: pkg.watermark,
    };
  }

  /** Grants the plan to an event. Called ONLY after verified payment, trial activation, or a staff grant. */
  async grant(q: Q, eventId: string, plan: any, source: 'payment' | 'free_trial' | 'staff_grant', orderId: string | null): Promise<void> {
    if (plan.kind === 'package') {
      // explicit upgrade: the new package supersedes the previous package; add-ons are kept.
      await q.query(
        `UPDATE entitlements SET state = 'revoked', effective_to = now()
          WHERE event_id = $1 AND state = 'active' AND plan_id IN (SELECT id FROM plans WHERE kind = 'package')`, [eventId]);
    }
    await q.query(
      `INSERT INTO entitlements (event_id, plan_id, source, order_id, storage_bytes, max_media, retention_days, original_storage, allow_original_export,
                                 max_collaborators, photographer_seats, concurrent_uploads, branding, watermark)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [eventId, plan.id, source, orderId, plan.storage_bytes, plan.max_media, plan.retention_days, plan.original_storage, plan.allow_original_export,
        plan.max_collaborators, plan.photographer_seats, plan.concurrent_uploads, plan.branding, plan.watermark]);
  }

  async assertCanAdd(eventId: string, kind: 'collaborator' | 'photographer'): Promise<void> {
    const ent = await this.effective(eventId);
    const counts = await this.db.one<{ moderators: number; photographers: number }>(
      `SELECT count(*) FILTER (WHERE role = 'moderator')::int AS moderators, count(*) FILTER (WHERE role = 'photographer')::int AS photographers
         FROM event_members WHERE event_id = $1 AND status IN ('active','invited') AND role <> 'owner'`, [eventId]);
    if (kind === 'photographer' && (counts?.photographers ?? 0) >= ent.photographer_seats) throw E.forbidden('plan_limit_photographers', 'Your package has no free photographer seats. Upgrade to add more.');
    if (kind === 'collaborator' && (counts?.moderators ?? 0) + (counts?.photographers ?? 0) >= ent.max_collaborators) throw E.forbidden('plan_limit_collaborators', 'Collaborator limit reached for your package.');
  }

  /** Quota snapshot used by upload intents and the insights/alerts (70/85/95/100 %). */
  async usage(eventId: string, q: Pick<Db, 'query'> | Q = this.db) {
    const ent = await this.effective(eventId, q);
    const u = (await q.query<{ bytes: number; n: number }>(
      `SELECT COALESCE(SUM(CASE WHEN stored_bytes > 0 THEN stored_bytes ELSE declared_size END),0)::bigint AS bytes, count(*)::int AS n
         FROM media WHERE event_id = $1 AND deleted_at IS NULL AND upload_state NOT IN ('failed','duplicate','cancelled')`, [eventId])).rows[0];
    const pct = ent.storage_bytes > 0 ? Math.min(100, Math.round((Number(u.bytes) / ent.storage_bytes) * 100)) : 100;
    return { used_bytes: Number(u.bytes), media_count: u.n, ent, percent: pct, alert_level: [100, 95, 85, 70].find((t) => pct >= t) ?? 0 };
  }
}
