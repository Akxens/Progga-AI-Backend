import { Router } from "express";
import { requireAuth, requireFreshSession, requireRole } from "../../middleware/auth";
import { FeaturesSchema, getFeatures, saveFeatures } from "./config";

/** Public: which optional features the app should show. */
export const featuresRouter = Router();

featuresRouter.get("/", async (_req, res) => {
  res.json({ features: await getFeatures() });
});

/** Admin-only: show or hide optional features for every student. */
export const featuresAdminRouter = Router();
featuresAdminRouter.use(requireAuth, requireFreshSession, requireRole("ADMIN"));

featuresAdminRouter.get("/", async (_req, res) => {
  res.json({ features: await getFeatures() });
});

featuresAdminRouter.put("/", async (req, res) => {
  const features = FeaturesSchema.parse(req.body);
  res.json({ features: await saveFeatures(features) });
});
