import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { AppConfig, CONFIG } from './common/config';
import { StorageService } from './infra/storage.service';
import { runMigrations } from './infra/migrate';

async function main() {
  const app = await NestFactory.create(AppModule, { bodyParser: false, rawBody: false, logger: ['error', 'warn', 'log'] });
  const cfg = app.get<AppConfig>(CONFIG);
  configureApp(app, cfg);
  if (!cfg.isProd) {
    // developer convenience only; production runs `npm run migrate:prod` as a deployment step
    await runMigrations(cfg.DATABASE_URL, undefined, (m) => new Logger('Migrate').log(m));
    await app.get(StorageService).ensureBuckets().catch((e) => new Logger('Storage').warn(`ensureBuckets: ${e.message}`));
  }
  app.enableShutdownHooks();
  if (cfg.APP_ROLE === 'worker') {
    // workers expose only health/metrics so orchestrators can probe them
    await app.listen(cfg.PORT);
    new Logger('Boot').log(`worker role on :${cfg.PORT}`);
    return;
  }
  await app.listen(cfg.PORT);
  new Logger('Boot').log(`API (${cfg.APP_ROLE}) listening on :${cfg.PORT} [${cfg.NODE_ENV}]`);
}
main().catch((e) => { console.error(e); process.exit(1); });
