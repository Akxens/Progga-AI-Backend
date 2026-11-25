import { AsyncLocalStorage } from "node:async_hooks";
import pino from "pino";
import { env } from "../config/env";

const reqStore = new AsyncLocalStorage<{ reqId: string }>();

/** Binds a correlation `reqId` for the lifetime of an Express request's async call tree. */
export function runWithReqId<T>(reqId: string, fn: () => T): T {
  return reqStore.run({ reqId }, fn);
}

// Pretty logs only for a developer's terminal. pino-pretty runs as a worker
// transport, which serverless bundles (e.g. Vercel) can't load, so anywhere
// else we log plain JSON.
function prettyTransport() {
  if (env.isProd || process.env.VERCEL || !process.stdout.isTTY) return undefined;
  try {
    require.resolve("pino-pretty");
  } catch {
    return undefined;
  }
  return { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } };
}

export const logger = pino({
  level: env.isProd ? "info" : "debug",
  mixin() {
    const store = reqStore.getStore();
    return store ? { reqId: store.reqId } : {};
  },
  // Never log raw student messages, credentials, secrets, or tokens.
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "req.headers['x-workspace']",
    "password",
    "*.password",
    "*.mfaCode",
    "*.phone",
    "*.email",
    "*.secret",
    "*.token",
  ],
  transport: prettyTransport(),
});
