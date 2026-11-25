import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "../../lib/prisma";
import { getCtx } from "../core/context";
import { sendCreated, sendList, sendOne } from "../core/respond";
import { ForbiddenError, NotFoundError, ValidationError, ConflictError } from "../core/errors";
import { nextCode } from "../core/codes";
import { emitAudit } from "../core/audit";
import { parseCsv, toCsv } from "../core/csv";

export const importsRouter = Router();

const upload = multer({
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB max
  storage: multer.memoryStorage(),
});

const TYPE_PERMISSIONS: Record<string, string> = {
  students: "students.import",
  teachers: "teachers.import",
  schools: "schools.import",
  questions: "questions.import",
  beneficiaries: "csr.beneficiaries.manage",
  curriculum: "curriculum.edit",
};

interface RowError {
  row: number;
  field: string;
  code: string;
  message: string;
}

// GET /templates/:type
importsRouter.get("/templates/:type", (req: Request, res: Response) => {
  const type = req.params.type as string;

  let headers: string[] = [];
  let sampleRow: string[] = [];

  if (type === "students") {
    headers = ["name", "grade", "birthdate", "section", "division", "district", "upazila", "guardianPhone", "guardianRelation", "schoolId"];
    sampleRow = ["Tanvir Hossain", "7", "2013-05-14", "A", "Dhaka", "Dhaka", "Mirpur", "01712345678", "father", ""];
  } else if (type === "teachers") {
    headers = ["name", "phone", "email", "grades", "subjects", "division", "district", "upazila", "schoolId"];
    sampleRow = ["Farhana Akter", "01812345678", "farhana@example.com", "6,7,8", "mathematics,science", "Dhaka", "Dhaka", "Dhanmondi", ""];
  } else if (type === "schools") {
    headers = ["name", "nameBn", "eiin", "type", "level", "division", "district", "upazila", "address", "contactName", "contactPhone", "contactEmail"];
    sampleRow = ["Mirpur Model High School", "মিরপুর মডেল উচ্চ বিদ্যালয়", "108123", "non_government", "secondary", "Dhaka", "Dhaka", "Mirpur", "Section 2, Mirpur", "Principal", "01700000000", "school@example.com"];
  } else {
    headers = ["name", "code", "description"];
    sampleRow = ["Example", "EX-001", "Sample"];
  }

  const csv = toCsv(headers, [sampleRow]);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${type}-template.csv"`);
  res.status(200).send(csv);
});

// GET /
importsRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    const { type, status, limit = "20", cursor } = req.query;

    const where: any = {};
    if (type && typeof type === "string") where.type = type;
    if (status && typeof status === "string") where.status = status;

    const take = Math.min(Math.max(parseInt(String(limit), 10) || 20, 1), 100);
    const items = await prisma.importJob.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: take + 1,
      ...(cursor && typeof cursor === "string" ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > take;
    const pageItems = hasMore ? items.slice(0, take) : items;
    const nextCursor = hasMore ? pageItems[pageItems.length - 1]?.id : null;

    sendList(res, pageItems, { nextCursor, total: pageItems.length });
  } catch (err) {
    next(err);
  }
});

// GET /:id
importsRouter.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const job = await prisma.importJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundError("ImportJob", id);
    sendOne(res, job);
  } catch (err) {
    next(err);
  }
});

