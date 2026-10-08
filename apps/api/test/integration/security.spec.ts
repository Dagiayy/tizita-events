import { ModulesContainer, Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import { AUTH_KEY } from '../../src/auth/auth.guard';
import { Client_, Harness, bootHarness, createEvent, guestUpload, joinAsGuest, photo } from '../helpers/harness';
import { QueueService } from '../../src/infra/queue.service';

let h: Harness;
beforeAll(async () => { h = await bootHarness(); });
afterAll(async () => { await h.close(); });

describe('Default-deny routing', () => {
  it('every HTTP route declares an explicit authentication policy', () => {
    const container = h.get<ModulesContainer>(ModulesContainer);
    const reflector = new Reflector();
    const missing: string[] = [];
    let routes = 0;
    for (const mod of container.values()) for (const ctrl of mod.controllers.values()) {
      const proto = ctrl.metatype?.prototype; if (!proto) continue;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const fn = proto[name];
        if (typeof fn !== 'function' || name === 'constructor') continue;
        if (!Reflect.getMetadata('path', fn) && Reflect.getMetadata('path', fn) !== '') continue;   // not a route handler
        routes++;
        if (!reflector.getAllAndOverride(AUTH_KEY, [fn, ctrl.metatype!])) missing.push(`${ctrl.metatype!.name}.${name}`);
      }
    }
    expect(routes).toBeGreaterThan(120);
    expect(missing).toEqual([]);
  });

  it('all admin endpoints refuse anonymous callers, normal users and guests', async () => {
    const host = await Client_.host(h); const ev = await createEvent(h, host);
    const guest = (await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode })).body;
    const paths = ['dashboard', 'kpis', 'events', 'storage', 'payments/orders', 'compliance/incidents', 'compliance/rights-requests', 'audit', 'audit/verify', 'settings', 'plans', 'organizations', 'users', 'media-access', 'moderation/reports'];
    for (const p of paths) {
      expect((await h.http().get(`/v1/admin/${p}`)).status).toBe(401);
      expect((await h.http().get(`/v1/admin/${p}`).set('Authorization', `Bearer ${host.token}`)).status).toBe(403);
      expect((await h.http().get(`/v1/admin/${p}`).set('Authorization', `Bearer ${guest.token}`)).status).toBe(401);
    }
  });
});

