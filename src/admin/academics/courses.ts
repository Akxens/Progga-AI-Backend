import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { getCtx } from "../core/context";
import { requirePermission } from "../core/permissions";
import { sendList, sendOne } from "../core/respond";
import { emitAudit } from "../core/audit";

export const academicsCoursesRouter = Router();

// GET /api/admin/academics/courses
academicsCoursesRouter.get(
  "/courses",
  requirePermission("courses.view"),
  async (req, res, next) => {
    try {
      const {
        grade,
        subjectId,
        status,
        search,
        page = "1",
        pageSize = "20",
      } = req.query as Record<string, string>;

      const where: any = {};
      if (grade) where.grade = Number(grade);
      if (subjectId) where.subjectId = subjectId;
      if (status) where.status = status;
      if (search) {
        where.OR = [
          { title: { contains: search, mode: "insensitive" } },
          { code: { contains: search, mode: "insensitive" } },
        ];
      }

      const p = Math.max(1, Number(page));
      const ps = Math.max(1, Math.min(100, Number(pageSize)));

      const [total, courses] = await Promise.all([
        prisma.course.count({ where }),
        prisma.course.findMany({
          where,
          include: {
            subject: true,
            chapters: {
              include: {
                lessons: {
                  select: { id: true, durationSec: true, status: true },
                },
              },
            },
          },
          orderBy: [{ grade: "asc" }, { order: "asc" }],
          skip: (p - 1) * ps,
          take: ps,
        }),
      ]);

      const mapped = courses.map((c) => {
        const allLessons = c.chapters.flatMap((ch) => ch.lessons);
        return {
          id: c.id,
          code: c.code || `CRS-${c.id}`,
          title: c.title,
          titleBn: c.titleBn,
          grade: c.grade,
          subjectId: c.subjectId,
          subjectName: c.subject?.name || c.subjectId,
          book: c.book,
          chaptersCount: c.chapters.length,
          lessonsCount: allLessons.length,
          totalDurationMinutes: Math.round(
            allLessons.reduce((sum, l) => sum + (l.durationSec || 0), 0) / 60
          ),
          status: c.status || "draft",
          version: c.version || 1,
          updatedAt: c.updatedAt,
        };
      });

      return sendList(res, mapped, total);
    } catch (err) {
      return next(err);
    }
  }
);

const CreateCourseSchema = z.object({
  code: z.string().trim().optional(),
  title: z.string().trim().min(2).max(120),
  titleBn: z.string().trim().default(""),
  grade: z.coerce.number().int().min(1).max(12),
  subjectId: z.string().trim().min(1),
  book: z.string().trim().default(""),
  description: z.string().trim().default(""),
});

// POST /api/admin/academics/courses
academicsCoursesRouter.post(
  "/courses",
  requirePermission("courses.edit"),
  async (req, res, next) => {
    try {
      const parse = CreateCourseSchema.safeParse(req.body);
      if (!parse.success) {
        return next(badRequest("Invalid course parameters", parse.error.flatten().fieldErrors));
      }
      const data = parse.data;

      const subject = await prisma.subject.findUnique({ where: { id: data.subjectId } });
      if (!subject) return next(badRequest("Invalid subjectId"));

      const id = `${data.subjectId}-${data.grade}`;
      const code = data.code || `CRS-${new Date().getFullYear()}-${data.subjectId.toUpperCase()}${data.grade}`;

      const existing = await prisma.course.findUnique({ where: { id } });
      if (existing) {
        return next(badRequest(`Course for subject ${data.subjectId} grade ${data.grade} already exists`));
      }

      const course = await prisma.course.create({
        data: {
          id,
          code,
          title: data.title,
          titleBn: data.titleBn,
          grade: data.grade,
          subjectId: data.subjectId,
          book: data.book,
          description: data.description,
          status: "draft",
          version: 1,
        },
      });

      await emitAudit(req, {
        action: "course.create",
        entityType: "Course",
        entityId: course.id,
        after: { code: course.code, title: course.title, grade: course.grade },
      });

      return sendOne(res, course, { statusCode: 201 });
    } catch (err) {
      return next(err);
    }
  }
);

