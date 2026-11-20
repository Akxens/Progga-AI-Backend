import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { HttpError } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";

// Student features an admin can show or hide from the dashboard. Hidden by
// default until an admin turns them on; the choice is saved in the DB.

export const FeaturesSchema = z.object({
  /** Progga Battle: live 1v1 matches, leagues and trophies */
  battle: z.boolean(),
  /** AI Innovation Lab */
  lab: z.boolean(),
});
export type Features = z.infer<typeof FeaturesSchema>;
export type FeatureId = keyof Features;

export const DEFAULT_FEATURES: Features = { battle: false, lab: false };

const SETTING_KEY = "features";
/** Serverless instances each keep a copy, so re-read now and then to pick up an admin's change. */
const TTL_MS = 15_000;

let cached: { at: number; features: Features } | null = null;

export async function getFeatures(): Promise<Features> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.features;
  let features = DEFAULT_FEATURES;
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY } });
    if (row) {
      const parsed = FeaturesSchema.partial().safeParse(JSON.parse(row.value));
      if (parsed.success) features = { ...DEFAULT_FEATURES, ...parsed.data };
      else logger.warn("Saved feature settings are invalid; keeping features hidden");
    }
  } catch (err) {
    // keep the last known value (or hidden) rather than failing every request
    logger.error({ err: (err as Error).message }, "Couldn't load feature settings");
    if (cached) return cached.features;
  }
  cached = { at: Date.now(), features };
  return features;
}

export async function saveFeatures(features: Features): Promise<Features> {
  await prisma.appSetting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: JSON.stringify(features) },
    update: { value: JSON.stringify(features) },
  });
  cached = { at: Date.now(), features };
  return features;
}

/** Blocks a feature's API while it is hidden, so it can't be used by typing the URL. */
export function requireFeature(id: FeatureId) {
  return async (_req: Request, _res: Response, next: NextFunction) => {
    try {
      if ((await getFeatures())[id]) return next();
      next(new HttpError(404, "This feature isn't available right now.", "feature_hidden"));
    } catch (err) {
      next(err);
    }
  };
}
