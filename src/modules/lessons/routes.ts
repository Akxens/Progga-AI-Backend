import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, conflict, notFound, parseId } from "../../lib/errors";
import { authed, requireAuth, requireRole } from "../../middleware/auth";
import { XP } from "../gamification/catalog";
import { award } from "../gamification/service";
import { loadCourseTree } from "../courses/tree";
import { lessonCard } from "./presenter";
import { COMPLETE_RATIO, maybeComplete, progressRatio, topicStatus } from "./progress";

export const lessonsRouter = Router();
lessonsRouter.use(requireAuth);

interface Checkpoint {
  atSec: number;
  question: string;
  options: string[];
  answerIndex: number;
  explanation: string;
}

/** For a course topic: the whole course outline (sidebar) and the topics before and after it. */
async function courseContext(courseId: string, chapterId: string, lessonId: string, userId: string) {
  const tree = await loadCourseTree(courseId, userId);
  if (!tree) return null;
  const { course } = tree;
  const flat = tree.chapters.flatMap((c) => c.lessons);
  const at = flat.findIndex((l) => l.id === lessonId);
  return {
    course: {
      id: course.id,
      title: course.title,
      titleBn: course.titleBn,
      grade: course.grade,
      subject: { id: course.subject.id, name: course.subject.name, nameBn: course.subject.nameBn, icon: course.subject.icon, color: course.subject.color },
    },
    chapterId,
    outline: tree.chapters.map((c) => ({
      id: c.id,
      number: c.number,
      title: c.title,
      titleBn: c.titleBn,
      topics: c.lessons.map((l) => ({ id: l.id, title: l.title, ...topicStatus(l, l.progress) })),
    })),
    prev: at > 0 ? { id: flat[at - 1].id, title: flat[at - 1].title } : null,
    next: at >= 0 && at < flat.length - 1 ? { id: flat[at + 1].id, title: flat[at + 1].title } : null,
  };
}

const ListQuery = z.object({
  subject: z.string().optional(),
  grade: z.coerce.number().int().min(3).max(12).optional(),
  q: z.string().trim().max(60).optional(),
});

lessonsRouter.get("/", async (req, res) => {
  const { subject, grade, q } = ListQuery.parse(req.query);
  const userId = authed(req).id;
  const lessons = await prisma.lesson.findMany({
    where: {
      subjectId: subject || undefined,
      grade: grade || undefined,
      OR: q ? [{ title: { contains: q } }, { chapter: { contains: q } }] : undefined,
    },
    include: { subject: true, progress: { where: { userId } } },
    orderBy: [{ grade: "asc" }, { subjectId: "asc" }, { order: "asc" }],
  });
  res.json({
    lessons: lessons.map((l) => ({
      ...lessonCard(l),
      progress: l.progress[0] ? progressRatio(l.progress[0].watchedSec, l.durationSec) : 0,
      completed: l.progress[0]?.completed ?? false,
    })),
  });
});

async function loadLesson(id: string) {
  const lesson = await prisma.lesson.findUnique({ where: { id: parseId(id) }, include: { subject: true } });
  if (!lesson) throw notFound("Lesson not found");
  return lesson;
}

async function progressFor(userId: string, lessonId: string) {
  const p = await prisma.lessonProgress.upsert({
    where: { userId_lessonId: { userId, lessonId } },
    create: { userId, lessonId },
    update: {},
  });
  // Auto-enrol in course if lesson is in a course unit
  try {
    const l = await prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { unit: { select: { courseId: true } } },
    });
    if (l?.unit?.courseId) {
      await prisma.enrolment.upsert({
        where: { studentId_courseId: { studentId: userId, courseId: l.unit.courseId } },
        create: { studentId: userId, courseId: l.unit.courseId, status: "active" },
        update: {},
      });
    }
  } catch {}
  return p;
}

lessonsRouter.get("/:id", async (req, res) => {
  const userId = authed(req).id;
  const lesson = await prisma.lesson.findUnique({ where: { id: parseId(req.params.id) }, include: { subject: true, unit: { select: { courseId: true } } } });
  if (!lesson) throw notFound("Lesson not found");
  const [progress, course, related] = await Promise.all([
    prisma.lessonProgress.findUnique({ where: { userId_lessonId: { userId, lessonId: lesson.id } } }),
    lesson.unit && lesson.chapterId ? courseContext(lesson.unit.courseId, lesson.chapterId, lesson.id, userId) : null,
    lesson.chapterId
      ? []
      : prisma.lesson.findMany({
          where: { subjectId: lesson.subjectId, grade: lesson.grade, chapterId: null, id: { not: lesson.id } },
          include: { subject: true },
          orderBy: { order: "asc" },
          take: 4,
        }),
  ]);
  const checkpoints = lesson.checkpoints as unknown as Checkpoint[];
  const correct = (progress?.checkpointsCorrect as number[] | undefined) ?? [];

  res.json({
    lesson: {
      ...lessonCard(lesson),
      description: lesson.description,
      provider: lesson.provider,
      videoUrl: lesson.videoUrl,
      body: lesson.body,
      readingMin: lesson.readingMin,
      // answers stay on the server
      checkpoints: checkpoints.map((c, i) => ({ index: i, atSec: c.atSec, question: c.question, options: c.options, answered: correct.includes(i) })),
    },
    progress: {
      watchedSec: progress?.watchedSec ?? 0,
      completed: progress?.completed ?? false,
      readDone: progress?.readDone ?? false,
      canComplete: (progress?.watchedSec ?? 0) >= lesson.durationSec * COMPLETE_RATIO,
    },
    course,
    related: related.map(lessonCard),
  });
});

