import { z } from 'zod';

const serviceName = z.string().regex(/^[a-zA-Z0-9@._-]{1,64}$/, 'Invalid systemd service name');

/**
 * Registry of all non-secret setting sections with validation and defaults.
 * Adding a section here automatically makes it available through SettingsService.
 */
export const SETTING_SECTIONS = {
  general: {
    schema: z
      .object({
        instanceName: z.string().trim().min(1).max(64),
        publicUrl: z.string().url().max(255).nullable(),
        timezone: z.string().min(1).max(64),
      })
      .strict(),
    defaults: { instanceName: 'ITWOD Monitoring System', publicUrl: null, timezone: 'UTC' },
  },
  security: {
    schema: z
      .object({
        sessionIdleHours: z.number().int().min(1).max(168),
        sessionAbsoluteDays: z.number().int().min(1).max(90),
        registrationTokenTtlHours: z.number().int().min(1).max(168),
        maxFailedLogins: z.number().int().min(3).max(20),
        lockoutMinutes: z.number().int().min(1).max(1440),
      })
      .strict(),
    defaults: { sessionIdleHours: 12, sessionAbsoluteDays: 7, registrationTokenTtlHours: 24, maxFailedLogins: 5, lockoutMinutes: 15 },
  },
  monitoring: {
    schema: z
      .object({
        offlineAfterSec: z.number().int().min(60).max(3600),
        metricsRetentionDays: z.number().int().min(1).max(365),
        cpuPercent: z.number().min(10).max(100),
        cpuSustainMinutes: z.number().int().min(1).max(60),
        memoryPercent: z.number().min(10).max(100),
        diskPercent: z.number().min(10).max(100),
        backupMissedGraceMinutes: z.number().int().min(10).max(1440),
        defaultServices: z.array(serviceName).max(30),
      })
      .strict(),
    defaults: {
      offlineAfterSec: 180,
      metricsRetentionDays: 30,
      cpuPercent: 90,
      cpuSustainMinutes: 5,
      memoryPercent: 90,
      diskPercent: 90,
      backupMissedGraceMinutes: 120,
      defaultServices: [] as string[],
    },
  },
  telegram: {
    schema: z
      .object({
        enabled: z.boolean(),
        notifyAlerts: z.boolean(),
        notifyBackupSuccess: z.boolean(),
        notifyBackupFailure: z.boolean(),
        notifyNodeStatus: z.boolean(),
        /** Additional notify-only chats (e.g. a team group). Commands from them are ignored unless linked. */
        broadcastChatIds: z.array(z.string().regex(/^-?\d{1,20}$/)).max(10),
      })
      .strict(),
    defaults: {
      enabled: false,
      notifyAlerts: true,
      notifyBackupSuccess: false,
      notifyBackupFailure: true,
      notifyNodeStatus: true,
      broadcastChatIds: [] as string[],
    },
  },
  github: {
    schema: z
      .object({
        apiBase: z.string().url(),
        coreRepo: z
          .string()
          .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
          .nullable(),
        agentRepo: z
          .string()
          .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
          .nullable(),
      })
      .strict(),
    defaults: { apiBase: 'https://api.github.com', coreRepo: null, agentRepo: null },
  },
} as const;

export type SettingSection = keyof typeof SETTING_SECTIONS;
export type SettingValue<S extends SettingSection> = z.infer<(typeof SETTING_SECTIONS)[S]['schema']>;

/** Names of secret settings (stored encrypted, never returned by the API). */
export const SECRET_SETTINGS = ['telegram.botToken', 'github.token'] as const;
export type SecretSettingName = (typeof SECRET_SETTINGS)[number];

/** Internal (non user editable) keys. */
export const INTERNAL_KEYS = {
  initialized: 'system.initialized',
  telegramOffset: 'telegram.updateOffset',
  latestCoreRelease: 'updates.latestCoreRelease',
} as const;
