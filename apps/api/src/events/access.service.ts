import { Injectable } from '@nestjs/common';
import { E } from '../common/errors';
import { Principal } from '../common/request-context';
import { Db } from '../infra/db.service';

export type Role = 'owner' | 'moderator' | 'photographer';
export type Perm =
  | 'event.view' | 'event.update' | 'event.close' | 'event.share' | 'event.members' | 'event.export' | 'event.delete' | 'event.pay'
  | 'media.view_all' | 'media.moderate' | 'media.upload' | 'folder.manage' | 'insights.view' | 'guest.block' | 'media.view_own';

/**
 * Role-based access control + event membership (spec 4.1). Moderators cannot touch billing or ownership;
 * photographers cannot change event security. Platform roles do NOT appear here: staff never get
 * implicit access to event content through the host API.
 */
const MATRIX: Record<Role, Perm[]> = {
  owner: ['event.view', 'event.update', 'event.close', 'event.share', 'event.members', 'event.export', 'event.delete', 'event.pay',
    'media.view_all', 'media.moderate', 'media.upload', 'folder.manage', 'insights.view', 'guest.block', 'media.view_own'],
  moderator: ['event.view', 'event.share', 'media.view_all', 'media.moderate', 'folder.manage', 'insights.view', 'guest.block', 'media.upload', 'media.view_own'],
  photographer: ['event.view', 'media.upload', 'media.view_own', 'folder.manage'],
};

export const roleCan = (role: Role, perm: Perm): boolean => MATRIX[role].includes(perm);

@Injectable()
export class AccessService {
  constructor(private readonly db: Db) {}

  /**
   * Resolves membership + permission. Non-members receive 404 (not 403) so event ids cannot be probed.
   * State-dependent rules are applied separately via assertAllowed(event.state, action).
   */
  async requireMember(me: Principal, eventId: string, perm: Perm): Promise<{ event: any; role: Role; userId: string }> {
    if (me.kind !== 'user') throw E.unauthorized('authentication_required');
    if (!/^[0-9a-f-]{36}$/i.test(eventId)) throw E.notFound('event_not_found');
    const row = await this.db.one<any>(
      `SELECT m.role, e.* FROM event_members m JOIN events e ON e.id = m.event_id
        WHERE m.event_id = $1 AND m.user_id = $2 AND m.status = 'active'`, [eventId, me.userId]);
    if (!row) throw E.notFound('event_not_found');
    const role = row.role as Role;
    if (!roleCan(role, perm)) throw E.forbidden('insufficient_event_role', 'You do not have permission to do this in this event.');
    if (row.state === 'deleted') throw E.gone('event_deleted', 'This event was deleted.');
    const { role: _r, ...event } = row;
    return { event, role, userId: me.userId };
  }

  async loadEvent(eventId: string): Promise<any> {
    const ev = await this.db.one<any>('SELECT * FROM events WHERE id = $1', [eventId]);
    if (!ev) throw E.notFound('event_not_found');
    return ev;
  }
}
