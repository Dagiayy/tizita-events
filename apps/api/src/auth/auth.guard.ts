import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import { AppConfig, CONFIG } from '../common/config';
import { E } from '../common/errors';
import { Principal, setPrincipal } from '../common/request-context';
import { Db } from '../infra/db.service';
import { SettingsService } from '../infra/settings.service';
import { AuthService } from './auth.service';

export type AuthSpec =
  | { kind: 'public' }
  | { kind: 'user' }                                                // any signed-in host/collaborator/staff user
  | { kind: 'staff'; roles?: ('super_admin' | 'support_agent')[]; mfa?: boolean }
  | { kind: 'guest'; scope?: 'upload' | 'gallery' }
  | { kind: 'user_or_guest'; scope?: 'upload' | 'gallery' };

export const AUTH_KEY = 'auth_spec';
export const Auth = (spec: AuthSpec) => SetMetadata(AUTH_KEY, spec);
export const Public = () => Auth({ kind: 'public' });

export const Me = createParamDecorator((_d: unknown, ctx: ExecutionContext): Principal => ctx.switchToHttp().getRequest().principal ?? { kind: 'anon' });

export interface GuestClaims { sid: string; eid: string; scp: ('upload' | 'gallery')[]; typ: 'guest' }

/**
 * Global authentication gate. Every route must declare an @Auth spec (default deny: routes without
 * one are rejected). Authorization against a specific event/media is then enforced in services.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly db: Db,
    private readonly settings: SettingsService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const spec = this.reflector.getAllAndOverride<AuthSpec | undefined>(AUTH_KEY, [ctx.getHandler(), ctx.getClass()]);
    const req = ctx.switchToHttp().getRequest();
    if (!spec) throw E.forbidden('route_not_exposed'); // default deny
    const bearer = /^Bearer (.+)$/i.exec(req.header('authorization') ?? '')?.[1];
    let principal: Principal = { kind: 'anon' };

    if (spec.kind !== 'public' || bearer) {
      if (bearer && (spec.kind === 'user' || spec.kind === 'staff' || spec.kind === 'user_or_guest' || spec.kind === 'public')) {
        const asUser = await this.tryUser(bearer);
        if (asUser) principal = asUser;
      }
      if (principal.kind === 'anon' && bearer && (spec.kind === 'guest' || spec.kind === 'user_or_guest' || spec.kind === 'public')) {
        const g = await this.tryGuest(bearer);
        if (g) principal = g;
      }
    }
    req.principal = principal;
    setPrincipal(principal);

    if (spec.kind === 'public') return this.maintenance(req, principal);
    if (principal.kind === 'anon') throw E.unauthorized('authentication_required', 'Sign in required.');

    switch (spec.kind) {
      case 'user':
        if (principal.kind !== 'user') throw E.forbidden('user_token_required');
        break;
      case 'staff': {
        if (principal.kind !== 'user' || principal.platformRole === 'none') throw E.forbidden('staff_only');
        if (spec.roles && !spec.roles.includes(principal.platformRole)) throw E.forbidden('insufficient_role');
        if (spec.mfa !== false && this.cfg.ADMIN_MFA_REQUIRED && !principal.mfa) throw E.forbidden('mfa_required', 'Two-factor authentication is required.', { mfa: true });
        break;
      }
      case 'guest':
      case 'user_or_guest':
        if (principal.kind === 'user' && spec.kind === 'guest') throw E.forbidden('guest_token_required');
        if (principal.kind === 'guest' && spec.scope && !principal.scopes.includes(spec.scope)) throw E.forbidden('scope_not_granted', 'Your session does not include this permission.');
        break;
    }
    return this.maintenance(req, principal);
  }

  private async maintenance(req: any, p: Principal): Promise<boolean> {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
    if (p.kind === 'user' && p.platformRole !== 'none') return true;
    if (await this.settings.get<boolean>('maintenance.mode', false)) throw E.unavailable('maintenance_mode', 'The service is in maintenance mode. Please try again shortly.');
    return true;
  }

  private async tryUser(token: string): Promise<Principal | null> {
    let claims;
    try { claims = this.auth.verifyAccess(token); } catch { return null; }
    const s = await this.auth.isSessionActive(claims.sid, claims.sub);
    if (!s.active) throw E.unauthorized('session_revoked', 'This session is no longer active.');
    // Role/MFA are re-read from the DB so demotion or revocation takes effect immediately.
    return { kind: 'user', userId: claims.sub, sessionId: claims.sid, platformRole: s.role, mfa: s.mfa && claims.mfa };
  }

  private async tryGuest(token: string): Promise<Principal | null> {
    let c: GuestClaims;
    try { c = jwt.verify(token, this.cfg.JWT_GUEST_SECRET, { algorithms: ['HS256'], issuer: 'event-platform' }) as GuestClaims; } catch { return null; }
    if (c.typ !== 'guest') return null;
    const s = await this.db.one<{ blocked_at: string | null; expires_at: string; scopes: string[] }>(
      'SELECT blocked_at, expires_at, scopes FROM guest_sessions WHERE id = $1 AND event_id = $2', [c.sid, c.eid]);
    if (!s || new Date(s.expires_at) < new Date()) throw E.unauthorized('guest_session_expired', 'Your session expired. Please rejoin the event.');
    if (s.blocked_at) throw E.forbidden('session_blocked', 'You can no longer contribute to this event.');
    // scopes come from the DB row, so revoking a scope server-side is immediate
    return { kind: 'guest', sessionId: c.sid, eventId: c.eid, scopes: s.scopes as ('upload' | 'gallery')[] };
  }
}
