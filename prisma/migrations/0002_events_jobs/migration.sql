-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "sessionId" TEXT,
    "schoolId" TEXT,
    "programmeId" TEXT,
    "legalEntityId" TEXT,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "correlationId" TEXT,
    "source" TEXT NOT NULL,
    "properties" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningSession" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "activeSeconds" INTEGER NOT NULL DEFAULT 0,
    "deviceCategory" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'web',
    "appVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "module" TEXT NOT NULL,
    "lessonId" TEXT,
    "isFinalized" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearningSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Outbox" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lockedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobSchedule" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "everyMinutes" INTEGER NOT NULL,
    "atHourDhaka" INTEGER,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "JobSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyMetric" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "metricKey" TEXT NOT NULL,
    "dimension" TEXT NOT NULL DEFAULT 'all',
    "value" DECIMAL(18,4) NOT NULL,
    "metricVersion" INTEGER NOT NULL DEFAULT 1,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemHealthSample" (
    "id" TEXT NOT NULL,
    "sampledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "service" TEXT NOT NULL DEFAULT 'progga-api',
    "dbOk" BOOLEAN NOT NULL,
    "dbLatencyMs" INTEGER NOT NULL,
    "aiOk" BOOLEAN NOT NULL,
    "aiLatencyMs" INTEGER NOT NULL,
    "aiProvider" TEXT NOT NULL,
    "voiceOk" BOOLEAN NOT NULL,
    "voiceKey" TEXT NOT NULL,
    "memoryMb" INTEGER NOT NULL,
    "activeSessions15m" INTEGER NOT NULL,

    CONSTRAINT "SystemHealthSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemAlert" (
    "id" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "ackById" TEXT,
    "ackAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Event_eventType_occurredAt_idx" ON "Event"("eventType", "occurredAt");

-- CreateIndex
CREATE INDEX "Event_userId_occurredAt_idx" ON "Event"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "Event_sessionId_idx" ON "Event"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "LearningSession_code_key" ON "LearningSession"("code");

-- CreateIndex
CREATE INDEX "LearningSession_userId_startedAt_idx" ON "LearningSession"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "LearningSession_isFinalized_lastHeartbeatAt_idx" ON "LearningSession"("isFinalized", "lastHeartbeatAt");

-- CreateIndex
CREATE INDEX "Outbox_status_nextAttemptAt_idx" ON "Outbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "Job_status_runAt_idx" ON "Job"("status", "runAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobSchedule_type_key" ON "JobSchedule"("type");

-- CreateIndex
CREATE INDEX "DailyMetric_metricKey_day_idx" ON "DailyMetric"("metricKey", "day");

-- CreateIndex
CREATE UNIQUE INDEX "DailyMetric_day_metricKey_dimension_metricVersion_key" ON "DailyMetric"("day", "metricKey", "dimension", "metricVersion");

-- CreateIndex
CREATE INDEX "SystemAlert_severity_acknowledged_idx" ON "SystemAlert"("severity", "acknowledged");

-- Sequences (04 §11.3)
CREATE SEQUENCE IF NOT EXISTS code_seq_ses;

-- Append-only trigger (04 §11.2)
CREATE TRIGGER event_no_update BEFORE UPDATE ON "Event" FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
