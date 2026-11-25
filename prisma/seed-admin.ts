import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { SYSTEM_ROLES } from "../src/admin/core/permissions";
import { nextCode } from "../src/admin/core/codes";

const prisma = new PrismaClient();

export async function seedIdentity() {
  console.log("Seeding Identity & RBAC baseline...");

  // 1. Legal Entities
  const legalEntities = [
    { id: "ltd", name: "Progga Technologies Ltd.", type: "company" },
    { id: "foundation", name: "Progga Foundation", type: "foundation" },
  ];

  for (const entity of legalEntities) {
    await prisma.legalEntity.upsert({
      where: { id: entity.id },
      update: { name: entity.name, type: entity.type },
      create: { id: entity.id, name: entity.name, type: entity.type },
    });
  }
  console.log("✓ Legal entities upserted");

  // 2. System Roles & Permissions
  for (const r of Object.values(SYSTEM_ROLES)) {
    await prisma.role.upsert({
      where: { key: r.key },
      update: {
        name: r.name,
        allowedScopes: r.allowedScopes as string[],
        permissions: r.permissions as string[],
        status: "active",
      },
      create: {
        key: r.key,
        name: r.name,
        allowedScopes: r.allowedScopes as string[],
        permissions: r.permissions as string[],
        isSystem: true,
        status: "active",
      },
    });
  }
  console.log(`✓ ${Object.keys(SYSTEM_ROLES).length} system roles upserted`);

  const superAdminRole = await prisma.role.findUniqueOrThrow({
    where: { key: "SUPER_ADMIN" },
  });

  // 3. Backfill ADMIN users -> StaffProfile & RoleAssignment
  const adminUsers = await prisma.user.findMany({
    where: { role: "ADMIN" },
  });

  for (const admin of adminUsers) {
    await prisma.staffProfile.upsert({
      where: { userId: admin.id },
      update: {},
      create: {
        userId: admin.id,
        title: "Platform Administrator",
        department: "Operations",
      },
    });

    const existingAssignment = await prisma.roleAssignment.findFirst({
      where: { userId: admin.id, roleId: superAdminRole.id },
    });

    if (!existingAssignment) {
      await prisma.roleAssignment.create({
        data: {
          userId: admin.id,
          roleId: superAdminRole.id,
          scopeType: "GLOBAL",
          scopeId: null,
          status: "active",
          reason: "System backfill",
        },
      });
    }
  }
  console.log(`✓ Backfilled ${adminUsers.length} admin accounts with staff profiles`);

  // 4. Backfill STUDENT users -> StudentProfile
  const studentsWithoutProfile = await prisma.user.findMany({
    where: {
      role: "STUDENT",
      studentProfile: null,
    },
  });

  for (const student of studentsWithoutProfile) {
    const code = await nextCode(prisma, "STU");
    const activeLinksCount = await prisma.guardianLink.count({
      where: { studentId: student.id, status: "active" },
    });

    await prisma.studentProfile.create({
      data: {
        userId: student.id,
        code,
        effectiveAccess: "FREE",
        guardianStatus: activeLinksCount > 0 ? "linked_unverified" : "none",
        district: student.district || null,
      },
    });
  }
  if (studentsWithoutProfile.length > 0) {
    console.log(`✓ Backfilled ${studentsWithoutProfile.length} students with student profiles`);
  }

  // 5. Backfill TEACHER users -> TeacherProfile
  const teachersWithoutProfile = await prisma.user.findMany({
    where: {
      role: "TEACHER",
      teacherProfile: null,
    },
  });

  for (const teacher of teachersWithoutProfile) {
    const code = await nextCode(prisma, "TCH");
    await prisma.teacherProfile.create({
      data: {
        userId: teacher.id,
        code,
        status: "active",
        verificationStatus: "unverified",
      },
    });
  }
  if (teachersWithoutProfile.length > 0) {
    console.log(`✓ Backfilled ${teachersWithoutProfile.length} teachers with teacher profiles`);
  }

  // 6. Dev Demo Staff Accounts & Demo School
  if (process.env.NODE_ENV !== "production") {
    console.log("Seeding local development demo staff and school...");

    // Demo school
    const demoSchool = await prisma.school.upsert({
      where: { code: "SCH-000001" },
      update: {},
      create: {
        id: "cm3sch01",
        code: "SCH-000001",
        name: "Rajshahi Collegiate School",
        eiin: "126255",
        type: "government",
        level: "secondary",
        division: "Rajshahi",
        district: "Rajshahi",
        upazila: "Boalia",
        onboardingStage: "activated",
        status: "active",
        nameKey: "rajshahi collegiate school",
      },
    });

    const demoStaffList = [
      {
        email: "finance@demo.progga.ai",
        name: "Demo Finance Officer",
        roleKey: "FINANCE_OFFICER",
        scopeType: "LEGAL_ENTITY",
        scopeId: "ltd",
        title: "Finance Officer",
        department: "Finance",
        linkCode: "LNK-FIN1",
      },
      {
        email: "approver@demo.progga.ai",
        name: "Demo Finance Approver",
        roleKey: "FINANCE_APPROVER",
        scopeType: "LEGAL_ENTITY",
        scopeId: "ltd",
        title: "Head of Finance",
        department: "Finance",
        linkCode: "LNK-APP1",
      },
      {
        email: "foundation@demo.progga.ai",
        name: "Demo Foundation Admin",
        roleKey: "FOUNDATION_ADMIN",
        scopeType: "LEGAL_ENTITY",
        scopeId: "foundation",
        title: "Foundation Lead",
        department: "CSR & Foundation",
        linkCode: "LNK-FND1",
      },
      {
        email: "safety@demo.progga.ai",
        name: "Demo Safety Reviewer",
        roleKey: "SAFETY_REVIEWER",
        scopeType: "GLOBAL",
        scopeId: null,
        title: "Trust & Safety Specialist",
        department: "Safety",
        linkCode: "LNK-SAF1",
      },
      {
        email: "school@demo.progga.ai",
        name: "Demo School Admin",
        roleKey: "SCHOOL_ADMIN",
        scopeType: "SCHOOL",
        scopeId: demoSchool.id,
        title: "Headmaster / IT Coordinator",
        department: "Administration",
        linkCode: "LNK-SCH1",
      },
    ];

    const passwordHash = await bcrypt.hash("Progga@123", 10);

    for (const item of demoStaffList) {
      const role = await prisma.role.findUniqueOrThrow({
        where: { key: item.roleKey },
      });

      const user = await prisma.user.upsert({
        where: { email: item.email },
        update: {
          name: item.name,
          role: "ADMIN",
          accountStatus: "active",
        },
        create: {
          email: item.email,
          name: item.name,
          passwordHash,
          role: "ADMIN",
          accountStatus: "active",
          isTestAccount: true,
          linkCode: item.linkCode,
        },
      });

      await prisma.staffProfile.upsert({
        where: { userId: user.id },
        update: {
          title: item.title,
          department: item.department,
          mustChangePassword: false,
        },
        create: {
          userId: user.id,
          title: item.title,
          department: item.department,
          mustChangePassword: false,
        },
      });

      const existingAssignment = await prisma.roleAssignment.findFirst({
        where: { userId: user.id, roleId: role.id, scopeType: item.scopeType, scopeId: item.scopeId },
      });

      if (!existingAssignment) {
        await prisma.roleAssignment.create({
          data: {
            userId: user.id,
            roleId: role.id,
            scopeType: item.scopeType,
            scopeId: item.scopeId,
            status: "active",
            reason: "Demo account setup",
          },
        });
      }
    }
    console.log("✓ Demo staff accounts created with password 'Progga@123'");
  }
}

async function main() {
  try {
    await seedIdentity();
    console.log("✅ Admin database seed completed successfully.");
  } catch (error) {
    console.error("❌ Admin database seed failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module || process.argv[1]?.endsWith("seed-admin.ts")) {
  main();
}
