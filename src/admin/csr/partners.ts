import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { getCtx } from "../core/context";
import { requirePermission } from "../core/permissions";
import { writeAudit } from "../core/audit";
import { sendOne, sendList } from "../core/respond";

export const csrPartnersRouter = Router();

const createPartnerSchema = z.object({
  name: z.string().min(2),
  type: z.enum(["corporate", "ngo", "government", "individual", "other"]).default("corporate"),
  contactName: z.string().min(2),
  contactEmail: z.string().email(),
  contactPhone: z.string().default(""),
  address: z.string().default(""),
  reportingSchedule: z.enum(["monthly", "quarterly", "semi_annual", "annual"]).default("quarterly"),
  donorRestrictions: z.string().default(""),
});

const updatePartnerSchema = createPartnerSchema.partial().extend({
  status: z.enum(["active", "archived"]).optional(),
});

const createAgreementSchema = z.object({
  agreementRef: z.string().min(2),
  amountCommitted: z.number().positive(),
  currency: z.string().default("BDT"),
  startDate: z.string().or(z.date()),
  endDate: z.string().or(z.date()),
  restrictions: z.string().default(""),
  allowsInterEntityPurchase: z.boolean().default(false),
  signedOn: z.string().or(z.date()).optional(),
  documentFileId: z.string().optional(),
});

/**
 * GET /api/admin/csr/partners
 * List all CSR partners with agreement count and programmes count.
 */
csrPartnersRouter.get("/", requirePermission("csr.partners.view"), async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
    const search = (req.query.search as string)?.trim() || "";
    const type = req.query.type as string;
    const status = req.query.status as string;

    const where: any = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { code: { contains: search, mode: "insensitive" } },
        { contactName: { contains: search, mode: "insensitive" } },
        { contactEmail: { contains: search, mode: "insensitive" } },
      ];
    }
    if (type) where.type = type;
    if (status) where.status = status;

    const [total, partners] = await Promise.all([
      prisma.partner.count({ where }),
      prisma.partner.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: "desc" },
        include: {
          _count: {
            select: {
              agreements: true,
              programmes: true,
            },
          },
          agreements: {
            where: { status: "active" },
            select: { amountCommitted: true },
          },
        },
      }),
    ]);

    const rows = partners.map((p) => {
      const totalCommitted = p.agreements.reduce((sum, a) => sum + Number(a.amountCommitted), 0);
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        type: p.type,
        contactName: p.contactName,
        contactEmail: p.contactEmail,
        contactPhone: p.contactPhone,
        reportingSchedule: p.reportingSchedule,
        status: p.status,
        agreementsCount: p._count.agreements,
        programmesCount: p._count.programmes,
        totalCommitted,
        createdAt: p.createdAt,
      };
    });

    sendList(res, rows, { page, pageSize, total });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/csr/partners
 * Create a new partner.
 */
csrPartnersRouter.post("/", requirePermission("csr.partners.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const parsed = createPartnerSchema.parse(req.body);

    const count = await prisma.partner.count();
    const code = `PRT-${(count + 1).toString().padStart(6, "0")}`;

    const partner = await prisma.$transaction(async (tx) => {
      const p = await tx.partner.create({
        data: {
          code,
          name: parsed.name,
          type: parsed.type,
          contactName: parsed.contactName,
          contactEmail: parsed.contactEmail,
          contactPhone: parsed.contactPhone,
          address: parsed.address,
          reportingSchedule: parsed.reportingSchedule,
          donorRestrictions: parsed.donorRestrictions,
          createdById: ctx.user.id,
        },
      });

      await writeAudit(tx, ctx, {
        action: "create",
        entityType: "Partner",
        entityId: p.id,
        after: p,
      });

      return p;
    });

    sendOne(res, partner, 201);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/csr/partners/:id
 * Retrieve single partner with all agreements and active programmes.
 */
csrPartnersRouter.get("/:id", requirePermission("csr.partners.view"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const partner = await prisma.partner.findUnique({
      where: { id },
      include: {
        agreements: {
          orderBy: [{ agreementRef: "asc" }, { versionNo: "desc" }],
        },
        programmes: {
          orderBy: { createdAt: "desc" },
          include: {
            _count: {
              select: { beneficiaries: true },
            },
          },
        },
      },
    });

    if (!partner) throw notFound("Partner not found");

    sendOne(res, partner);
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/admin/csr/partners/:id
 * Update partner details.
 */
csrPartnersRouter.put("/:id", requirePermission("csr.partners.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = req.params.id as string;
    const parsed = updatePartnerSchema.parse(req.body);

    const partner = await prisma.$transaction(async (tx) => {
      const existing = await tx.partner.findUnique({ where: { id } });
      if (!existing) throw notFound("Partner not found");

      const updated = await tx.partner.update({
        where: { id },
        data: {
          ...parsed,
          version: existing.version + 1,
        },
      });

      await writeAudit(tx, ctx, {
        action: "update",
        entityType: "Partner",
        entityId: id,
        before: existing,
        after: updated,
      });

      return updated;
    });

    sendOne(res, partner);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/csr/partners/:id/agreements
 * Add a grant agreement or amendment version to a partner.
 */
csrPartnersRouter.post("/:id/agreements", requirePermission("csr.partners.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const partnerId = req.params.id as string;
    const parsed = createAgreementSchema.parse(req.body);

    const partner = await prisma.partner.findUnique({ where: { id: partnerId } });
    if (!partner) throw notFound("Partner not found");

    const agreement = await prisma.$transaction(async (tx) => {
      // Find latest version for this agreementRef
      const latest = await tx.grantAgreement.findFirst({
        where: { partnerId, agreementRef: parsed.agreementRef },
        orderBy: { versionNo: "desc" },
      });

      const versionNo = latest ? latest.versionNo + 1 : 1;

      // If prior version existed, mark it superseded
      if (latest) {
        await tx.grantAgreement.update({
          where: { id: latest.id },
          data: { status: "superseded" },
        });
      }

      const ag = await tx.grantAgreement.create({
        data: {
          partnerId,
          agreementRef: parsed.agreementRef,
          versionNo,
          amountCommitted: parsed.amountCommitted,
          currency: parsed.currency,
          startDate: new Date(parsed.startDate),
          endDate: new Date(parsed.endDate),
          restrictions: parsed.restrictions,
          allowsInterEntityPurchase: parsed.allowsInterEntityPurchase,
          signedOn: parsed.signedOn ? new Date(parsed.signedOn) : null,
          documentFileId: parsed.documentFileId || null,
          status: "active",
          createdById: ctx.user.id,
          supersedesId: latest?.id || null,
        },
      });

      await writeAudit(tx, ctx, {
        action: "create",
        entityType: "GrantAgreement",
        entityId: ag.id,
        after: ag,
      });

      return ag;
    });

    sendOne(res, agreement, 201);
  } catch (err) {
    next(err);
  }
});
