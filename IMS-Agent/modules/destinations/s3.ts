import { DeleteObjectCommand, HeadBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { PassThrough } from 'node:stream';
import { archivePattern } from '../backup/naming';
import type { Destination, DestinationUpload, StoredArchive } from './types';

export interface S3Settings {
  bucket: string;
  region?: string;
  endpoint?: string;
  prefix?: string;
  forcePathStyle?: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * S3-compatible destination (AWS, MinIO, Wasabi, Arvan, ...). Objects are stored
 * under <prefix><slug>/ and uploaded with streaming multipart uploads.
 */
export class S3Destination implements Destination {
  private readonly client: S3Client;
  private readonly keyPrefix: string;

  constructor(
    private readonly settings: S3Settings,
    private readonly slug: string,
  ) {
    if (!settings.accessKeyId || !settings.secretAccessKey) throw new Error('S3 credentials are missing');
    const prefix = (settings.prefix ?? '').replace(/^\/+/, '');
    if (prefix.split('/').includes('..')) throw new Error('Invalid S3 prefix');
    this.keyPrefix = `${prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix}${slug}/`;
    this.client = new S3Client({
      region: settings.region || 'us-east-1',
      endpoint: settings.endpoint,
      forcePathStyle: settings.forcePathStyle ?? false,
      credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
      maxAttempts: 5,
    });
  }

  describe(): string {
    return `s3://${this.settings.bucket}/${this.keyPrefix}`;
  }

  async preflight(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.settings.bucket }));
  }

  async open(name: string): Promise<DestinationUpload> {
    const key = this.key(name);
    const body = new PassThrough();
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.settings.bucket, Key: key, Body: body, ContentType: 'application/octet-stream', ServerSideEncryption: this.settings.endpoint ? undefined : 'AES256' },
      queueSize: 2,
      partSize: 16 * 1024 * 1024,
      leavePartsOnError: false,
    });
    const done = upload.done();
    done.catch(() => undefined);
    return {
      stream: body,
      commit: async () => {
        await done;
        return `s3://${this.settings.bucket}/${key}`;
      },
      abort: async () => {
        body.destroy();
        await upload.abort().catch(() => undefined);
      },
    };
  }

  async list(): Promise<StoredArchive[]> {
    const pattern = archivePattern(this.slug);
    const out: StoredArchive[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(new ListObjectsV2Command({ Bucket: this.settings.bucket, Prefix: this.keyPrefix, ContinuationToken: token }));
      for (const o of res.Contents ?? []) {
        const name = o.Key?.slice(this.keyPrefix.length) ?? '';
        if (!name.includes('/') && pattern.test(name)) out.push({ name, sizeBytes: o.Size });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async remove(name: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.settings.bucket, Key: this.key(name) }));
  }

  private key(name: string): string {
    if (!archivePattern(this.slug).test(name)) throw new Error(`Refusing to touch non-IMS object ${name}`);
    return this.keyPrefix + name;
  }
}
