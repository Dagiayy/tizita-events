import { Injectable } from '@nestjs/common';
import { Db } from '../infra/db.service';

/** Allow-list of client-reportable funnel steps. Counters are per event per day - no personal data (spec 17.1). */
export const CLIENT_METRICS = ['capture_select', 'share'] as const;

@Injectable()
export class AnalyticsService {
  constructor(private readonly db: Db) {}

  /** Fire-and-forget aggregate counter. Analytics must never fail or slow a user request. */
  inc(eventId: string, metric: string, n = 1): void {
    this.db.query(
      `INSERT INTO analytics_counters (event_id, day, metric, n) VALUES ($1, (now() AT TIME ZONE 'Africa/Addis_Ababa')::date, $2, $3)
       ON CONFLICT (event_id, day, metric) DO UPDATE SET n = analytics_counters.n + EXCLUDED.n`, [eventId, metric, n]).catch(() => undefined);
  }

  max(eventId: string, metric: string, value: number): void {
    this.db.query(
      `INSERT INTO analytics_counters (event_id, day, metric, n) VALUES ($1, (now() AT TIME ZONE 'Africa/Addis_Ababa')::date, $2, $3)
       ON CONFLICT (event_id, day, metric) DO UPDATE SET n = GREATEST(analytics_counters.n, EXCLUDED.n)`, [eventId, metric, value]).catch(() => undefined);
  }

  /** First occurrence of a step per guest session (gives unique viewers without tracking identity). Returns true if first. */
  async step(sessionId: string, eventId: string, step: string): Promise<boolean> {
    const r = await this.db.query(
      'INSERT INTO analytics_session_steps (session_id, event_id, step) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [sessionId, eventId, step]).catch(() => null);
    return (r?.rowCount ?? 0) > 0;
  }

  /** Platform-level KPIs (spec 17.2) computed from aggregates. */
  async platformKpis(days = 30) {
    const d = String(days);
    const [ev, up, dl, pay, ticket, del, med] = await Promise.all([
      this.db.one<any>(
        `SELECT count(*)::int AS created,
                count(*) FILTER (WHERE activated_at IS NOT NULL)::int AS activated
           FROM events WHERE created_at > now() - ($1 || ' days')::interval`, [d]),
      this.db.one<any>(
        `SELECT COALESCE(sum(n) FILTER (WHERE metric='upload_intent'),0)::int AS intents, COALESCE(sum(n) FILTER (WHERE metric='upload_complete'),0)::int AS completes,
                COALESCE(sum(n) FILTER (WHERE metric='join'),0)::int AS joins, COALESCE(sum(n) FILTER (WHERE metric='landing_view'),0)::int AS landings,
                COALESCE(sum(n) FILTER (WHERE metric='upload_failed'),0)::int AS failed, COALESCE(max(n) FILTER (WHERE metric='peak_active_uploads'),0)::int AS peak_concurrency,
                COALESCE(sum(n) FILTER (WHERE metric='gallery_view'),0)::int AS gallery_views
           FROM analytics_counters WHERE day > (now() - ($1 || ' days')::interval)::date`, [d]),
      this.db.one<any>(`SELECT COALESCE(sum(n),0)::int AS n FROM analytics_counters WHERE metric='download' AND day > (now() - ($1 || ' days')::interval)::date`, [d]),
      this.db.one<any>(`SELECT count(DISTINCT event_id) FILTER (WHERE state='paid' OR state LIKE 'refund%')::int AS paid_events FROM payment_orders WHERE created_at > now() - ($1 || ' days')::interval`, [d]),
      this.db.one<any>(`SELECT count(*)::int AS n FROM support_tickets WHERE created_at > now() - ($1 || ' days')::interval`, [d]),
      this.db.one<any>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE status='completed' AND completed_at <= scheduled_at + interval '7 days')::int AS on_time
           FROM deletion_jobs WHERE scheduled_at > now() - ($1 || ' days')::interval AND scheduled_at <= now() AND status IN ('completed','failed','pending','running')`, [d]),
      this.db.one<any>(
        `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (published_at - created_at))) AS median_s FROM media WHERE published_at IS NOT NULL AND created_at > now() - ($1 || ' days')::interval`, [d]),
    ]);
    const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);
    return {
      window_days: days,
      event_activation_rate: ratio(ev.activated, ev.created),
      paid_conversion: ratio(pay.paid_events, ev.created),
      guest_join_rate: ratio(up.joins, up.landings),
      upload_completion_rate: ratio(up.completes, up.intents),
      upload_failure_rate: ratio(up.failed, up.intents),
      median_upload_to_publish_seconds: med.median_s === null ? null : Math.round(Number(med.median_s)),
      peak_concurrency: up.peak_concurrency,
      gallery_views: up.gallery_views,
      downloads: dl.n,
      support_tickets_per_100_events: ev.created > 0 ? Math.round((ticket.n / ev.created) * 100 * 10) / 10 : null,
      deletion_compliance: ratio(del.on_time, del.total),
    };
  }
}
