/* eslint-disable no-console */
import { cleanupExpiredArtifacts } from "../src/lib/cleanup";
import { prisma } from "../src/lib/prisma";

cleanupExpiredArtifacts(prisma)
  .then((r) => console.log(`Cleanup complete: removed ${r.deletedTickets} stale battle tickets, ${r.deletedClips} old speech clips`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
