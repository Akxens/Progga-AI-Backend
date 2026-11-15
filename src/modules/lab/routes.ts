import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { authed, requireAuth, requireRole } from "../../middleware/auth";
import { notFound } from "../../lib/errors";
import { jsonOrStream } from "../../lib/sse";
import { prisma } from "../../lib/prisma";
import { tutorFor } from "../ai/engines";
import * as tutor from "../tutor/service";
import { LAB_PROJECTS, labProject, publicProject } from "./projects";

export const labRouter = Router();
labRouter.use(requireAuth, requireRole("STUDENT"));

const aiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  keyGenerator: (req) => req.user?.id ?? "anon",
  message: { error: { code: "slow_down", message: "Whoa, speedy! Take a breath and think it through. 🍌" } },
});

/** Sample projects, plus the student's own Lab projects so far. */
labRouter.get("/", async (req, res) => {
  const userId = authed(req).id;
  const mine = await prisma.tutorSession.findMany({
    where: { studentId: userId, kind: "project" },
    orderBy: { updatedAt: "desc" },
    take: 12,
    select: { id: true, title: true, subject: true, status: true, currentStep: true, xpEarned: true, updatedAt: true, plan: true },
  });
  res.json({
    projects: LAB_PROJECTS.map(publicProject),
    mine: mine.map(({ plan, ...s }) => ({ ...s, totalSteps: (plan as { steps?: unknown[] }).steps?.length ?? 0 })),
  });
});

const StartBody = z.union([
  z.object({ projectId: z.string().min(1).max(60), engine: z.string().max(160).optional() }),
  z.object({
    idea: z.string().trim().min(4).max(300), // what to build
    skill: z.string().trim().min(2).max(80), // what to learn
    subject: z.string().min(1).max(40).default("ict"),
    engine: z.string().max(160).optional(),
  }),
]);

/** Starts a project: Progga plans the milestones and the student builds it in the chat. */
labRouter.post("/start", aiLimiter, async (req, res) => {
  const body = StartBody.parse(req.body);
  const userId = authed(req).id;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { language: true } });
  const lang = user.language === "bn" ? "bn" : "en";
  const llm = await tutorFor(body.engine);

  if ("projectId" in body) {
    const p = labProject(body.projectId);
    if (!p) throw notFound("That project isn't in the Lab");
    await jsonOrStream(
      req,
      res,
      (onPreview) =>
        tutor.startSession(userId, { question: "", subject: p.subject, project: { title: p.title[lang], skill: p.skill.en, brief: p.brief } }, onPreview, llm),
      (r) => (r.blocked ? 200 : 201),
    );
    return;
  }

  // the student's own idea: their words are screened like any question
  const question = lang === "bn" ? `আমি বানাতে চাই: ${body.idea}\nআমি শিখতে চাই: ${body.skill}` : `I want to build: ${body.idea}\nI want to learn: ${body.skill}`;
  await jsonOrStream(
    req,
    res,
    (onPreview) =>
      tutor.startSession(userId, { question, subject: body.subject, project: { title: body.idea.slice(0, 80), skill: body.skill, brief: body.idea, custom: true } }, onPreview, llm),
    (r) => (r.blocked ? 200 : 201),
  );
});
