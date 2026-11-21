import { ServerStatus, ServerType } from '@prisma/client';
import { z } from 'zod';

const tag = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'Tags: lowercase letters, digits and dashes');
export const serviceName = z.string().regex(/^[a-zA-Z0-9@._-]{1,64}$/, 'Invalid systemd service name');

export const createServerSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    type: z.nativeEnum(ServerType),
    operatingSystem: z.string().trim().min(1).max(128),
    description: z.string().trim().max(1000).optional(),
    tags: z.array(tag).max(20).default([]),
  })
  .strict();

export const updateServerSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    operatingSystem: z.string().trim().min(1).max(128).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    tags: z.array(tag).max(20).optional(),
    monitoredServices: z.array(serviceName).max(30).nullable().optional(),
  })
  .strict();

export const listServersSchema = z.object({
  status: z.nativeEnum(ServerStatus).optional(),
  type: z.nativeEnum(ServerType).optional(),
  search: z.string().trim().max(64).optional(),
});

export type CreateServerInput = z.infer<typeof createServerSchema>;
export type UpdateServerInput = z.infer<typeof updateServerSchema>;
export type ListServersQuery = z.infer<typeof listServersSchema>;

export function formatNodeId(serial: number): string {
  return `ims-node-${String(serial).padStart(4, '0')}`;
}
