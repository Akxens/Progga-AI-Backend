import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { getCtx } from "../core/context";
import { sendOne } from "../core/respond";

export const lookupsRouter = Router();

export interface LookupItem {
  value: string;
  label: string;
  meta?: Record<string, unknown>;
}

lookupsRouter.get("/:kind", async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const kind = req.params.kind;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 20);

    const items: LookupItem[] = [];

    switch (kind) {
      case "schools": {
        const where: Record<string, unknown> = { status: "active" };
        if (ctx.scope.type === "SCHOOL" && ctx.scope.id) {
          where.id = ctx.scope.id;
        } else if (q) {
          where.OR = [
            { name: { contains: q, mode: "insensitive" } },
            { code: { contains: q, mode: "insensitive" } },
          ];
        }
        const schools = await prisma.school.findMany({
          where,
          take: limit,
          select: { id: true, name: true, code: true, district: true },
          orderBy: { name: "asc" },
        });
        for (const s of schools) {
          items.push({
            value: s.id,
            label: `${s.name} (${s.code})`,
            meta: { code: s.code, district: s.district },
          });
        }
        break;
      }

      case "grades": {
        const grades = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        for (const g of grades) {
          if (!q || String(g).includes(q) || `class ${g}`.toLowerCase().includes(q.toLowerCase())) {
            items.push({ value: String(g), label: `Class ${g}` });
          }
        }
        break;
      }

      case "subjects": {
        const standardSubjects = [
          "Mathematics",
          "English",
          "Bangla",
          "Science",
          "Physics",
          "Chemistry",
          "Biology",
          "Higher Mathematics",
          "ICT",
          "Bangladesh and Global Studies",
        ];
        for (const sub of standardSubjects) {
          if (!q || sub.toLowerCase().includes(q.toLowerCase())) {
            items.push({ value: sub.toLowerCase(), label: sub });
          }
        }
        break;
      }

      case "districts": {
        const districts = await prisma.school.findMany({
          where: { district: { not: "" } },
          select: { district: true },
          distinct: ["district"],
          take: limit,
          orderBy: { district: "asc" },
        });
        for (const d of districts) {
          if (!q || d.district.toLowerCase().includes(q.toLowerCase())) {
            items.push({ value: d.district, label: d.district });
          }
        }
        break;
      }

      case "upazilas": {
        const upazilas = await prisma.school.findMany({
          where: { upazila: { not: "" } },
          select: { upazila: true, district: true },
          distinct: ["upazila"],
          take: limit,
          orderBy: { upazila: "asc" },
        });
        for (const u of upazilas) {
          if (!q || u.upazila.toLowerCase().includes(q.toLowerCase())) {
            items.push({ value: u.upazila, label: u.upazila, meta: { district: u.district } });
          }
        }
        break;
      }

      case "courses": {
        const where: Record<string, unknown> = {};
        if (q) {
          where.title = { contains: q, mode: "insensitive" };
        }
        const courses = await prisma.course.findMany({
          where,
          take: limit,
          select: { id: true, title: true, grade: true, subject: true },
          orderBy: { title: "asc" },
        });
        for (const c of courses) {
          items.push({
            value: c.id,
            label: `${c.title} (Class ${c.grade})`,
            meta: { grade: c.grade, subject: c.subject },
          });
        }
        break;
      }

      case "staff": {
        const where: Record<string, unknown> = {};
        if (q) {
          where.user = {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
            ],
          };
        }
        const staffList = await prisma.staffProfile.findMany({
          where,
          include: { user: true },
          take: limit,
          orderBy: { user: { name: "asc" } },
        });
        for (const s of staffList) {
          items.push({
            value: s.userId,
            label: `${s.user.name} (${s.title || "Staff"})`,
            meta: { email: s.user.email, department: s.department },
          });
        }
        break;
      }

      case "teachers": {
        const where: Record<string, unknown> = {};
        if (ctx.scope.type === "SCHOOL" && ctx.scope.id) {
          where.primarySchoolId = ctx.scope.id;
        }
        if (q) {
          where.user = {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
            ],
          };
        }
        const teachers = await prisma.teacherProfile.findMany({
          where,
          include: { user: true, primarySchool: true },
          take: limit,
          orderBy: { user: { name: "asc" } },
        });
        for (const t of teachers) {
          items.push({
            value: t.userId,
            label: `${t.user.name} (${t.code})`,
            meta: { code: t.code, schoolName: t.primarySchool?.name },
          });
        }
        break;
      }

      case "students": {
        const where: Record<string, unknown> = {};
        if (ctx.scope.type === "SCHOOL" && ctx.scope.id) {
          where.schoolId = ctx.scope.id;
        }
        if (q) {
          where.OR = [
            { code: { contains: q, mode: "insensitive" } },
            { user: { name: { contains: q, mode: "insensitive" } } },
          ];
        }
        const students = await prisma.studentProfile.findMany({
          where,
          include: { user: true },
          take: limit,
          orderBy: { user: { name: "asc" } },
        });
        for (const s of students) {
          items.push({
            value: s.userId,
            label: `${s.user.name} (${s.code})`,
            meta: { code: s.code, grade: s.user.grade },
          });
        }
        break;
      }

      default:
        // Generic empty array for unsupported or future entity kinds
        break;
    }

    return sendOne(res, items);
  } catch (err) {
    return next(err);
  }
});
