import { INestApplication } from '@nestjs/common';
import * as express from 'express';
import { AppConfig, CONFIG } from './common/config';
import { MetricsService } from './infra/metrics.service';

/** Shared HTTP configuration for the real server and for integration tests. */
export function configureApp(app: INestApplication, cfg: AppConfig): void {
  const http = app.getHttpAdapter().getInstance();
  http.disable('x-powered-by');
  if (cfg.TRUST_PROXY) http.set('trust proxy', 1);
  const origins = cfg.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.enableCors({
    origin: (o: string | undefined, cb: (e: Error | null, allow?: boolean) => void) => cb(null, !o || origins.includes(o)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Upload-Token', 'X-Request-Token', 'X-Client-Kind', 'X-Request-Id'],
    exposedHeaders: ['Retry-After', 'X-Request-Id'],
    maxAge: 600,
  });
  // security headers (API returns JSON/images only)
  http.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow'); // private events are never indexed (D14)
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (cfg.isProd) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    next();
  });
  // binary bodies: upload chunks and cover images (everything else is JSON, parsed by Nest with a 100 kb limit)
  const chunkLimit = cfg.MEDIA_CHUNK_BYTES + 1024;
  http.use('/v1/uploads', express.raw({ type: () => true, limit: chunkLimit }));
  http.use('/v1/events/:id/cover', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '3mb' }));
  http.use(express.json({ limit: '100kb', verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
  // request timing
  const metrics = app.get(MetricsService);
  http.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const end = metrics.httpDuration.startTimer();
    res.on('finish', () => end({ method: req.method, route: (req.route?.path ?? 'unmatched').toString().slice(0, 60), status: String(res.statusCode) }));
    next();
  });
  void CONFIG;
}
