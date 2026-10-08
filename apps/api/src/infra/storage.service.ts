import {
  CopyObjectCommand, CreateBucketCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadBucketCommand,
  HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Readable } from 'stream';
import { AppConfig, CONFIG } from '../common/config';

export type Bucket = 'quarantine' | 'media' | 'exports';

/**
 * S3-compatible object storage on Ethiopia-hosted infrastructure (MinIO / vendor store).
 * Clients never receive credentials or bucket paths: every byte is served through the API
 * after authorization, or through HMAC-signed API URLs that map to an opaque media id.
 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly s3: S3Client;
  private readonly names: Record<Bucket, string>;
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {
    this.s3 = new S3Client({
      endpoint: cfg.S3_ENDPOINT,
      region: cfg.S3_REGION,
      forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: cfg.S3_ACCESS_KEY, secretAccessKey: cfg.S3_SECRET_KEY },
      maxAttempts: 3,
    });
    this.names = { quarantine: cfg.S3_BUCKET_QUARANTINE, media: cfg.S3_BUCKET_MEDIA, exports: cfg.S3_BUCKET_EXPORTS };
  }

  bucketName(b: Bucket): string { return this.names[b]; }

  async ensureBuckets(): Promise<void> {
    for (const name of Object.values(this.names)) {
      try { await this.s3.send(new HeadBucketCommand({ Bucket: name })); }
      catch { await this.s3.send(new CreateBucketCommand({ Bucket: name })); }
    }
  }

  async ping(): Promise<boolean> {
    try { await this.s3.send(new HeadBucketCommand({ Bucket: this.names.media })); return true; } catch { return false; }
  }

  async put(bucket: Bucket, key: string, body: Buffer | Readable, contentType = 'application/octet-stream'): Promise<void> {
    await this.s3.send(new PutObjectCommand({
      Bucket: this.names[bucket], Key: key, Body: body, ContentType: contentType,
      ServerSideEncryption: this.cfg.S3_SSE ? 'AES256' : undefined,
      CacheControl: 'private, no-store',
    }));
  }

  /** Streaming multipart upload (exports): body can be an archiver stream of unknown length. */
  async putStream(bucket: Bucket, key: string, body: Readable, contentType: string): Promise<void> {
    const up = new Upload({
      client: this.s3,
      params: { Bucket: this.names[bucket], Key: key, Body: body, ContentType: contentType, ServerSideEncryption: this.cfg.S3_SSE ? 'AES256' : undefined },
      queueSize: 2, partSize: 8 * 1024 * 1024,
    });
    await up.done();
  }

  async getStream(bucket: Bucket, key: string, range?: string): Promise<{ stream: Readable; size?: number; contentRange?: string }> {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.names[bucket], Key: key, Range: range }));
    return { stream: r.Body as Readable, size: r.ContentLength, contentRange: r.ContentRange };
  }

  async getBuffer(bucket: Bucket, key: string): Promise<Buffer> {
    const { stream } = await this.getStream(bucket, key);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(chunks);
  }

  async head(bucket: Bucket, key: string): Promise<{ size: number } | null> {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.names[bucket], Key: key }));
      return { size: r.ContentLength ?? 0 };
    } catch { return null; }
  }

  async copy(from: Bucket, fromKey: string, to: Bucket, toKey: string): Promise<void> {
    await this.s3.send(new CopyObjectCommand({
      Bucket: this.names[to], Key: toKey, CopySource: `${this.names[from]}/${encodeURI(fromKey)}`,
      ServerSideEncryption: this.cfg.S3_SSE ? 'AES256' : undefined,
    }));
  }

  async delete(bucket: Bucket, key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.names[bucket], Key: key }));
  }

  async *list(bucket: Bucket, prefix = ''): AsyncGenerator<{ key: string; size: number; lastModified?: Date }> {
    let token: string | undefined;
    do {
      const r = await this.s3.send(new ListObjectsV2Command({ Bucket: this.names[bucket], Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }));
      for (const o of r.Contents ?? []) yield { key: o.Key!, size: o.Size ?? 0, lastModified: o.LastModified };
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
  }

  /** Deletes every object under a prefix; returns count and bytes removed (used for purge evidence). */
  async deletePrefix(bucket: Bucket, prefix: string): Promise<{ objects: number; bytes: number }> {
    let objects = 0, bytes = 0;
    let batch: { Key: string }[] = [];
    const flush = async () => {
      if (!batch.length) return;
      await this.s3.send(new DeleteObjectsCommand({ Bucket: this.names[bucket], Delete: { Objects: batch, Quiet: true } }));
      batch = [];
    };
    for await (const o of this.list(bucket, prefix)) {
      batch.push({ Key: o.key }); objects++; bytes += o.size;
      if (batch.length >= 500) await flush();
    }
    await flush();
    return { objects, bytes };
  }

  onModuleDestroy(): void { this.s3.destroy(); }
}

export const keys = {
  quarantinePart: (eventId: string, mediaId: string, n: number) => `q/${eventId}/${mediaId}/part-${String(n).padStart(5, '0')}`,
  quarantineAssembled: (eventId: string, mediaId: string) => `q/${eventId}/${mediaId}/assembled`,
  quarantinePrefix: (eventId: string, mediaId: string) => `q/${eventId}/${mediaId}/`,
  eventMediaPrefix: (eventId: string) => `e/${eventId}/`,
  original: (eventId: string, mediaId: string) => `e/${eventId}/m/${mediaId}/original`,
  derivative: (eventId: string, mediaId: string, variant: string) => `e/${eventId}/m/${mediaId}/${variant}.jpg`,
  cover: (eventId: string, rand: string) => `e/${eventId}/cover/${rand}.jpg`,
  export: (eventId: string, exportId: string) => `x/${eventId}/${exportId}.zip`,
};
