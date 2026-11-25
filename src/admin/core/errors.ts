import { HttpError } from "../../lib/errors";

export class NotFoundError extends HttpError {
  constructor(entity: string, id: string) {
    super(404, `${entity} ${id} not found`, "not_found");
  }
}

export class ValidationError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, message, "validation_error", details);
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, message, "conflict");
  }
}

export class ForbiddenError extends HttpError {
  constructor(message: string) {
    super(403, message, "forbidden");
  }
}

export function adminForbidden(code = "forbidden", message = "Permission denied", details?: any) {
  return new HttpError(403, message, code, details);
}

export function mfaRequired(message = "MFA verification required") {
  return new HttpError(401, message, "mfa_required");
}

export function workspaceInvalid(message = "Valid active workspace assignment required in X-Workspace header") {
  return new HttpError(403, message, "workspace_invalid");
}

export function outOfScope(message = "Requested entity is outside your active workspace scope") {
  return new HttpError(403, message, "out_of_scope");
}

export function selfApprovalForbidden(message = "Makers cannot approve their own requests") {
  return new HttpError(403, message, "self_approval");
}

export function invalidTransition(message = "Invalid state transition") {
  return new HttpError(409, message, "invalid_transition");
}

export function versionConflict(message = "This record was changed by someone else. Reload to see the latest version.") {
  return new HttpError(409, message, "version_conflict");
}

export function idempotencyMismatch(message = "Idempotency key payload does not match the previous request") {
  return new HttpError(422, message, "idempotency_mismatch");
}
