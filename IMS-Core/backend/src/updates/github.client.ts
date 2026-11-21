import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { SettingsService } from '../settings/settings.service';

export interface GithubAsset {
  id: number;
  name: string;
  size: number;
  content_type?: string;
}

export interface GithubRelease {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: GithubAsset[];
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Minimal GitHub REST client for (private) release repositories.
 * The token is read from encrypted settings per request and never logged.
 * Asset downloads follow GitHub's redirect to its storage host; fetch drops
 * the Authorization header on cross-origin redirects, so the token is never
 * sent to a third party.
 */
@Injectable()
export class GithubClient {
  constructor(
    private readonly settings: SettingsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async base(): Promise<string> {
    const { apiBase } = await this.settings.get('github');
    const url = new URL(apiBase);
    if (url.protocol !== 'https:') throw new ServiceUnavailableException('GitHub API base must use https');
    return apiBase.replace(/\/+$/, '');
  }

  private async headers(accept: string): Promise<Record<string, string>> {
    const token = await this.settings.getSecret('github.token');
    return {
      Accept: accept,
      'User-Agent': `ims-core/${this.config.version}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async latestRelease(repo: string): Promise<GithubRelease | null> {
    if (!REPO_RE.test(repo)) throw new ServiceUnavailableException('Invalid repository name');
    const res = await fetch(`${await this.base()}/repos/${repo}/releases/latest`, {
      headers: await this.headers('application/vnd.github+json'),
      signal: AbortSignal.timeout(20_000),
      redirect: 'follow',
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new ServiceUnavailableException(`GitHub responded ${res.status}${res.status === 401 || res.status === 403 ? ' (check the access token)' : ''}`);
    return (await res.json()) as GithubRelease;
  }

  /** Small text assets (checksums, signatures). */
  async assetText(repo: string, asset: GithubAsset, maxBytes = 4096): Promise<string> {
    if (asset.size > maxBytes) throw new ServiceUnavailableException(`Asset ${asset.name} is unexpectedly large`);
    const res = await fetch(`${await this.base()}/repos/${repo}/releases/assets/${asset.id}`, {
      headers: await this.headers('application/octet-stream'),
      signal: AbortSignal.timeout(30_000),
      redirect: 'follow',
    });
    if (!res.ok) throw new ServiceUnavailableException(`Downloading ${asset.name} failed (${res.status})`);
    const text = await res.text();
    return text.slice(0, maxBytes);
  }

  /** Streams an asset to disk with a hard size limit; returns its SHA-256. */
  async downloadAsset(repo: string, asset: GithubAsset, dest: string, maxBytes: number): Promise<{ sha256: string; bytes: number }> {
    if (asset.size > maxBytes) throw new ServiceUnavailableException(`Asset ${asset.name} exceeds the size limit`);
    const res = await fetch(`${await this.base()}/repos/${repo}/releases/assets/${asset.id}`, {
      headers: await this.headers('application/octet-stream'),
      signal: AbortSignal.timeout(10 * 60_000),
      redirect: 'follow',
    });
    if (!res.ok || !res.body) throw new ServiceUnavailableException(`Downloading ${asset.name} failed (${res.status})`);
    const hash = createHash('sha256');
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > maxBytes) return cb(new Error('Download exceeds the size limit'));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), meter, createWriteStream(dest, { mode: 0o640 }));
    } catch (err) {
      await rm(dest, { force: true });
      throw err;
    }
    return { sha256: hash.digest('hex'), bytes };
  }
}
