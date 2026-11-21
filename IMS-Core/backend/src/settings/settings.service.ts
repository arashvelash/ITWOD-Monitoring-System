import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SecretBoxService } from '../crypto/secret-box.service';
import { SECRET_SETTINGS, SETTING_SECTIONS, SecretSettingName, SettingSection, SettingValue } from './settings.registry';

const CACHE_TTL_MS = 10_000;

/**
 * Typed access to `system_settings`.
 *
 * - Sections are validated with zod and merged with defaults on read.
 * - Secret settings are AES-256-GCM encrypted with AAD `setting:<name>` and
 *   can only be read server-side; the API only exposes whether they are set.
 */
@Injectable()
export class SettingsService {
  private cache = new Map<string, { value: unknown; expires: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly secretBox: SecretBoxService,
  ) {}

  async get<S extends SettingSection>(section: S): Promise<SettingValue<S>> {
    const cached = this.cache.get(section);
    if (cached && cached.expires > Date.now()) return cached.value as SettingValue<S>;

    const def = SETTING_SECTIONS[section];
    const row = await this.prisma.systemSetting.findUnique({ where: { key: section } });
    const merged = { ...def.defaults, ...((row?.value as object | null) ?? {}) };
    const parsed = def.schema.safeParse(merged);
    const value = (parsed.success ? parsed.data : def.defaults) as SettingValue<S>;
    this.cache.set(section, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  }

  async update<S extends SettingSection>(section: S, patch: Partial<SettingValue<S>>, updatedById?: string): Promise<SettingValue<S>> {
    const current = await this.get(section);
    const def = SETTING_SECTIONS[section];
    const parsed = def.schema.safeParse({ ...current, ...patch });
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Invalid settings',
        errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    await this.prisma.systemSetting.upsert({
      where: { key: section },
      create: { key: section, value: parsed.data as Prisma.InputJsonValue, updatedById },
      update: { value: parsed.data as Prisma.InputJsonValue, updatedById },
    });
    this.cache.delete(section);
    return parsed.data as SettingValue<S>;
  }

  async getSecret(name: SecretSettingName): Promise<string | null> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: name } });
    if (!row?.secretEncrypted) return null;
    return this.secretBox.decrypt(row.secretEncrypted, `setting:${name}`);
  }

  async hasSecret(name: SecretSettingName): Promise<boolean> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: name }, select: { secretEncrypted: true } });
    return Boolean(row?.secretEncrypted);
  }

  async setSecret(name: SecretSettingName, value: string | null, updatedById?: string): Promise<void> {
    if (!SECRET_SETTINGS.includes(name)) throw new BadRequestException('Unknown secret setting');
    const secretEncrypted = value ? this.secretBox.encrypt(value, `setting:${name}`) : null;
    await this.prisma.systemSetting.upsert({
      where: { key: name },
      create: { key: name, secretEncrypted, updatedById },
      update: { secretEncrypted, updatedById },
    });
  }

  /** Raw internal key/value access (not user editable). */
  async getInternal<T>(key: string): Promise<T | null> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key } });
    return (row?.value as T | undefined) ?? null;
  }

  async setInternal(key: string, value: unknown): Promise<void> {
    await this.prisma.systemSetting.upsert({
      where: { key },
      create: { key, value: value as Prisma.InputJsonValue },
      update: { value: value as Prisma.InputJsonValue },
    });
  }

  async getAll() {
    const sections = Object.keys(SETTING_SECTIONS) as SettingSection[];
    const entries = await Promise.all(sections.map(async (s) => [s, await this.get(s)] as const));
    const secrets = await Promise.all(SECRET_SETTINGS.map(async (s) => [s, await this.hasSecret(s)] as const));
    return { ...Object.fromEntries(entries), secretsConfigured: Object.fromEntries(secrets) };
  }
}
