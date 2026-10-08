// Test environment: real PostgreSQL + Redis + MinIO from infra/docker-compose.yml, isolated by database name / redis db / bucket names.
process.env.NODE_ENV = 'test';
process.env.APP_ROLE = 'api';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://event:event_dev_password@localhost:5433/event_test';
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380/1';
process.env.S3_BUCKET_QUARANTINE = 'test-quarantine';
process.env.S3_BUCKET_MEDIA = 'test-media';
process.env.S3_BUCKET_EXPORTS = 'test-exports';
process.env.SMS_PROVIDERS = 'memory';
process.env.AV_MODE = 'eicar';
process.env.PAYMENT_PROVIDER = 'sandbox';
process.env.MEDIA_CHUNK_BYTES = '65536';          // small chunks so tests exercise multi-chunk uploads
process.env.RATE_LIMIT_OTP_PER_PHONE = '50';
process.env.RATE_LIMIT_OTP_PER_IP = '1000';
process.env.RATE_LIMIT_JOIN_PER_IP = '1000';
process.env.RATE_LIMIT_UPLOAD_INTENT_PER_SESSION = '500';
process.env.PUBLIC_API_URL = 'http://localhost:4000';
process.env.PUBLIC_WEB_URL = 'http://localhost:3000';
