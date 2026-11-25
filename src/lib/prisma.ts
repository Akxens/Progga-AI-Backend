import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { __proggaPrisma?: PrismaClient };

export const prisma = globalForPrisma.__proggaPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__proggaPrisma = prisma;
}
