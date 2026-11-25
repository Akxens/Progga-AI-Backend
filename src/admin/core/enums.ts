import { z } from "zod";

export const ScopeTypeEnum = z.enum(["GLOBAL", "LEGAL_ENTITY", "SCHOOL", "PROGRAMME", "PARTNER"]);
export type ScopeType = z.infer<typeof ScopeTypeEnum>;

export const AccountStatusEnum = z.enum(["invited", "registered", "active", "suspended", "closed"]);
export type AccountStatus = z.infer<typeof AccountStatusEnum>;

export const EffectiveAccessEnum = z.enum(["FREE", "PREMIUM_PAID", "PREMIUM_SPONSORED"]);
export type EffectiveAccess = z.infer<typeof EffectiveAccessEnum>;

export const GuardianRelationEnum = z.enum([
  "father",
  "mother",
  "brother",
  "sister",
  "uncle",
  "aunt",
  "grandparent",
  "other",
  "teacher",
]);
export type GuardianRelation = z.infer<typeof GuardianRelationEnum>;

export const GuardianStatusEnum = z.enum([
  "none",
  "invited",
  "linked_unverified",
  "verified",
  "consent_revoked",
]);
export type GuardianStatus = z.infer<typeof GuardianStatusEnum>;

export const SchoolTypeEnum = z.enum([
  "government",
  "non_government",
  "madrasa",
  "english_medium",
  "technical",
  "other",
]);
export type SchoolType = z.infer<typeof SchoolTypeEnum>;

export const SchoolLevelEnum = z.enum(["primary", "secondary", "higher_secondary", "combined"]);
export type SchoolLevel = z.infer<typeof SchoolLevelEnum>;

export const OnboardingStageEnum = z.enum([
  "created",
  "identifiers_verified",
  "admin_nominated",
  "members_imported",
  "guardian_process_confirmed",
  "entitlements_assigned",
  "activated",
  "adoption_review",
]);
export type OnboardingStage = z.infer<typeof OnboardingStageEnum>;

export const ApprovalTypeEnum = z.enum([
  "plan_version",
  "refund",
  "ai_routing",
  "expense",
  "programme",
  "grant_agreement",
  "programme_amendment",
  "inter_entity_foundation",
  "inter_entity_final",
  "exam_regrade",
  "teacher_assignment",
  "content_review",
  "manual_entitlement",
  "period_reopen",
  "beneficiary_pii_access",
]);
export type ApprovalType = z.infer<typeof ApprovalTypeEnum>;

export const ApprovalStatusEnum = z.enum(["pending", "approved", "rejected", "cancelled"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusEnum>;
