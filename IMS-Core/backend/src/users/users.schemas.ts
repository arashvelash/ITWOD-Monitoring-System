import { UserRole } from '@prisma/client';
import { z } from 'zod';
import { passwordSchema, usernameSchema } from '../auth/password-policy';

export const createUserSchema = z
  .object({
    username: usernameSchema,
    password: passwordSchema,
    role: z.nativeEnum(UserRole),
    displayName: z.string().trim().min(1).max(128).optional(),
    email: z.string().trim().toLowerCase().email().max(255).optional(),
    mustChangePassword: z.boolean().optional(),
  })
  .strict();

export const updateUserSchema = z
  .object({
    role: z.nativeEnum(UserRole).optional(),
    displayName: z.string().trim().min(1).max(128).nullable().optional(),
    email: z.string().trim().toLowerCase().email().max(255).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const resetPasswordSchema = z.object({ password: passwordSchema }).strict();

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
