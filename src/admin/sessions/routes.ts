import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../../lib/prisma";
import { getCtx } from "../core/context";
import { sendList } from "../core/respond";

export const sessionsRouter = Router();

// GET /api/admin/sessions
sessionsRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    ctx.assert("students.view_sessions");

    const {
      from,
      to,
      activity,
      deviceCategory,
      schoolId,
      limit = "25",
      cursor,
    } = req.query;

    const where: any = {};
    if (activity && typeof activity === "string") where.module = activity;
    if (deviceCategory && typeof deviceCategory === "string") where.deviceCategory = deviceCategory;

    if (from || to) {
      where.startedAt = {};
      if (from) where.startedAt.gte = new Date(String(from));
      if (to) where.startedAt.lte = new Date(String(to));
    }

    // Scope check: if user is scoped to a school
    const effectiveSchoolId = ctx.scope.type === "SCHOOL" && ctx.scope.id ? ctx.scope.id : (typeof schoolId === "string" ? schoolId : null);

    const take = Math.min(Math.max(parseInt(String(limit), 10) || 25, 1), 100);

    const sessions = await prisma.learningSession.findMany({
      where,
      orderBy: { startedAt: "desc" },
      take: take + 1,
      ...(cursor && typeof cursor === "string" ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = sessions.length > take;
    const pageItems = hasMore ? sessions.slice(0, take) : sessions;
    const nextCursor = hasMore ? pageItems[pageItems.length - 1]?.id : null;

    // Fetch student profile info for users
    const userIds = Array.from(new Set(pageItems.map((s) => s.userId)));
    const studentProfiles = await prisma.studentProfile.findMany({
      where: {
        userId: { in: userIds },
        ...(effectiveSchoolId ? { schoolId: effectiveSchoolId } : {}),
      },
      include: {
        user: { select: { name: true, grade: true } },
        school: { select: { id: true, name: true, code: true } },
      },
    });

    const studentMap = new Map(studentProfiles.map((p) => [p.userId, p]));

    // If scoped, filter out sessions for students not in that school
    const filteredItems = effectiveSchoolId
      ? pageItems.filter((s) => studentMap.has(s.userId))
      : pageItems;

    const enriched = filteredItems.map((s) => {
      const student = studentMap.get(s.userId);
      return {
        id: s.id,
        code: s.code,
        userId: s.userId,
        student: student ? {
          name: student.user.name,
          code: student.code,
          grade: student.user.grade,
          school: student.school,
        } : null,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        activeSeconds: s.activeSeconds,
        durationMinutes: Math.round(s.activeSeconds / 60),
        deviceCategory: s.deviceCategory,
        platform: s.platform,
        module: s.module,
        isFinalized: s.isFinalized,
      };
    });

    sendList(res, enriched, { nextCursor, total: enriched.length });
  } catch (err) {
    next(err);
  }
});
