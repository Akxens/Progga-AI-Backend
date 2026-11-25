import type { Prisma, TutorSession } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { dayKey, dayStartUtc } from "../../lib/dates";
import { HttpError, badRequest, conflict, notFound, tooMany } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { award, type Rewards } from "../gamification/service";
import { relatedLessons } from "../lessons/related";
import {
  applyEvaluation,
  canRevealStep,
  newProgress,
  nextHint,
  openingMessages,
  revealStep,
  soundsStuck,
  type OutMessage,
  type SessionState,
} from "./engine";
import { tutorLLM, type TutorLLM } from "./llm";
import type { LabBrief, PlanInput } from "./llm/types";
import { screenInput } from "./safety";
import { evalPreview, planPreview, previewer, type OnPreview } from "./stream-preview";
import type { Plan, StepProgress } from "./schemas";

const RECENT_MESSAGES = 8;
const inFlightPlans = new Set<string>();

const limitReachedMessage = (user: { language: string; dailyTutorLimit: number }) =>
  user.language === "bn"
    ? `আজ তুমি ${user.dailyTutorLimit}টা প্রশ্ন নিয়ে কাজ করেছ — দারুণ! এবার একটু বিরতি নাও, একটা ভিডিও দেখো বা কুইজ খেলো। 🍌`
    : `You've explored ${user.dailyTutorLimit} problems today — amazing! Take a break, watch a lesson, or play Quiz Arena. 🍌`;

// ── Mapping ──────────────────────────────────────────────

function toState(s: TutorSession): SessionState {
  return {
    plan: s.plan as unknown as Plan,
    progress: s.progress as unknown as StepProgress[],
    currentStep: s.currentStep,
    hintsUsed: s.hintsUsed,
    wrongAttempts: s.wrongAttempts,
    status: s.status as SessionState["status"],
  };
}

/**
 * The ONLY shape of a session that leaves the server. Expected answers,
 * unseen hints and the final answer stay hidden. Future step goals are locked
 * so the mission map doesn't give the method away.
 */
function publicView(s: TutorSession) {
  const st = toState(s);
  return {
    id: s.id,
    title: s.title,
    topic: s.topic,
    subject: s.subject,
    grade: s.grade,
    mode: s.mode,
    kind: s.kind,
    status: s.status,
    problemText: s.problemText,
    hadImage: s.hadImage,
    currentStep: s.currentStep,
    totalSteps: st.plan.steps.length,
    hintsUsed: s.hintsUsed,
    xpEarned: s.xpEarned,
    createdAt: s.createdAt,
    canRevealStep: canRevealStep(st),
    bigIdea: s.status === "solved" ? st.plan.big_idea : null,
    steps: st.plan.steps.map((step, i) => {
      const p = st.progress[i];
      const state = p.solved ? (p.revealed ? "revealed" : "done") : i === s.currentStep && s.status === "active" ? "current" : "locked";
      return {
        index: i,
        goal: state === "locked" ? null : step.goal,
        state,
        // answer choices only for the step being worked on (older plans have none)
        options: state === "current" ? step.options ?? [] : [],
        hintsShown: p.hintsShown,
        hintsTotal: step.hints.length,
      };
    }),
  };
}

async function loadOwned(studentId: string, id: string) {
  const s = await prisma.tutorSession.findUnique({ where: { id } });
  if (!s || s.studentId !== studentId) throw notFound("Session not found");
  return s;
}

/**
 * Saves a turn's messages all at once (the database is far away, so every round trip
 * counts; a batch insert would add BEGIN/COMMIT trips). Each gets its own createdAt,
 * a millisecond apart, so they keep their order.
 */
async function saveMessages(
  sessionId: string,
  role: "student" | "tutor",
  msgs: OutMessage[],
  base = Date.now(),
  db: Pick<typeof prisma, "tutorMessage"> = prisma,
) {
  if (!msgs.length) return [];
  return db.tutorMessage.createManyAndReturn({
    data: msgs.map((m, i) => ({
      sessionId,
      role,
      kind: m.kind,
      content: m.content,
      stepIndex: m.stepIndex,
      meta: (m.meta ?? undefined) as Prisma.InputJsonValue,
      createdAt: new Date(base + i),
    })),
  });
}

/**
 * Atomically advances a tutor session and writes that turn's messages in one
 * transaction. Concurrent turns against the same snapshot get 0 updated rows
 * and fail cleanly with 409 instead of corrupting steps or double-awarding XP.
 */
