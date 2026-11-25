import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { getCtx } from "../core/context";
import { sendCreated, sendList, sendOne } from "../core/respond";
import { NotFoundError, ValidationError, ConflictError } from "../core/errors";
import { nextCode } from "../core/codes";
import { emitAudit } from "../core/audit";

export const activationRouter = Router();

const CreateEventSchema = z.object({
  schoolId: z.string().nullable().optional(),
  programmeId: z.string().nullable().optional(),
  type: z.enum([
    "campus_leader_session",
    "ai_club_meeting",
    "parent_session",
    "teacher_session",
    "community_event",
  ]),
  title: z.string().min(1),
  eventDate: z.string(), // YYYY-MM-DD
  division: z.string().min(1),
  district: z.string().min(1),
  upazila: z.string().default(""),
  registeredCount: z.number().int().min(0).default(0),
  notes: z.string().default(""),
});

// GET /events
activationRouter.get("/events", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    ctx.assert("activation.view");

    const { type, programmeId, division, district, schoolId, from, to } = req.query;
    const where: any = {};
    if (type && typeof type === "string") where.type = type;
    if (programmeId && typeof programmeId === "string") where.programmeId = programmeId;
    if (division && typeof division === "string") where.division = division;
    if (district && typeof district === "string") where.district = district;
    if (schoolId && typeof schoolId === "string") where.schoolId = schoolId;
    if (from || to) {
      where.eventDate = {};
      if (from) where.eventDate.gte = new Date(String(from));
      if (to) where.eventDate.lte = new Date(String(to));
    }

    const events = await prisma.activationEvent.findMany({
      where,
      orderBy: { eventDate: "desc" },
      include: {
        school: { select: { id: true, name: true, code: true } },
        _count: { select: { attendance: true } },
      },
    });

    sendList(res, events);
  } catch (err) {
    next(err);
  }
});

// POST /events
activationRouter.post("/events", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    ctx.assert("activation.manage");

    const parsed = CreateEventSchema.parse(req.body);
    const code = await nextCode("ACT");

    const event = await prisma.activationEvent.create({
      data: {
        code,
        schoolId: parsed.schoolId || null,
        programmeId: parsed.programmeId || null,
        type: parsed.type,
        title: parsed.title,
        eventDate: new Date(parsed.eventDate),
        division: parsed.division,
        district: parsed.district,
        upazila: parsed.upazila,
        registeredCount: parsed.registeredCount,
        notes: parsed.notes,
        status: "planned",
        createdById: ctx.user.id,
      },
      include: {
        school: { select: { id: true, name: true, code: true } },
      },
    });

    await emitAudit(req, {
      action: "activation.event.create",
      entityType: "activation_event",
      entityId: event.id,
      after: event,
    });

    sendCreated(res, event);
  } catch (err) {
    next(err);
  }
});

// GET /events/:id
activationRouter.get("/events/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    ctx.assert("activation.view");

    const id = req.params.id as string;
    const event = await prisma.activationEvent.findUnique({
      where: { id },
      include: {
        school: true,
        attendance: true,
      },
    });

    if (!event) throw new NotFoundError("ActivationEvent", id);
    sendOne(res, event);
  } catch (err) {
    next(err);
  }
});

// PATCH /events/:id
activationRouter.patch("/events/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    ctx.assert("activation.manage");

    const id = req.params.id as string;
    const existing = await prisma.activationEvent.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("ActivationEvent", id);

    const updated = await prisma.activationEvent.update({
      where: { id },
      data: {
        title: req.body.title,
        notes: req.body.notes,
        status: req.body.status,
        registeredCount: req.body.registeredCount,
        version: { increment: 1 },
      },
    });

    sendOne(res, updated);
  } catch (err) {
    next(err);
  }
});

