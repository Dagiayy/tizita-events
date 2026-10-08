import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

export type Principal =
  | { kind: 'anon' }
  | { kind: 'user'; userId: string; sessionId: string; platformRole: 'none' | 'super_admin' | 'support_agent'; mfa: boolean }
  | { kind: 'guest'; sessionId: string; eventId: string; scopes: ('upload' | 'gallery')[] };

export interface RequestContext {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  principal: Principal;
}

const als = new AsyncLocalStorage<RequestContext>();

export const requestContext = (): RequestContext | undefined => als.getStore();

export function runWithContext<T>(ctx: Partial<RequestContext>, fn: () => T): T {
  return als.run({ requestId: randomUUID(), ip: null, userAgent: null, principal: { kind: 'anon' }, ...ctx }, fn);
}

export function setPrincipal(p: Principal): void {
  const s = als.getStore();
  if (s) s.principal = p;
}

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const requestId = incoming && /^[A-Za-z0-9_-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', requestId);
  als.run({ requestId, ip: req.ip ?? null, userAgent: (req.header('user-agent') ?? '').slice(0, 300) || null, principal: { kind: 'anon' } }, next);
}