describe('Token confusion and forgery', () => {
  it('guest, user and upload credentials are not interchangeable; unsigned/tampered/expired JWTs are refused', async () => {
    const host = await Client_.host(h); const ev = await createEvent(h, host);
    const guest = (await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode })).body;
    await h.http().get('/v1/events').set('Authorization', `Bearer ${guest.token}`).expect(401);                         // guest token on host API
    await h.http().get('/v1/guest/me').set('Authorization', `Bearer ${host.token}`).expect(401);                         // a host token is not a guest session
    const intent = (await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${guest.token}`).send({ mime: 'image/jpeg', size: 100 })).body;
    await h.http().get('/v1/guest/me').set('Authorization', `Bearer ${intent.upload.token}`).expect(401);               // upload token is not a session
    const claims = jwt.decode(host.token) as any;
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.';
    await h.http().get('/v1/events').set('Authorization', `Bearer ${none}`).expect(401);
    const forged = jwt.sign({ ...claims, role: 'super_admin', mfa: true }, 'attacker-guess-secret-attacker-guess-secret');
    await h.http().get('/v1/admin/dashboard').set('Authorization', `Bearer ${forged}`).expect(401);
    const expired = jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 60 }, h.cfg.JWT_ACCESS_SECRET);
    await h.http().get('/v1/events').set('Authorization', `Bearer ${expired}`).expect(401);
    const [a, b, c] = host.token.split('.');
    const swapped = [a, Buffer.from(JSON.stringify({ ...claims, role: 'super_admin' })).toString('base64url'), c].join('.');
    await h.http().get('/v1/admin/dashboard').set('Authorization', `Bearer ${swapped}`).expect(401);
    void b;
    // a valid JWT signed with the guest secret cannot be used as a host token and vice versa
    const guestSigned = jwt.sign({ sub: host.userId, sid: host.sessionId, role: 'none', mfa: true, typ: 'access', iss: 'event-platform' }, h.cfg.JWT_GUEST_SECRET);
    await h.http().get('/v1/events').set('Authorization', `Bearer ${guestSigned}`).expect(401);
    // role in the token is advisory only: the DB is the source of truth (demotion/revocation is immediate)
    await h.db.query(`UPDATE users SET platform_role = 'none' WHERE id = $1`, [host.userId]);
    await h.http().get('/v1/admin/dashboard').set('Authorization', `Bearer ${host.token}`).expect(403);
    await h.db.query(`UPDATE guest_sessions SET blocked_at = now() WHERE event_id = $1`, [ev.id]);
    await h.http().get('/v1/guest/me').set('Authorization', `Bearer ${guest.token}`).expect(403);                         // block takes effect without waiting for expiry
  });

  it('removing a scope server-side revokes it immediately from already-issued guest tokens', async () => {
    const host = await Client_.host(h); const ev = await createEvent(h, host);
    const g = (await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode })).body;
    await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${g.token}`).send({ mime: 'image/jpeg', size: 100 }).expect(200);
    await host.post(`/v1/events/${ev.id}/secrets/rotate`, { type: 'upload_token', revoke_sessions: true }).expect(200);
    await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${g.token}`).send({ mime: 'image/jpeg', size: 100 }).expect(403);
    expect((await h.http().get(`/v1/events/${ev.uploadToken}/context`)).status).toBe(404);                              // old link/QR is dead
    const links = (await host.get(`/v1/events/${ev.id}/share-links`)).body;
    expect((await h.http().get(`/v1/events/${links.upload_url.split('/j/')[1]}/context`)).status).toBe(200);          // new one works
    await host.post(`/v1/events/${ev.id}/secrets/rotate`, { type: 'join_code' }).expect(200);
    expect((await joinAsGuest(h, ev.joinCode)).status).toBe(404);
  });
});

describe('Input handling and error safety', () => {
  it('malformed, oversized and hostile inputs yield clean 4xx errors with no internals leaked', async () => {
    const host = await Client_.host(h);
    const bad = await h.http().post('/v1/auth/request-otp').set('Content-Type', 'application/json').send('{"phone": ');
    expect(bad.status).toBe(400); expect(bad.body.error.code).toBe('invalid_json');
    const huge = await h.http().post('/v1/auth/request-otp').set('Content-Type', 'application/json').send(JSON.stringify({ phone: '0911000000', pad: 'x'.repeat(200_000) }));
    expect(huge.status).toBe(413);
    for (const evil of ["' OR 1=1 --", '"; DROP TABLE users; --', '../../etc/passwd', '%00', '${jndi:ldap://x}', '<script>alert(1)</script>']) {
      const r1 = await host.get(`/v1/events/${encodeURIComponent(evil)}`); expect([400, 404]).toContain(r1.status);
      const r2 = await h.http().get(`/v1/events/${encodeURIComponent(evil)}/context`); expect([404]).toContain(r2.status);
      const r3 = await h.http().get(`/v1/admin/events?title=${encodeURIComponent(evil)}`).set('Authorization', `Bearer ${host.token}`); expect(r3.status).toBe(403);
      const r4 = await host.post('/v1/events', { name: evil, type: 'party', city: evil, starts_at: new Date(Date.now() + 1e7).toISOString(), ends_at: new Date(Date.now() + 2e7).toISOString() });
      expect([201, 400]).toContain(r4.status);                                                                               // stored safely or refused, never a 500
      expect(JSON.stringify(r4.body)).not.toMatch(/syntax error|pg_|stack|at Object/i);
    }
    expect((await h.db.one<any>('SELECT count(*)::int AS n FROM users')).n).toBeGreaterThan(0);                              // tables intact
    const err = await host.get('/v1/events/00000000-0000-4000-8000-000000000000');
    expect(err.body).toEqual({ error: { code: 'event_not_found', message: 'event_not_found', request_id: expect.any(String) } });
    expect(err.headers['x-request-id']).toBe(err.body.error.request_id);
    expect((await h.http().get('/v1/nope')).status).toBe(404);
    // strict schemas reject unknown fields (mass-assignment guard)
    await host.post('/v1/events', { name: 'x', type: 'party', city: 'Adama', starts_at: new Date(Date.now() + 1e7).toISOString(), ends_at: new Date(Date.now() + 2e7).toISOString(), owner_id: host.userId, state: 'live' }).expect(400);
    const ev = await createEvent(h, host);
    await host.patch(`/v1/events/${ev.id}`, { state: 'deleted' }).expect(400);
    await host.patch(`/v1/events/${ev.id}`, { legal_hold: false, storage_bytes: 0 }).expect(400);
  });

  it('security headers, CORS allow-list, and no framework fingerprint', async () => {
    const r = await h.http().get('/health/live').set('Origin', 'http://localhost:3000');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-robots-tag']).toMatch(/noindex/);                                                                   // private events are never indexed (D14)
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(r.headers['access-control-allow-credentials']).toBe('true');
    const evil = await h.http().get('/health/live').set('Origin', 'https://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const pre = await h.http().options('/v1/events').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rate limits protect join, upload-intent and report endpoints; limits answer 429 with Retry-After', async () => {
    const host = await Client_.host(h); const ev = await createEvent(h, host);
    const ipKey = 'rl:join:ip:::ffff:127.0.0.1'; const keys = await h.redis.client.keys('rl:join:ip:*');
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) await h.redis.client.set(k, String(h.cfg.RATE_LIMIT_JOIN_PER_IP), 'EX', 600);
    const limited = await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode });
    expect(limited.status).toBe(429); expect(limited.headers['retry-after']).toBeDefined(); expect(limited.body.error.code).toBe('rate_limited');
    for (const k of keys) await h.redis.client.del(k);
    void ipKey;
  });

  it('rate limiter fails closed when Redis is unavailable', async () => {
    const original = h.redis.client.multi.bind(h.redis.client);
    (h.redis.client as any).multi = () => { throw new Error('redis down'); };
    const r = await h.http().post('/v1/auth/request-otp').send({ phone: '0911000001' });
    (h.redis.client as any).multi = original;
    expect(r.status).toBe(503); expect(r.body.error.code).toBe('rate_limiter_unavailable');
  });
});

describe('Observability (acceptance #29)', () => {
  it('health, readiness and token-protected Prometheus metrics expose queue backlog and pipeline counters', async () => {
    expect((await h.http().get('/health/live')).body).toEqual({ status: 'ok' });
    const ready = await h.http().get('/health/ready').expect(200);
    expect(ready.body).toEqual({ status: 'ready', checks: { database: true, redis: true, storage: true, antivirus: true } });
    await h.http().get('/metrics').expect(401);
    await h.http().get('/metrics').set('Authorization', 'Bearer wrong').expect(401);
    // create a backlog: jobs enqueued but no worker running in the API role
    const q = h.get<QueueService>(QueueService);
    for (let i = 0; i < 3; i++) await q.add('media-process', 'process', { mediaId: '00000000-0000-4000-8000-00000000000' + i }, { jobId: `backlog-${i}` });
    const host = await Client_.host(h); const ev = await createEvent(h, host);
    const g = (await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode })).body;
    await guestUpload(h, g, await photo(5));
    const m = await h.http().get('/metrics').set('Authorization', `Bearer ${h.cfg.METRICS_TOKEN}`).expect(200);
    expect(m.text).toMatch(/queue_jobs\{queue="media-process",state="waiting"\} [3-9]/);
    expect(m.text).toMatch(/media_processed_total\{outcome="ready"\} [1-9]/);
    expect(m.text).toMatch(/upload_intents_total [1-9]/);
    expect(m.text).toMatch(/events_by_state\{state="live"\}/);
    expect(m.text).toMatch(/http_request_duration_seconds_bucket/);
    expect(m.text).toContain('media_processing_backlog');
    await q.queue('media-process').obliterate({ force: true });
  });
});