// POST /
importsRouter.post("/", upload.single("file"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    const file = req.file;
    if (!file) {
      throw new ValidationError("File is required");
    }

    const type = req.body.type as string;
    if (!type || !TYPE_PERMISSIONS[type]) {
      throw new ValidationError(`Unsupported import type: ${type}`);
    }

    const requiredPerm = TYPE_PERMISSIONS[type];
    ctx.assert(requiredPerm);

    let context: any = {};
    if (req.body.context) {
      try {
        context = typeof req.body.context === "string" ? JSON.parse(req.body.context) : req.body.context;
      } catch {
        throw new ValidationError("Invalid JSON context");
      }
    }

    // Save StoredFile
    const sha256 = crypto.createHash("sha256").update(file.buffer).digest("hex");
    const storedFile = await prisma.storedFile.create({
      data: {
        purpose: "import",
        fileName: file.originalname || `${type}-import.csv`,
        mime: file.mimetype || "text/csv",
        sizeBytes: file.size,
        sha256,
        data: new Uint8Array(file.buffer),
        createdById: ctx.user.id,
      },
    });

    const code = await nextCode("IMP");
    const csvContent = Buffer.from(file.buffer).toString("utf-8");
    const { headers, rows } = parseCsv(csvContent);

    const errors: RowError[] = [];

    // Validation row-by-row
    rows.forEach((row, idx) => {
      const rowNum = idx + 2; // 1-indexed, skipping header row
      if (type === "students") {
        if (!row.name || row.name.trim().length === 0) {
          errors.push({ row: rowNum, field: "name", code: "required", message: "Student name is required" });
        }
        const grade = parseInt(row.grade || "", 10);
        if (isNaN(grade) || grade < 3 || grade > 12) {
          errors.push({ row: rowNum, field: "grade", code: "out_of_range", message: "Grade must be between 3 and 12" });
        }
        if (row.guardianphone && !/^01[3-9]\d{8}$/.test(row.guardianphone.replace(/[\s-]/g, ""))) {
          errors.push({ row: rowNum, field: "guardianPhone", code: "invalid_format", message: "Invalid Bangladesh phone number" });
        }
      } else if (type === "teachers") {
        if (!row.name || row.name.trim().length === 0) {
          errors.push({ row: rowNum, field: "name", code: "required", message: "Teacher name is required" });
        }
        if (row.phone && !/^01[3-9]\d{8}$/.test(row.phone.replace(/[\s-]/g, ""))) {
          errors.push({ row: rowNum, field: "phone", code: "invalid_format", message: "Invalid Bangladesh phone number" });
        }
      } else if (type === "schools") {
        if (!row.name || row.name.trim().length === 0) {
          errors.push({ row: rowNum, field: "name", code: "required", message: "School name is required" });
        }
        if (!row.division || !row.district || !row.upazila) {
          errors.push({ row: rowNum, field: "location", code: "required", message: "Division, district, and upazila are required" });
        }
        if (row.eiin && !/^\d{6}$/.test(row.eiin.trim())) {
          errors.push({ row: rowNum, field: "eiin", code: "invalid_format", message: "EIIN must be a 6-digit number" });
        }
      }
    });

    const totalRows = rows.length;
    const invalidRows = new Set(errors.map((e) => e.row)).size;
    const validRows = totalRows - invalidRows;

    const job = await prisma.importJob.create({
      data: {
        code,
        type,
        status: "validated",
        fileId: storedFile.id,
        fileName: file.originalname || `${type}-import.csv`,
        context,
        totalRows,
        validRows,
        invalidRows,
        createdRows: 0,
        skippedRows: 0,
        errors: errors as any,
        uploadedById: ctx.user.id,
      },
    });

    await emitAudit(req, {
      action: "import.upload",
      entityType: "import_job",
      entityId: job.id,
      after: { code: job.code, type: job.type, totalRows, validRows, invalidRows },
    });

    sendCreated(res, job);
  } catch (err) {
    next(err);
  }
});

