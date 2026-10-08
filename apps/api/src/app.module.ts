import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AdminController, SupportController } from './admin/admin.controller';
import { AdminService } from './admin/admin.service';
import { MaintenanceService } from './admin/maintenance.service';
import { AnalyticsService } from './analytics/analytics.service';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { CONFIG, loadConfig } from './common/config';
import { CryptoService } from './common/crypto';
import { AllExceptionsFilter } from './common/errors';
import { requestContextMiddleware } from './common/request-context';
import { AccessService } from './events/access.service';
import { EntitlementsService } from './events/entitlements.service';
import { EventsController } from './events/events.controller';
import { EventsService } from './events/events.service';
import { LifecycleService } from './events/lifecycle.service';
import { SharingService } from './events/sharing.service';
import { ExportsController } from './exports/exports.controller';
import { ExportsService } from './exports/exports.service';
import { GalleryService } from './gallery/gallery.service';
import { RealtimeService } from './gallery/realtime.service';
import { GuestController } from './guest/guest.controller';
import { GuestService } from './guest/guest.service';
import { HealthController } from './health.controller';
import { Db } from './infra/db.service';
import { IdempotencyService } from './infra/idempotency.service';
import { MetricsService } from './infra/metrics.service';
import { QueueService } from './infra/queue.service';
import { RedisService } from './infra/redis.service';
import { SettingsService } from './infra/settings.service';
import { StorageService } from './infra/storage.service';
import { ImageService } from './media/image.service';
import { MediaController } from './media/media.controller';
import { MediaServeService } from './media/media-serve.service';
import { ProcessingService } from './media/processing.service';
import { ScanService } from './media/scan.service';
import { SignedUrlService } from './media/signed-url.service';
import { UploadService } from './media/upload.service';
import { ModerationService } from './moderation/moderation.service';
import { NotificationsService } from './notifications/notifications.service';
import { PaymentsController } from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';
import { DeletionService } from './privacy/deletion.service';
import { PrivacyController } from './privacy/privacy.controller';
import { PrivacyService } from './privacy/privacy.service';

/** Cross-cutting infrastructure: config, persistence, cache/queue, object storage, crypto, audit, notifications. */
@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    Db, RedisService, StorageService, QueueService, SettingsService, MetricsService, IdempotencyService, CryptoService, AuditService,
    NotificationsService, AnalyticsService, RealtimeService, SignedUrlService,
  ],
  exports: [CONFIG, Db, RedisService, StorageService, QueueService, SettingsService, MetricsService, IdempotencyService, CryptoService, AuditService, NotificationsService, AnalyticsService, RealtimeService, SignedUrlService],
})
export class CoreModule {}

@Global()
@Module({ controllers: [AuthController], providers: [AuthService], exports: [AuthService] })
export class AuthModule {}

/** Event service boundary: CRUD, lifecycle state machine, access modes/secrets, entitlements, sharing. */
@Global()
@Module({
  controllers: [EventsController],
  providers: [AccessService, EntitlementsService, LifecycleService, EventsService, SharingService],
  exports: [AccessService, EntitlementsService, LifecycleService, EventsService, SharingService],
})
export class EventsModule {}

@Module({ controllers: [GuestController], providers: [GuestService], exports: [GuestService] })
export class GuestModule {}

/** Media + gallery service boundary: upload gateway, async processing pipeline, signed serving, gallery read models. */
@Module({
  controllers: [MediaController],
  providers: [ImageService, ScanService, UploadService, ProcessingService, MediaServeService, GalleryService, ModerationService],
  exports: [ImageService, ScanService, ProcessingService, GalleryService, ModerationService],
})
export class MediaModule {}

@Module({ controllers: [PaymentsController], providers: [PaymentsService], exports: [PaymentsService] })
export class PaymentsModule {}

@Module({ controllers: [ExportsController], providers: [ExportsService], exports: [ExportsService] })
export class ExportsModule {}

@Module({ imports: [GuestModule, MediaModule], controllers: [PrivacyController], providers: [PrivacyService, DeletionService], exports: [PrivacyService, DeletionService] })
export class PrivacyModule {}

@Module({ imports: [MediaModule, PaymentsModule, ExportsModule, PrivacyModule], controllers: [AdminController, SupportController], providers: [AdminService, MaintenanceService] })
export class AdminModule {}

@Module({
  imports: [CoreModule, AuthModule, EventsModule, GuestModule, MediaModule, PaymentsModule, ExportsModule, PrivacyModule, AdminModule],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }, { provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestContextMiddleware).forRoutes('*');
  }
}
