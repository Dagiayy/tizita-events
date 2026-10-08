/**
 * Generates the route reference table from the real controllers (method, path, auth policy, handler) so docs/API.md can
 * never drift from the code:   npm run docs:routes > ../../docs/API_ROUTES.md
 */
import 'reflect-metadata';
import { NestFactory, ModulesContainer, Reflector } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { AUTH_KEY, AuthSpec } from '../src/auth/auth.guard';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];

function describe(spec: AuthSpec | undefined): string {
  if (!spec) return '**none (denied)**';
  switch (spec.kind) {
    case 'public': return 'public (rate-limited / token-checked in service)';
    case 'user': return 'host/collaborator access token';
    case 'staff': return `staff${spec.roles ? ` (${spec.roles.join(', ')})` : ''} + 2FA`;
    case 'guest': return `guest session${spec.scope ? ` (scope: ${spec.scope})` : ''}`;
    case 'user_or_guest': return 'host token or guest session';
  }
}

async function main() {
  process.env.APP_ROLE = 'api';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const reflector = new Reflector();
  const rows: { m: string; p: string; a: string; h: string }[] = [];
  for (const mod of app.get(ModulesContainer).values()) {
    for (const ctrl of mod.controllers.values()) {
      const proto = ctrl.metatype?.prototype; if (!proto) continue;
      const base: string = Reflect.getMetadata('path', ctrl.metatype!) ?? '';
      for (const name of Object.getOwnPropertyNames(proto)) {
        const fn = proto[name];
        if (typeof fn !== 'function' || name === 'constructor') continue;
        const path = Reflect.getMetadata('path', fn); const method = Reflect.getMetadata('method', fn);
        if (path === undefined || method === undefined) continue;
        const spec = reflector.getAllAndOverride<AuthSpec | undefined>(AUTH_KEY, [fn, ctrl.metatype!]);
        rows.push({ m: METHODS[method] ?? String(method), p: `/${[base, path].filter(Boolean).join('/')}`.replace(/\/+/g, '/'), a: describe(spec), h: `${ctrl.metatype!.name}.${name}` });
      }
    }
  }
  rows.sort((x, y) => x.p.localeCompare(y.p) || x.m.localeCompare(y.m));
  console.log('# Route reference (generated)\n');
  console.log(`Generated from controller metadata - ${rows.length} routes. Do not edit by hand: \`npm run docs:routes\`.\n`);
  console.log('| Method | Path | Authentication | Handler |\n|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.m} | \`${r.p}\` | ${r.a} | ${r.h} |`);
  await app.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
