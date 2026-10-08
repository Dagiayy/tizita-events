# MinIO least privilege

The bucket bootstrap (`minio-init` in `docker-compose.yml`) creates three private buckets. For production create **dedicated service accounts** instead of using the root credentials:

```bash
mc admin policy create local event-api-worker infra/minio/policies/api-worker.json
mc admin user add local event_api   '<secret-from-vault>'   && mc admin policy attach local event-api-worker --user event_api
mc admin user add local event_worker '<secret-from-vault>'  && mc admin policy attach local event-api-worker --user event_worker
# backup mirror account: read-only on event-media (policy: s3:GetObject + ListBucket) used only by infra/scripts/backup.sh
```

Then set `S3_ACCESS_KEY` / `S3_SECRET_KEY` per service (API vs worker) from the secret store; the root credential is only used by operators. Enable server-side encryption (KES) and replication to the second Ethiopian site; keep versioning on `event-media`.