// GET /api/admin/academics/courses/:id
academicsCoursesRouter.get(
  "/courses/:id",
  requirePermission("courses.view"),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const course = await prisma.course.findUnique({
        where: { id },
        include: {
          subject: true,
          chapters: {
            orderBy: { number: "asc" },
            include: {
              lessons: {
                orderBy: { order: "asc" },
                include: { materials: true },
              },
            },
          },
        },
      });
      if (!course) return next(notFound("Course not found"));

      return sendOne(res, course);
    } catch (err) {
      return next(err);
    }
  }
);

// POST /api/admin/academics/courses/:id/chapters
academicsCoursesRouter.post(
  "/courses/:id/chapters",
  requirePermission("courses.edit"),
  async (req, res, next) => {
    try {
      const courseId = req.params.id as string;
      const course = await prisma.course.findUnique({ where: { id: courseId } });
      if (!course) return next(notFound("Course not found"));

      const { number, title, titleBn, summary } = req.body as {
        number: number;
        title: string;
        titleBn?: string;
        summary?: string;
      };

      if (!title || !number) return next(badRequest("Chapter title and number are required"));

      const chapterId = `${courseId}-ch${number}`;
      const chapter = await prisma.chapter.create({
        data: {
          id: chapterId,
          courseId,
          number: Number(number),
          title: title.trim(),
          titleBn: titleBn?.trim() || "",
          summary: summary?.trim() || "",
          status: "draft",
        },
      });

      return sendOne(res, chapter, { statusCode: 201 });
    } catch (err) {
      return next(err);
    }
  }
);

// POST /api/admin/academics/chapters/:id/lessons
academicsCoursesRouter.post(
  "/chapters/:id/lessons",
  requirePermission("courses.edit"),
  async (req, res, next) => {
    try {
      const chapterId = req.params.id as string;
      const chapter = await prisma.chapter.findUnique({
        where: { id: chapterId },
        include: { course: true },
      });
      if (!chapter) return next(notFound("Chapter not found"));

      const {
        title,
        description = "",
        videoUrl = "",
        provider = "youtube",
        durationSec = 600,
        body = "",
        readingMin = 5,
        order = 0,
      } = req.body as any;

      if (!title) return next(badRequest("Lesson title is required"));

      const code = `LSN-${Date.now().toString().slice(-6)}`;
      const lesson = await prisma.lesson.create({
        data: {
          code,
          chapterId,
          subjectId: chapter.course.subjectId,
          grade: chapter.course.grade,
          chapter: chapter.title,
          title: title.trim(),
          description: description.trim(),
          provider,
          videoUrl,
          durationSec: Number(durationSec),
          body,
          readingMin: Number(readingMin),
          order: Number(order),
          checkpoints: [],
          status: "draft",
        },
      });

      return sendOne(res, lesson, { statusCode: 201 });
    } catch (err) {
      return next(err);
    }
  }
);

// POST /api/admin/academics/courses/:id/publish
academicsCoursesRouter.post(
  "/courses/:id/publish",
  requirePermission("courses.publish"),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const course = await prisma.course.findUnique({
        where: { id },
        include: {
          chapters: { include: { lessons: true } },
        },
      });
      if (!course) return next(notFound("Course not found"));

      // Update course and all its chapters & lessons to published
      await prisma.$transaction([
        prisma.course.update({
          where: { id },
          data: { status: "published", version: { increment: 1 } },
        }),
        prisma.chapter.updateMany({
          where: { courseId: id },
          data: { status: "published" },
        }),
        prisma.lesson.updateMany({
          where: { unit: { courseId: id } },
          data: { status: "published" },
        }),
      ]);

      await emitAudit(req, {
        action: "course.publish",
        entityType: "Course",
        entityId: course.id,
        after: { status: "published" },
      });

      return sendOne(res, { success: true, status: "published" });
    } catch (err) {
      return next(err);
    }
  }
);

// POST /api/admin/academics/courses/:id/archive
academicsCoursesRouter.post(
  "/courses/:id/archive",
  requirePermission("courses.archive"),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const updated = await prisma.course.update({
        where: { id },
        data: { status: "archived" },
      });

      await emitAudit(req, {
        action: "course.archive",
        entityType: "Course",
        entityId: id,
        after: { status: "archived" },
      });

      return sendOne(res, updated);
    } catch (err) {
      return next(err);
    }
  }
);