async function persistTurn(
  s: TutorSession,
  nextState: SessionState,
  xpGained: number,
  tutorOutgoing: OutMessage[],
  studentOutgoing?: OutMessage[],
) {
  const base = Date.now();
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.tutorSession.updateMany({
      where: {
        id: s.id,
        status: "active",
        currentStep: s.currentStep,
        hintsUsed: s.hintsUsed,
        wrongAttempts: s.wrongAttempts,
        updatedAt: s.updatedAt,
      },
      data: {
        progress: nextState.progress as unknown as Prisma.InputJsonValue,
        currentStep: nextState.currentStep,
        hintsUsed: nextState.hintsUsed,
        wrongAttempts: nextState.wrongAttempts,
        status: nextState.status,
        xpEarned: { increment: xpGained },
        updatedAt: new Date(Math.max(base, s.updatedAt.getTime() + 1)),
      },
    });
    if (count === 0) throw conflict("Progga is still working on your last turn — please try again.");
    const updated = await tx.tutorSession.findUniqueOrThrow({ where: { id: s.id } });
    const studentMsgs = studentOutgoing?.length ? await saveMessages(s.id, "student", studentOutgoing, base, tx) : [];
    const tutorMsgs = tutorOutgoing.length
      ? await saveMessages(s.id, "tutor", tutorOutgoing, base + (studentOutgoing?.length ?? 0), tx)
      : [];
    return { updated, studentMsgs, tutorMsgs };
  });
}

/**
 * The first time Progga teaches or shows a step in a session, attach our
 * recorded lessons on the topic so the student can watch it explained.
 */
async function withVideos(s: TutorSession, msgs: OutMessage[]): Promise<OutMessage[]> {
  const first = msgs.findIndex((m) => m.kind === "teach" || m.kind === "reveal");
  if (first < 0) return msgs;
  const already = await prisma.tutorMessage.count({ where: { sessionId: s.id, kind: { in: ["teach", "reveal"] } } });
  if (already) return msgs;
  const plan = s.plan as unknown as Plan;
  const step = plan.steps[msgs[first].stepIndex ?? s.currentStep];
  const videos = await relatedLessons({ subject: s.subject, grade: s.grade, text: `${plan.topic} ${s.title} ${s.problemText} ${step?.goal ?? ""}` });
  if (!videos.length) return msgs;
  return msgs.map((m, i) => (i === first ? { ...m, meta: { ...m.meta, videos } } : m));
}

async function logSafety(userId: string, category: string, excerpt: string) {
  await prisma.safetyEvent.create({ data: { userId, category, excerpt: excerpt.slice(0, 280) } });
}

// ── Use cases ────────────────────────────────────────────

