import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { getCtx } from "../core/context";
import { sendCreated, sendList, sendOne } from "../core/respond";
import { NotFoundError, ValidationError, ConflictError } from "../core/errors";
import { nextCode } from "../core/codes";
import { emitAudit } from "../core/audit";
import { buildCertificatePdf } from "./pdf";

export const trainingRouter = Router();

const CreateProgrammeSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(""),
  provider: z.string().default("Progga"),
  totalSessions: z.number().int().min(1),
  minAttendancePct: z.number().int().min(0).max(100).default(80),
  passMark: z.number().int().min(0).max(100).nullable().optional(),
  certificateTitle: z.string().default(""),
});

const CreateCohortSchema = z.object({
  name: z.string().min(1),
  trainerName: z.string().min(1),
  trainerUserId: z.string().nullable().optional(),
  startDate: z.string(), // YYYY-MM-DD
  endDate: z.string(),   // YYYY-MM-DD
  location: z.string().default(""),
  mode: z.enum(["in_person", "online", "hybrid"]).default("in_person"),
  capacity: z.number().int().min(1),
});

// GET /programmes
trainingRouter.get("/programmes", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    ctx.assert("training.view");

    const { q, status } = req.query;
    const where: any = {};
    if (status && typeof status === "string") where.status = status;
    if (q && typeof q === "string") {
      where.OR = [
        { title: { contains: q, mode: "insensitive" } },
        { code: { contains: q, mode: "insensitive" } },
      ];
    }

    const programmes = await prisma.trainingProgramme.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: { cohorts: true },
        },
      },
    });

    sendList(res, programmes);
  } catch (err) {
    next(err);
  }
});

// POST /programmes
trainingRouter.post("/programmes", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    ctx.assert("training.manage");

    const parsed = CreateProgrammeSchema.parse(req.body);
    const code = await nextCode("TRP");

    const programme = await prisma.trainingProgramme.create({
      data: {
        code,
        title: parsed.title,
        description: parsed.description,
        provider: parsed.provider,
        totalSessions: parsed.totalSessions,
        minAttendancePct: parsed.minAttendancePct,
        passMark: parsed.passMark ?? null,
        certificateTitle: parsed.certificateTitle || parsed.title,
        status: "active",
        createdById: ctx.user.id,
      },
    });

    await emitAudit(req, {
      action: "training.programme.create",
      entityType: "training_programme",
      entityId: programme.id,
      after: programme,
    });

    sendCreated(res, programme);
  } catch (err) {
    next(err);
  }
});

// GET /programmes/:id
trainingRouter.get("/programmes/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    ctx.assert("training.view");

    const id = req.params.id as string;
    const programme = await prisma.trainingProgramme.findUnique({
      where: { id },
      include: {
        cohorts: {
          include: {
            _count: { select: { enrolments: true } },
          },
          orderBy: { startDate: "asc" },
        },
      },
    });

    if (!programme) throw new NotFoundError("TrainingProgramme", id);
    sendOne(res, programme);
  } catch (err) {
    next(err);
  }
});

// PATCH /programmes/:id
trainingRouter.patch("/programmes/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    ctx.assert("training.manage");

    const id = req.params.id as string;
    const existing = await prisma.trainingProgramme.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("TrainingProgramme", id);

    const updated = await prisma.trainingProgramme.update({
      where: { id },
      data: {
        title: req.body.title,
        description: req.body.description,
        totalSessions: req.body.totalSessions,
        minAttendancePct: req.body.minAttendancePct,
        passMark: req.body.passMark,
        status: req.body.status,
        version: { increment: 1 },
      },
    });

    await emitAudit(req, {
      action: "training.programme.update",
      entityType: "training_programme",
      entityId: id,
      before: existing,
      after: updated,
    });

    sendOne(res, updated);
  } catch (err) {
    next(err);
  }
});

// POST /programmes/:id/cohorts
trainingRouter.post("/programmes/:id/cohorts", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    ctx.assert("training.manage");

    const id = req.params.id as string;
    const programme = await prisma.trainingProgramme.findUnique({ where: { id } });
    if (!programme) throw new NotFoundError("TrainingProgramme", id);

    const parsed = CreateCohortSchema.parse(req.body);

    const cohort = await prisma.trainingCohort.create({
      data: {
        programmeId: id,
        name: parsed.name,
        trainerName: parsed.trainerName,
        trainerUserId: parsed.trainerUserId || null,
        startDate: new Date(parsed.startDate),
        endDate: new Date(parsed.endDate),
        location: parsed.location,
        mode: parsed.mode,
        capacity: parsed.capacity,
        status: "scheduled",
      },
    });

    await emitAudit(req, {
      action: "training.cohort.create",
      entityType: "training_cohort",
      entityId: cohort.id,
      after: cohort,
    });

    sendCreated(res, cohort);
  } catch (err) {
    next(err);
  }
});

// PATCH /cohorts/:id
trainingRouter.patch("/cohorts/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    ctx.assert("training.manage");

    const id = req.params.id as string;
    const existing = await prisma.trainingCohort.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("TrainingCohort", id);

    const updated = await prisma.trainingCohort.update({
      where: { id },
      data: {
        name: req.body.name,
        trainerName: req.body.trainerName,
        location: req.body.location,
        mode: req.body.mode,
        capacity: req.body.capacity,
        status: req.body.status,
        version: { increment: 1 },
      },
    });

    sendOne(res, updated);
  } catch (err) {
    next(err);
  }
});

