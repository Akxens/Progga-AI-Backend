import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { getCtx } from "../core/context";
import { requirePermission } from "../core/permissions";
import { sendList, sendOne } from "../core/respond";
import { emitAudit } from "../core/audit";

export const academicsCurriculumRouter = Router();

// GET /api/admin/academics/curriculum
academicsCurriculumRouter.get(
  "/curriculum",
  requirePermission("curriculum.view"),
  async (req, res, next) => {
    try {
      const curriculums = await prisma.curriculum.findMany({
        orderBy: [{ grade: "asc" }, { code: "asc" }],
      });

      const mapped = curriculums.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        grade: c.grade,
        description: c.description,
        status: c.status,
        updatedAt: c.updatedAt,
      }));

      return sendList(res, mapped, mapped.length);
    } catch (err) {
      return next(err);
    }
  }
);

const CreateCurriculumSchema = z.object({
  code: z.string().trim().min(3).max(30).optional(),
  name: z.string().trim().min(2).max(100),
  grade: z.coerce.number().int().min(1).max(12),
  description: z.string().trim().default(""),
  status: z.enum(["active", "draft", "archived"]).default("active"),
});

// POST /api/admin/academics/curriculum
academicsCurriculumRouter.post(
  "/curriculum",
  requirePermission("curriculum.edit"),
  async (req, res, next) => {
    try {
      const parse = CreateCurriculumSchema.safeParse(req.body);
      if (!parse.success) {
        return next(badRequest("Invalid curriculum data", parse.error.flatten().fieldErrors));
      }
      const data = parse.data;
      const code = data.code || `CUR-${new Date().getFullYear()}-G${data.grade}`;

      const existing = await prisma.curriculum.findUnique({ where: { code } });
      if (existing) {
        return next(badRequest(`Curriculum with code ${code} already exists`));
      }

      const curriculum = await prisma.curriculum.create({
        data: {
          code,
          name: data.name,
          grade: data.grade,
          description: data.description,
          status: data.status,
        },
      });

      await emitAudit(req, {
        action: "curriculum.create",
        entityType: "Curriculum",
        entityId: curriculum.id,
        after: { code: curriculum.code, name: curriculum.name, grade: curriculum.grade },
      });

      return sendOne(res, curriculum, { statusCode: 201 });
    } catch (err) {
      return next(err);
    }
  }
);

// GET /api/admin/academics/curriculum/:id
academicsCurriculumRouter.get(
  "/curriculum/:id",
  requirePermission("curriculum.view"),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const curriculum = await prisma.curriculum.findUnique({ where: { id } });
      if (!curriculum) return next(notFound("Curriculum not found"));

      // Include associated subjects for this grade
      const subjects = await prisma.subject.findMany({
        where: { minGrade: { lte: curriculum.grade }, maxGrade: { gte: curriculum.grade } },
        orderBy: { order: "asc" },
      });

      return sendOne(res, {
        ...curriculum,
        subjects,
      });
    } catch (err) {
      return next(err);
    }
  }
);