export async function startSession(
  studentId: string,
  input: {
    question: string;
    subject: string;
    image?: PlanInput["image"];
    lessonId?: string;
    /** "Start a lesson": teach this topic of the chosen class's syllabus from scratch */
    learn?: { grade: number; topic: string; chapter?: string };
    /** Innovation Lab: build this project to learn its skill */
    project?: LabBrief;
  },
  /** live, word-by-word preview of Progga's opening while the AI writes it */
  onPreview?: OnPreview,
  /** the engine the student picked (default: the admin's choice) */
  llm: TutorLLM = tutorLLM,
) {
  // independent lookups run together: each one is a trip to the database
  const [user, lesson, startedToday] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: studentId } }),
    input.lessonId ? studiedLesson(input.lessonId) : null,
    prisma.tutorSession.count({ where: { studentId, createdAt: { gte: dayStartUtc(dayKey()) } } }),
  ]);
  const subject = lesson?.subject ?? input.subject;
  const learn = input.learn;
  if (learn) input = { ...input, question: user.language === "bn" ? `আমাকে শেখাও: ${learn.topic}` : `Teach me: ${learn.topic}` };
  // a student's own project idea is their words, so it is screened like a question
  const project = input.project;
  if (project && !project.custom) input = { ...input, question: user.language === "bn" ? `প্রজেক্ট: ${project.title}` : `Project: ${project.title}` };
  const teachFreely = !!learn || !!project;

  if (startedToday >= user.dailyTutorLimit) throw tooMany(limitReachedMessage(user));

  if (!input.question.trim() && !input.image) throw badRequest("Type a question or add a photo");
  const screened = screenInput(input.question, user.language);
  if (!screened.ok) {
    await logSafety(studentId, screened.category, screened.text);
    return { blocked: true as const, category: screened.category, message: screened.reply };
  }
  if (inFlightPlans.has(studentId)) throw conflict("Progga is still reading your last question — hold on a moment! 🍌");

  const profile = { grade: learn?.grade ?? user.grade ?? 6, language: user.language, subject };
  let plan: Plan;
  inFlightPlans.add(studentId);
  try {
    plan = await llm.plan(
      {
        profile,
        question: screened.text,
        image: input.image,
        lesson: lesson?.context,
        learn: learn && { topic: learn.topic, chapter: learn.chapter },
        project: project && (project.custom ? { ...project, brief: screened.text } : project),
      },
      previewer((json) => planPreview(json, { lesson: teachFreely }), onPreview),
    );
  } finally {
    inFlightPlans.delete(studentId);
  }

  if (plan.safety !== "ok") {
    if (plan.safety !== "off_topic") await logSafety(studentId, plan.safety, screened.text);
    return {
      blocked: true as const,
      category: plan.safety,
      message: plan.safety_reply || "Let's try a school question together! 🍌",
    };
  }
  if (plan.mode !== "fact" && plan.steps.length === 0) {
    throw new HttpError(502, "Progga got a bit confused planning those steps. Please try again!", "llm_parse");
  }

  const { session, asked, opening } = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${studentId} FOR UPDATE`;
    const countToday = await tx.tutorSession.count({ where: { studentId, createdAt: { gte: dayStartUtc(dayKey()) } } });
    if (countToday >= user.dailyTutorLimit) throw tooMany(limitReachedMessage(user));

    const created = await tx.tutorSession.create({
      data: {
        studentId,
        subject,
        lessonId: lesson?.id,
        grade: profile.grade,
        mode: plan.mode,
        kind: project ? "project" : learn ? "lesson" : "question",
        language: user.language,
        // a fact is answered immediately, so the session is complete from the start
        status: plan.mode === "fact" ? "solved" : "active",
        title: plan.title || "New adventure",
        topic: plan.topic,
        problemText: screened.text || "(photo)",
        hadImage: !!input.image,
        plan: plan as unknown as Prisma.InputJsonValue,
        progress: newProgress(plan) as unknown as Prisma.InputJsonValue,
      },
    });

    // the question and Progga's opening are saved together; timestamps keep the question first
    const now = Date.now();
    const [studentAsked, tutorOpening] = await Promise.all([
      saveMessages(
        created.id,
        "student",
        [{ kind: "text", content: screened.text || (user.language === "bn" ? "📷 (প্রশ্নের ছবি পাঠিয়েছি)" : "📷 (sent a photo of the problem)"), stepIndex: undefined }],
        now,
        tx,
      ),
      saveMessages(created.id, "tutor", openingMessages(plan, { lesson: teachFreely }), now + 1, tx),
    ]);
    return { session: created, asked: studentAsked, opening: tutorOpening };
  });
  // a brand-new chat holds exactly these messages, so there's nothing to read back
  return {
    blocked: false as const,
    session: { ...publicView(session), lesson: lesson && { id: lesson.id, title: lesson.context.title }, messages: [...asked, ...opening].map(publicMessage) },
  };
}

/** Removes a chat and everything in it (messages, saved voice clips). XP already earned is kept. */
export async function deleteSession(studentId: string, id: string) {
  await loadOwned(studentId, id);
  await prisma.tutorSession.delete({ where: { id } });
}

export type SyllabusChapter = { title: string; topics: string[] };

/**
 * Chapters and topics a student can start a lesson on: our own course for that
 * class and subject when there is one, otherwise the NCTB syllabus as the AI
 * knows it (written once, then cached for everyone).
 */
export async function syllabus(grade: number, subjectId: string, language: string): Promise<{ chapters: SyllabusChapter[]; source: "course" | "ai" }> {
  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  if (!subject || grade < subject.minGrade || grade > subject.maxGrade) throw notFound("This subject isn't taught in that class");
  const lang = language === "bn" ? "bn" : "en";

  const course = await prisma.course.findUnique({
    where: { subjectId_grade: { subjectId, grade } },
    include: { chapters: { orderBy: { number: "asc" }, include: { lessons: { orderBy: { order: "asc" }, select: { title: true } } } } },
  });
  if (course?.chapters.length) {
    return {
      source: "course",
      chapters: course.chapters.map((c) => ({ title: (lang === "bn" && c.titleBn) || c.title, topics: c.lessons.map((l) => l.title) })),
    };
  }

  const cached = await prisma.syllabusCache.findUnique({ where: { grade_subject_language: { grade, subject: subjectId, language: lang } } });
  if (cached) return { source: "ai", chapters: cached.chapters as unknown as SyllabusChapter[] };

  const result = await tutorLLM.syllabus({ grade, subject: `${subject.name} (${subject.nameBn})`, language: lang });
  const chapters = result.chapters
    .map((c) => ({ title: c.title.trim(), topics: c.topics.map((t) => t.trim()).filter(Boolean).slice(0, 8) }))
    .filter((c) => c.title && c.topics.length)
    .slice(0, 30);
  if (!chapters.length) throw new HttpError(502, "Progga couldn't open the syllabus. Please try again!", "syllabus_empty");
  await prisma.syllabusCache
    .create({ data: { grade, subject: subjectId, language: lang, chapters: chapters as unknown as Prisma.InputJsonValue } })
    .catch((err) => logger.warn({ err: (err as Error).message }, "Could not cache syllabus")); // e.g. two students at once
  return { source: "ai", chapters };
}

export async function getSession(studentId: string, id: string) {
  return sessionView(await loadOwned(studentId, id));
}

/** The public session with its messages, for a session row we already have. */
async function sessionView(s: TutorSession) {
  const [messages, lesson] = await Promise.all([
    prisma.tutorMessage.findMany({ where: { sessionId: s.id }, orderBy: { createdAt: "asc" } }),
    s.lessonId ? prisma.lesson.findUnique({ where: { id: s.lessonId }, select: { id: true, title: true } }) : null,
  ]);
  return { ...publicView(s), lesson, messages: messages.map(publicMessage) };
}

/** What the planner needs to know about the lesson a question was asked from. */
async function studiedLesson(lessonId: string) {
  const l = await prisma.lesson.findUnique({ where: { id: lessonId }, include: { unit: { select: { title: true } } } });
  if (!l) throw notFound("Lesson not found");
  return {
    id: l.id,
    subject: l.subjectId,
    context: { title: l.title, chapter: l.unit?.title ?? l.chapter, description: l.description, notes: l.body.slice(0, 1500) },
  };
}

function publicMessage(m: { id: string; role: string; kind: string; content: string; stepIndex: number | null; meta: unknown; createdAt: Date }) {
  const meta = (m.meta ?? {}) as Record<string, unknown>;
  // misconception notes are for guardians/teachers, not the student
  const { misconception: _hidden, ...visible } = meta;
  return { id: m.id, role: m.role, kind: m.kind, content: m.content, stepIndex: m.stepIndex, meta: visible, createdAt: m.createdAt };
}

export interface SessionPageQuery {
  limit?: number;
  cursor?: string;
  q?: string;
}

export async function listSessionsPage(studentId: string, opts: SessionPageQuery = {}) {
  const limit = Math.min(50, Math.max(1, opts.limit ?? 30));
  const q = opts.q?.trim();
  const rows = await prisma.tutorSession.findMany({
    where: {
      studentId,
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { topic: { contains: q, mode: "insensitive" } },
              { subject: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    take: limit + 1,
    select: { id: true, title: true, subject: true, topic: true, status: true, mode: true, kind: true, currentStep: true, xpEarned: true, updatedAt: true, plan: true },
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    sessions: page.map(({ plan, ...r }) => ({ ...r, totalSteps: (plan as unknown as Plan).steps.length })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

export async function listSessions(studentId: string, limit = 30) {
  return (await listSessionsPage(studentId, { limit })).sessions;
}

type ActionResult = { session: Awaited<ReturnType<typeof getSession>>; newMessages: ReturnType<typeof publicMessage>[]; rewards: Rewards | null };

/**
 * The student switched language mid-session: translate the rest of the hidden
 * plan once (steps, hints, "why"), so everything after the switch matches.
 */
async function inLanguage(s: TutorSession, language: string, llm: TutorLLM = tutorLLM): Promise<TutorSession> {
  if (s.language === language || s.status !== "active") return s;
  try {
    const plan = await llm.translatePlan(s.plan as unknown as Plan, language);
    return await prisma.tutorSession.update({ where: { id: s.id }, data: { plan: plan as unknown as Prisma.InputJsonValue, language } });
  } catch (err) {
    logger.warn({ err: (err as Error).message, sessionId: s.id }, "Plan translation failed; continuing in the original language");
    return s;
  }
}

export async function reply(studentId: string, id: string, raw: string, onPreview?: OnPreview, llm: TutorLLM = tutorLLM): Promise<ActionResult> {
  let [s, user] = await Promise.all([loadOwned(studentId, id), prisma.user.findUniqueOrThrow({ where: { id: studentId } })]);
  if (s.status !== "active") throw badRequest("This adventure is finished — start a new one!");
  s = await inLanguage(s, user.language, llm);

  const screened = screenInput(raw, user.language);
  if (!screened.ok) {
    await logSafety(studentId, screened.category, screened.text);
    const now = Date.now();
    const [studentMsgs, tutorMsgs] = await prisma.$transaction(async (tx) =>
      Promise.all([
        saveMessages(id, "student", [{ kind: "text", content: screened.text, stepIndex: s.currentStep }], now, tx),
        saveMessages(id, "tutor", [{ kind: "safety", content: screened.reply, stepIndex: s.currentStep }], now + 1, tx),
      ]),
    );
    return { session: await getSession(studentId, id), newMessages: [...studentMsgs, ...tutorMsgs].map(publicMessage), rewards: null };
  }

  const earlier = await prisma.tutorMessage.findMany({ where: { sessionId: id }, orderBy: { createdAt: "desc" }, take: RECENT_MESSAGES });
  const state = toState(s);
  const step = state.plan.steps[state.currentStep];
  const evaluation = soundsStuck(screened.text)
    ? { verdict: "stuck" as const, feedback: "", follow_up: "", misconception: "" }
    : await llm.evaluate(
      {
        profile: { grade: s.grade, language: user.language, subject: s.subject },
        problem: s.problemText,
        plan: state.plan,
        stepIndex: state.currentStep,
        step,
        recent: [...earlier]
          .reverse()
          .map((m) => ({ role: m.role as "student" | "tutor", content: m.content })),
        reply: screened.text,
      },
      previewer((json) => evalPreview(json, [step.expected, state.plan.final_answer]), onPreview),
    );

  const t = applyEvaluation(state, evaluation, user.language);
  if (t.safetyCategory === "wellbeing") await logSafety(studentId, "wellbeing", screened.text);

  const gained = t.xp.reduce((sum, e) => sum + e.amount, 0);
  const outgoing = await withVideos(s, t.messages);
  const { updated, studentMsgs, tutorMsgs } = await persistTurn(
    s,
    t.state,
    gained,
    outgoing,
    [{ kind: "text", content: screened.text, stepIndex: s.currentStep }],
  );
  const [rewards, session] = await Promise.all([
    t.xp.length ? award(studentId, t.xp.map((e) => ({ ...e, refId: id })), { hintFreeSolve: t.hintFreeSolve }) : null,
    sessionView(updated),
  ]);

  return { session, newMessages: [...studentMsgs, ...tutorMsgs].map(publicMessage), rewards };
}

export async function hint(studentId: string, id: string): Promise<ActionResult> {
  const [owned, user] = await Promise.all([
    loadOwned(studentId, id),
    prisma.user.findUniqueOrThrow({ where: { id: studentId }, select: { language: true } }),
  ]);
  const s = await inLanguage(owned, user.language);
  const r = nextHint(toState(s));
  if (!r) throw badRequest("No more hints for this step — try your best guess, or ask Progga to show this step.");
  const { updated, tutorMsgs } = await persistTurn(s, r.state, 0, [r.message]);
  return { session: await sessionView(updated), newMessages: tutorMsgs.map(publicMessage), rewards: null };
}

export async function reveal(studentId: string, id: string): Promise<ActionResult> {
  const [owned, user] = await Promise.all([
    loadOwned(studentId, id),
    prisma.user.findUniqueOrThrow({ where: { id: studentId }, select: { language: true } }),
  ]);
  const s = await inLanguage(owned, user.language);
  const t = revealStep(toState(s), user.language);
  if (!t) throw badRequest("Try the hints first — you might crack it! 💪");
  const gained = t.xp.reduce((sum, e) => sum + e.amount, 0);
  const outgoing = await withVideos(s, t.messages);
  const { updated, tutorMsgs } = await persistTurn(s, t.state, gained, outgoing);
  const [rewards, session] = await Promise.all([
    t.xp.length ? award(studentId, t.xp.map((e) => ({ ...e, refId: id }))) : null,
    sessionView(updated),
  ]);
  return { session, newMessages: tutorMsgs.map(publicMessage), rewards };
}

export async function abandon(studentId: string, id: string) {
  const s = await loadOwned(studentId, id);
  if (s.status === "active") await prisma.tutorSession.update({ where: { id }, data: { status: "abandoned" } });
  return getSession(studentId, id);
}
