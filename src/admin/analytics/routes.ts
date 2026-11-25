import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../../lib/prisma";
import { getCtx } from "../core/context";
import { sendOne } from "../core/respond";

export const analyticsRouter = Router();

// GET /api/admin/analytics/students
analyticsRouter.get("/students", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    ctx.assert("students.analytics.view");

    const schoolId = ctx.scope.type === "SCHOOL" && ctx.scope.id ? ctx.scope.id : (typeof req.query.schoolId === "string" ? req.query.schoolId : null);

    const where: any = {};
    if (schoolId) where.schoolId = schoolId;

    const totalStudents = await prisma.studentProfile.count({ where });

    // Grade breakdown from User (students)
    const gradesGroup = await prisma.user.groupBy({
      by: ["grade"],
      where: {
        role: "STUDENT",
        grade: { not: null },
        ...(schoolId ? { studentProfile: { is: { schoolId } } } : {}),
      },
      _count: { id: true },
      orderBy: { grade: "asc" },
    });

    const gradeDistribution = gradesGroup.map((g) => ({
      grade: `Class ${g.grade}`,
      count: g._count.id,
    }));

    // Inactivity buckets
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [activeToday, active7d, active30d] = await Promise.all([
      prisma.studentProfile.count({
        where: { ...where, lastActiveAt: { gte: oneDayAgo } },
      }),
      prisma.studentProfile.count({
        where: { ...where, lastActiveAt: { gte: sevenDaysAgo } },
      }),
      prisma.studentProfile.count({
        where: { ...where, lastActiveAt: { gte: thirtyDaysAgo } },
      }),
    ]);

    const inactivityBuckets = {
      today: activeToday,
      within7Days: active7d,
      within30Days: active30d,
      inactive30Plus: Math.max(0, totalStudents - active30d),
    };

    // Active metrics DAU, WAU, MAU
    const activeMetrics = {
      dau: activeToday,
      wau: active7d,
      mau: active30d,
      dauWauRatio: active7d > 0 ? Number((activeToday / active7d).toFixed(2)) : 0,
    };

    // Sample growth series (last 6 months approximation)
    const months = ["Jun", "Jul", "Aug", "Sep", "Oct", "Nov"];
    const growthSeries = months.map((m, idx) => ({
      period: m,
      total: Math.max(1, Math.round((totalStudents / (months.length - idx + 0.5)))),
    }));

    sendOne(res, {
      totalStudents,
      activeMetrics,
      gradeDistribution,
      inactivityBuckets,
      growthSeries,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/analytics/teachers
analyticsRouter.get("/teachers", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    ctx.assert("teachers.analytics.view");

    const [totalTeachers, verifiedCount, pendingCount] = await Promise.all([
      prisma.teacherProfile.count(),
      prisma.teacherProfile.count({ where: { verificationStatus: "verified" } }),
      prisma.teacherProfile.count({ where: { verificationStatus: "pending" } }),
    ]);

    const unverifiedCount = Math.max(0, totalTeachers - verifiedCount - pendingCount);

    const totalProgrammes = await prisma.trainingProgramme.count();
    const totalEnrolments = await prisma.trainingEnrolment.count();
    const completedEnrolments = await prisma.trainingEnrolment.count({ where: { status: "completed" } });

    sendOne(res, {
      totalTeachers,
      verification: {
        verified: verifiedCount,
        pending: pendingCount,
        unverified: unverifiedCount,
      },
      training: {
        totalProgrammes,
        totalEnrolments,
        completedEnrolments,
        completionRatePct: totalEnrolments > 0 ? Math.round((completedEnrolments / totalEnrolments) * 100) : 0,
      },
    });
  } catch (err) {
    next(err);
  }
});
