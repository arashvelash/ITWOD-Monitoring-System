import { randomUUID } from 'node:crypto';

/**
 * Minimal in-memory stand-in for the Prisma delegates used by AuthService.
 * Implements only the query shapes AuthService actually issues.
 */
type Row = Record<string, any>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date) && 'not' in v) return row[k] !== v.not;
    return row[k] === v;
  });
}

export function createFakeAuthPrisma() {
  const users: Row[] = [];
  const sessions: Row[] = [];
  const refreshTokens: Row[] = [];

  const withSession = (s: Row, include?: Row) => (include?.user ? { ...s, user: users.find((u) => u.id === s.userId) } : { ...s });

  const prisma = {
    users,
    sessions,
    refreshTokens,
    user: {
      findUnique: async ({ where }: { where: Row }) => users.find((u) => matches(u, where)) ?? null,
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const u = users.find((x) => matches(x, where));
        if (!u) throw new Error('not found');
        Object.assign(u, data, { updatedAt: new Date() });
        return { ...u };
      },
    },
    session: {
      create: async ({ data }: { data: Row }) => {
        const s = { id: randomUUID(), createdAt: new Date(), lastUsedAt: new Date(), revokedAt: null, revokedReason: null, ...data };
        sessions.push(s);
        return { ...s };
      },
      findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
        const s = sessions.find((x) => matches(x, where));
        return s ? withSession(s, include) : null;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const s = sessions.find((x) => matches(x, where));
        if (!s) throw new Error('not found');
        Object.assign(s, data);
        return { ...s };
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const list = sessions.filter((x) => matches(x, where));
        list.forEach((s) => Object.assign(s, data));
        return { count: list.length };
      },
      findMany: async ({ where }: { where: Row }) => sessions.filter((s) => s.userId === where.userId && s.revokedAt === null),
    },
    refreshToken: {
      create: async ({ data }: { data: Row }) => {
        const t = { id: randomUUID(), createdAt: new Date(), usedAt: null, ...data };
        refreshTokens.push(t);
        return { ...t };
      },
      findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
        const t = refreshTokens.find((x) => matches(x, where));
        if (!t) return null;
        if (!include?.session) return { ...t };
        const s = sessions.find((x) => x.id === t.sessionId)!;
        return { ...t, session: withSession(s, include.session.include) };
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const list = refreshTokens.filter((x) => matches(x, where));
        list.forEach((t) => Object.assign(t, data));
        return { count: list.length };
      },
    },
  };
  return prisma;
}

export type FakeAuthPrisma = ReturnType<typeof createFakeAuthPrisma>;
