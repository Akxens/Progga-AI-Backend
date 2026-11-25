import { Router } from "express";
import { env } from "../config/env";
import { unauthorized } from "../lib/errors";
import { tickJobs } from "./runner";

export const internalJobsRouter = Router();

internalJobsRouter.post("/tick", async (req, res) => {
  const auth = req.headers.authorization;
  if (!env.CRON_SECRET || auth !== `Bearer ${env.CRON_SECRET}`) {
    throw unauthorized("Invalid or missing cron secret");
  }

  const summary = await tickJobs();
  res.json({ ok: true, summary });
});