// POST /events/:id/attendance (deduplication per BR-ACT-01)
activationRouter.post("/events/:id/attendance", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    ctx.assert("activation.manage");

    const id = req.params.id as string;
    const event = await prisma.activationEvent.findUnique({ where: { id } });
    if (!event) throw new NotFoundError("ActivationEvent", id);

    const participants = req.body.participants as Array<{
      userId?: string;
      name?: string;
      phone?: string;
      participantType: "student" | "teacher" | "guardian" | "community";
      verified?: boolean;
    }>;

    if (!Array.isArray(participants) || participants.length === 0) {
      throw new ValidationError("participants array is required");
    }

    const recorded = [];
    for (const p of participants) {
      const normalizedPhone = p.phone ? p.phone.replace(/[\s-]/g, "") : null;
      const keyPart = p.userId || normalizedPhone || `${(p.name || "anon").toLowerCase().trim()}|${event.schoolId || ""}`;
      const participantKey = `${p.participantType}:${keyPart}`;

      const item = await prisma.activationAttendance.upsert({
        where: {
          eventId_participantKey: {
            eventId: id,
            participantKey,
          },
        },
        create: {
          eventId: id,
          participantKey,
          userId: p.userId || null,
          participantType: p.participantType,
          verified: Boolean(p.verified),
        },
        update: {
          verified: p.verified !== undefined ? Boolean(p.verified) : undefined,
        },
      });
      recorded.push(item);
    }

    await emitAudit(req, {
      action: "activation.attendance.record",
      entityType: "activation_event",
      entityId: id,
      after: { totalProcessed: participants.length, recorded: recorded.length },
    });

    sendCreated(res, { count: recorded.length, items: recorded });
  } catch (err) {
    next(err);
  }
});

// GET /clubs
activationRouter.get("/clubs", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    ctx.assert("activation.view");

    const { schoolId, status } = req.query;
    const where: any = {};
    if (schoolId && typeof schoolId === "string") where.schoolId = schoolId;
    if (status && typeof status === "string") where.status = status;

    const clubs = await prisma.aiClub.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        school: { select: { id: true, name: true, code: true } },
      },
    });

    sendList(res, clubs);
  } catch (err) {
    next(err);
  }
});

// POST /clubs
activationRouter.post("/clubs", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    ctx.assert("activation.manage");

    const { schoolId, name, leaderUserId, startedOn } = req.body;
    if (!schoolId || !name) {
      throw new ValidationError("schoolId and name are required");
    }

    const club = await prisma.aiClub.create({
      data: {
        schoolId,
        name,
        leaderUserId: leaderUserId || null,
        startedOn: startedOn ? new Date(startedOn) : new Date(),
        status: "active",
      },
      include: {
        school: true,
      },
    });

    sendCreated(res, club);
  } catch (err) {
    next(err);
  }
});

// GET /leaders
activationRouter.get("/leaders", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    ctx.assert("activation.view");

    const leaders = await prisma.schoolMembership.findMany({
      where: {
        memberType: "CAMPUS_LEADER",
        status: "active",
      },
      include: {
        school: { select: { id: true, name: true, code: true } },
        user: { select: { id: true, name: true, phone: true, email: true } },
      },
      orderBy: { startDate: "desc" },
    });

    sendList(res, leaders);
  } catch (err) {
    next(err);
  }
});

// POST /leaders
activationRouter.post("/leaders", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    ctx.assert("activation.manage");

    const { schoolId, userId, startDate } = req.body;
    if (!schoolId || !userId) {
      throw new ValidationError("schoolId and userId are required");
    }

    const membership = await prisma.schoolMembership.create({
      data: {
        schoolId,
        userId,
        memberType: "CAMPUS_LEADER",
        startDate: startDate ? new Date(startDate) : new Date(),
        status: "active",
      },
      include: {
        school: true,
        user: true,
      },
    });

    await emitAudit(req, {
      action: "activation.leader.assign",
      entityType: "school_membership",
      entityId: membership.id,
      after: { schoolId, userId },
    });

    sendCreated(res, membership);
  } catch (err) {
    next(err);
  }
});