const ProgressBody = z.object({ watchedSec: z.coerce.number().int().min(0) });

lessonsRouter.post("/:id/progress", requireRole("STUDENT"), async (req, res) => {
  const userId = authed(req).id;
  const lesson = await loadLesson(req.params.id as string);
  const { watchedSec } = ProgressBody.parse(req.body);
  const current = await progressFor(userId, lesson.id);
  // progress moves monotonically and advances at most real elapsed watch rate + 30s seek buffer
  const elapsedSec = Math.max(0, Math.floor((Date.now() - current.updatedAt.getTime()) / 1000));
  const maxAllowed = Math.min(lesson.durationSec, current.watchedSec + Math.ceil(elapsedSec * 2.25) + 30);
  const next = Math.min(maxAllowed, Math.max(current.watchedSec, watchedSec));
  // Atomic update: only update if next exceeds stored watchedSec, preventing out-of-order writes
  await prisma.lessonProgress.updateMany({
    where: { id: current.id, watchedSec: { lt: next } },
    data: { watchedSec: next },
  });
  const latest = await progressFor(userId, lesson.id);
  // course topics finish on their own; standalone lessons keep their "Complete" button
  const rewards = lesson.chapterId ? await maybeComplete(userId, lesson, latest) : null;
  res.json({ watchedSec: latest.watchedSec, canComplete: latest.watchedSec >= lesson.durationSec * COMPLETE_RATIO, completed: latest.completed || !!rewards, rewards });
});

lessonsRouter.post("/:id/read", requireRole("STUDENT"), async (req, res) => {
  const userId = authed(req).id;
  const lesson = await loadLesson(req.params.id as string);
  const current = await progressFor(userId, lesson.id);
  const updated = current.readDone ? current : await prisma.lessonProgress.update({ where: { id: current.id }, data: { readDone: true } });
  const rewards = await maybeComplete(userId, lesson, updated);
  res.json({ readDone: true, completed: updated.completed || !!rewards, rewards });
});

const CheckpointBody = z.object({ choice: z.coerce.number().int().min(0) });

lessonsRouter.post("/:id/checkpoints/:index", requireRole("STUDENT"), async (req, res) => {
  const userId = authed(req).id;
  const lesson = await loadLesson(req.params.id as string);
  const index = Number(req.params.index);
  const cp = Number.isInteger(index) ? (lesson.checkpoints as unknown as Checkpoint[])[index] : undefined;
  if (!cp) throw notFound("Checkpoint not found");
  const { choice } = CheckpointBody.parse(req.body);
  const correct = choice === cp.answerIndex;

  const progress = await progressFor(userId, lesson.id);
  let rewards = null;
  if (correct) {
    const newlyDone = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "LessonProgress" WHERE id = ${progress.id} FOR UPDATE`;
      const fresh = await tx.lessonProgress.findUniqueOrThrow({ where: { id: progress.id }, select: { checkpointsCorrect: true } });
      const done = (fresh.checkpointsCorrect as number[]) ?? [];
      if (done.includes(index)) return false;
      await tx.lessonProgress.update({
        where: { id: progress.id },
        data: { checkpointsCorrect: [...done, index] as unknown as Prisma.InputJsonValue },
      });
      return true;
    });
    if (newlyDone) {
      rewards = await award(userId, [{ amount: XP.checkpoint, reason: "checkpoint", refId: `${lesson.id}:${index}` }]);
    }
  }
  // On a wrong answer we only send the explanation, so the student can rewatch and retry.
  res.json({ correct, explanation: cp.explanation, answerIndex: correct ? cp.answerIndex : null, rewards });
});

lessonsRouter.post("/:id/complete", requireRole("STUDENT"), async (req, res) => {
  const userId = authed(req).id;
  const lesson = await loadLesson(req.params.id as string);
  const progress = await progressFor(userId, lesson.id);
  if (progress.completed) throw conflict("Lesson already completed");
  if (progress.watchedSec < lesson.durationSec * COMPLETE_RATIO) throw badRequest("Watch a bit more of the video first! 🎬");
  if (lesson.body && !progress.readDone) throw badRequest("Read the notes too, then you're done! 📄");
  const { count } = await prisma.lessonProgress.updateMany({ where: { id: progress.id, completed: false }, data: { completed: true } });
  if (count === 0) throw conflict("Lesson already completed");
  const rewards = await award(userId, [{ amount: lesson.xpReward, reason: "lesson_complete", refId: lesson.id }]);
  res.json({ completed: true, rewards });
});