// POST /:id/approve
importsRouter.post("/:id/approve", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    ctx.assert("imports.approve");

    const id = req.params.id as string;
    const { skipInvalid = false } = req.body;

    const job = await prisma.importJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundError("ImportJob", id);

    // Maker-checker rule: approver !== uploader
    if (job.uploadedById === ctx.user.id) {
      throw new ForbiddenError("Maker-checker violation: cannot approve an import job that you uploaded");
    }

    if (job.status !== "validated") {
      throw new ValidationError(`Job status is ${job.status}, only validated jobs can be approved`);
    }

    if (job.invalidRows > 0 && !skipInvalid) {
      throw new ValidationError(`Import job has ${job.invalidRows} invalid rows. Pass { skipInvalid: true } to proceed with valid rows.`);
    }

    // Retrieve file data
    const storedFile = await prisma.storedFile.findUnique({ where: { id: job.fileId } });
    if (!storedFile || !storedFile.data) {
      throw new NotFoundError("StoredFile", job.fileId);
    }

    const csvContent = Buffer.from(storedFile.data).toString("utf-8");
    const { rows } = parseCsv(csvContent);
    const errorRowSet = new Set(((job.errors as any[]) || []).map((e) => e.row));

    let createdCount = 0;
    let skippedCount = 0;

    // Process valid rows
    for (let i = 0; i < rows.length; i++) {
      const rowNum = i + 2;
      if (errorRowSet.has(rowNum)) {
        skippedCount++;
        continue;
      }

      const row = rows[i];
      try {
        if (job.type === "students") {
          const grade = parseInt(row.grade, 10);
          const schoolId = row.schoolid || (job.context as any)?.schoolId || null;

          await prisma.$transaction(async (tx) => {
            const studentCode = await nextCode(tx, "STU");
            const linkCode = crypto.randomBytes(3).toString("hex").toUpperCase();
            const dummyHash = "$2b$10$dummyHashForInvitedUserAccountPendingPassword";

            const user = await tx.user.create({
              data: {
                name: row.name,
                passwordHash: dummyHash,
                linkCode,
                role: "STUDENT",
                accountStatus: "invited",
                grade,
                language: row.language || "bn",
              },
            });

            await tx.studentProfile.create({
              data: {
                userId: user.id,
                code: studentCode,
                section: row.section || null,
                division: row.division || null,
                district: row.district || null,
                upazila: row.upazila || null,
                schoolId,
              },
            });

            if (schoolId) {
              await tx.schoolMembership.create({
                data: {
                  schoolId,
                  userId: user.id,
                  memberType: "STUDENT",
                  grade,
                  section: row.section || null,
                  startDate: new Date(),
                },
              });
            }

            if (row.guardianphone) {
              const rawToken = crypto.randomBytes(16).toString("hex");
              const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
              await tx.guardianInvite.create({
                data: {
                  studentId: user.id,
                  contact: row.guardianphone.replace(/[\s-]/g, ""),
                  relation: row.guardianrelation || "guardian",
                  tokenHash,
                  status: "sent",
                  expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
                },
              });
            }
          });
          createdCount++;
        } else if (job.type === "teachers") {
          const schoolId = row.schoolid || (job.context as any)?.schoolId || null;
          const phone = row.phone ? row.phone.replace(/[\s-]/g, "") : null;
          const grades = row.grades ? row.grades.split(",").map((g) => parseInt(g.trim(), 10)).filter((g) => !isNaN(g)) : [];
          const subjects = row.subjects ? row.subjects.split(",").map((s) => s.trim().toLowerCase()) : [];

          await prisma.$transaction(async (tx) => {
            const teacherCode = await nextCode(tx, "TCH");
            const linkCode = crypto.randomBytes(3).toString("hex").toUpperCase();
            const dummyHash = "$2b$10$dummyHashForInvitedUserAccountPendingPassword";

            const user = await tx.user.create({
              data: {
                name: row.name,
                passwordHash: dummyHash,
                linkCode,
                role: "TEACHER",
                accountStatus: "invited",
                phone,
                email: row.email || null,
              },
            });

            await tx.teacherProfile.create({
              data: {
                userId: user.id,
                code: teacherCode,
                primarySchoolId: schoolId,
                grades,
                subjectIds: subjects,
                district: row.district || null,
                upazila: row.upazila || null,
              },
            });

            if (schoolId) {
              await tx.schoolMembership.create({
                data: {
                  schoolId,
                  userId: user.id,
                  memberType: "TEACHER",
                  startDate: new Date(),
                },
              });
            }
          });
          createdCount++;
        } else if (job.type === "schools") {
          const schoolCode = await nextCode("SCH");
          const nameKey = row.name.toLowerCase().replace(/\s+/g, " ").trim();

          // Check duplicate
          const existing = await prisma.school.findFirst({
            where: {
              OR: [
                row.eiin ? { eiin: row.eiin.trim() } : undefined,
                { nameKey, district: row.district, upazila: row.upazila },
              ].filter(Boolean) as any,
            },
          });

          if (existing) {
            skippedCount++;
            continue;
          }

          await prisma.school.create({
            data: {
              code: schoolCode,
              name: row.name,
              nameBn: row.namebn || "",
              eiin: row.eiin ? row.eiin.trim() : null,
              type: row.type || "non_government",
              level: row.level || "secondary",
              division: row.division,
              district: row.district,
              upazila: row.upazila,
              address: row.address || "",
              contactName: row.contactname || "",
              contactPhone: row.contactphone || "",
              contactEmail: row.contactemail || "",
              nameKey,
              createdById: ctx.user.id,
            },
          });
          createdCount++;
        }
      } catch (rowErr) {
        skippedCount++;
      }
    }

    const updatedJob = await prisma.importJob.update({
      where: { id },
      data: {
        status: "completed",
        approvedById: ctx.user.id,
        approvedAt: new Date(),
        completedAt: new Date(),
        createdRows: createdCount,
        skippedRows: skippedCount,
      },
    });

    await emitAudit(req, {
      action: "import.approve",
      entityType: "import_job",
      entityId: job.id,
      after: { approvedById: ctx.user.id, createdRows: createdCount, skippedRows: skippedCount },
    });

    sendOne(res, updatedJob);
  } catch (err) {
    next(err);
  }
});

// POST /:id/cancel
importsRouter.post("/:id/cancel", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getCtx(req);
    const id = req.params.id as string;

    const job = await prisma.importJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundError("ImportJob", id);

    if (job.status !== "uploaded" && job.status !== "validated") {
      throw new ValidationError(`Job in status ${job.status} cannot be cancelled`);
    }

    const updated = await prisma.importJob.update({
      where: { id },
      data: { status: "cancelled" },
    });

    await emitAudit(req, {
      action: "import.cancel",
      entityType: "import_job",
      entityId: job.id,
    });

    sendOne(res, updated);
  } catch (err) {
    next(err);
  }
});