// POST /cohorts/:id/enrolments
trainingRouter.post("/cohorts/:id/enrolments", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    ctx.assert("training.manage");

    const id = req.params.id as string;
    const teacherUserIds = req.body.teacherUserIds as string[];
    if (!Array.isArray(teacherUserIds) || teacherUserIds.length === 0) {
      throw new ValidationError("teacherUserIds array is required");
    }

    const cohort = await prisma.trainingCohort.findUnique({
      where: { id },
      include: { enrolments: true },
    });
    if (!cohort) throw new NotFoundError("TrainingCohort", id);

    const currentCount = cohort.enrolments.length;
    if (currentCount + teacherUserIds.length > cohort.capacity) {
      throw new ConflictError(
        `Cohort capacity exceeded. Current: ${currentCount}, Adding: ${teacherUserIds.length}, Max capacity: ${cohort.capacity}`
      );
    }

    const createdEnrolments = [];
    for (const teacherUserId of teacherUserIds) {
      const enrolment = await prisma.trainingEnrolment.upsert({
        where: { cohortId_teacherUserId: { cohortId: id, teacherUserId } },
        create: {
          cohortId: id,
          teacherUserId,
          status: "enrolled",
        },
        update: {},
      });
      createdEnrolments.push(enrolment);
    }

    await emitAudit(req, {
      action: "training.enrolments.create",
      entityType: "training_cohort",
      entityId: id,
      after: { added: teacherUserIds.length },
    });

    sendCreated(res, createdEnrolments);
  } catch (err) {
    next(err);
  }
});

// PATCH /enrolments/:id
trainingRouter.patch("/enrolments/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    ctx.assert("training.manage");

    const id = req.params.id as string;
    const existing = await prisma.trainingEnrolment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("TrainingEnrolment", id);

    const updated = await prisma.trainingEnrolment.update({
      where: { id },
      data: {
        sessionsAttended: req.body.sessionsAttended ?? existing.sessionsAttended,
        assessmentScore: req.body.assessmentScore !== undefined ? req.body.assessmentScore : existing.assessmentScore,
        status: req.body.status ?? existing.status,
      },
    });

    sendOne(res, updated);
  } catch (err) {
    next(err);
  }
});

// POST /cohorts/:id/complete
trainingRouter.post("/cohorts/:id/complete", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    ctx.assert("training.manage");

    const id = req.params.id as string;
    const cohort = await prisma.trainingCohort.findUnique({
      where: { id },
      include: {
        programme: true,
        enrolments: {
          include: {
            teacher: { include: { user: true } },
          },
        },
      },
    });

    if (!cohort) throw new NotFoundError("TrainingCohort", id);

    const { programme, enrolments } = cohort;
    const results = [];

    for (const enr of enrolments) {
      const attendancePct = Math.round((enr.sessionsAttended / programme.totalSessions) * 100);
      const passedAttendance = attendancePct >= programme.minAttendancePct;
      const passedAssessment = programme.passMark === null || (enr.assessmentScore !== null && enr.assessmentScore >= programme.passMark);

      if (passedAttendance && passedAssessment) {
        let certCode = enr.certificateCode;
        if (!certCode) {
          certCode = await nextCode("CRT");
        }

        const completed = await prisma.trainingEnrolment.update({
          where: { id: enr.id },
          data: {
            status: "completed",
            completedAt: new Date(),
            certificateCode: certCode,
            certificateIssuedAt: new Date(),
          },
        });
        results.push(completed);
      } else {
        const failed = await prisma.trainingEnrolment.update({
          where: { id: enr.id },
          data: {
            status: "failed",
          },
        });
        results.push(failed);
      }
    }

    await prisma.trainingCohort.update({
      where: { id },
      data: { status: "completed" },
    });

    await emitAudit(req, {
      action: "training.cohort.complete",
      entityType: "training_cohort",
      entityId: id,
      after: { evaluatedCount: enrolments.length },
    });

    sendOne(res, { cohortId: id, results });
  } catch (err) {
    next(err);
  }
});

// GET /enrolments/:id/certificate
trainingRouter.get("/enrolments/:id/certificate", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    ctx.assert("training.view");

    const id = req.params.id as string;
    const enrolment = await prisma.trainingEnrolment.findUnique({
      where: { id },
      include: {
        cohort: { include: { programme: true } },
        teacher: { include: { user: true } },
      },
    });

    if (!enrolment) throw new NotFoundError("TrainingEnrolment", id);
    if (!enrolment.certificateCode || enrolment.status !== "completed") {
      throw new ValidationError("Certificate has not been issued for this enrolment");
    }

    const teacherName = enrolment.teacher.user.name || "Teacher";
    const programmeTitle = enrolment.cohort.programme.certificateTitle || enrolment.cohort.programme.title;
    const issueDate = (enrolment.certificateIssuedAt || new Date()).toISOString().slice(0, 10);

    const pdfBuffer = buildCertificatePdf({
      certificateCode: enrolment.certificateCode,
      teacherName,
      programmeTitle,
      issueDate,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${enrolment.certificateCode}.pdf"`);
    res.status(200).send(pdfBuffer);
  } catch (err) {
    next(err);
  }
});
