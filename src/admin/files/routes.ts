import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { HttpError, badRequest } from "../../lib/errors";
import { getCtx } from "../core/context";
import { putFile, readFileByToken } from "../core/files";
import { sendOne } from "../core/respond";

export const filesRouter = Router();

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20 MB
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(badRequest(`File type '${file.mimetype}' is not permitted`));
    }
  },
});

const UploadBody = z.object({
  purpose: z.enum(["evidence", "material", "import", "consent", "report", "other"]).default("evidence"),
  sensitivity: z.enum(["internal", "confidential", "restricted"]).default("internal"),
});

// POST /api/admin/files
filesRouter.post("/", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) {
    throw badRequest("No file uploaded");
  }

  const ctx = getCtx(req);
  const body = UploadBody.parse(req.body);

  const stored = await putFile(ctx, {
    purpose: body.purpose,
    fileName: file.originalname,
    mime: file.mimetype,
    data: file.buffer,
    sensitivity: body.sensitivity,
  });

  res.status(201);
  sendOne(res, {
    id: stored.id,
    fileName: stored.fileName,
    sizeBytes: stored.sizeBytes,
    mime: stored.mime,
  });
});

// GET /api/admin/files/:token
filesRouter.get("/:token", async (req, res) => {
  const token = req.params.token as string;
  const userId = req.user?.id || "";

  const file = await readFileByToken(token, userId);

  if (!file.data) {
    throw new HttpError(404, "File content is not stored inline", "file_not_found");
  }

  res.setHeader("Content-Type", file.mime);
  res.setHeader("Content-Disposition", `inline; filename="${file.fileName}"`);
  res.setHeader("Content-Length", file.sizeBytes);

  res.send(Buffer.from(file.data));
});
