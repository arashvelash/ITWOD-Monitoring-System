import { z } from 'zod';
import { passwordSchema, usernameSchema } from '../auth/password-policy';
import { SETTING_SECTIONS } from '../settings/settings.registry';

export const telegramBotTokenSchema = z.string().trim().regex(/^\d{5,16}:[A-Za-z0-9_-]{30,64}$/, 'Invalid Telegram bot token format');

export const setupSchema = z
  .object({
    setupToken: z.string().trim().min(16).max(128),
    admin: z
      .object({
        username: usernameSchema,
        password: passwordSchema,
        displayName: z.string().trim().min(1).max(128).optional(),
        email: z.string().trim().toLowerCase().email().max(255).optional(),
      })
      .strict(),
    instance: z
      .object({
        name: z.string().trim().min(1).max(64),
        publicUrl: z.string().url().max(255).optional(),
        timezone: z.string().min(1).max(64).default('UTC'),
      })
      .strict(),
    security: SETTING_SECTIONS.security.schema.partial().optional(),
    telegram: z
      .object({
        enabled: z.boolean(),
        botToken: telegramBotTokenSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type SetupInput = z.infer<typeof setupSchema>;
