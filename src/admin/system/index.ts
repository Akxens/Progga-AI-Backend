import { Router } from "express";
import { systemUsersRouter } from "./users";
import { systemRolesRouter } from "./roles";
import { systemAuditRouter } from "./audit";
import { systemConfigRouter } from "./config";
import { systemHealthRouter } from "./health";
import { systemConsentRouter } from "./consent";

export const systemRouter = Router();

systemRouter.use("/users", systemUsersRouter);
systemRouter.use("/staff", systemUsersRouter);
systemRouter.use("/roles", systemRolesRouter);
systemRouter.use("/", systemRolesRouter);
systemRouter.use("/audit", systemAuditRouter);
systemRouter.use("/", systemConfigRouter);
systemRouter.use("/", systemHealthRouter);
systemRouter.use("/", systemConsentRouter);
