import { COURSES } from "./index";
import type { TopicData } from "./types";

/** Validates static NCTB course seed data (IDs, grades, chapters, topics, checkpoints). */
export function validateCourseCatalog(courses = COURSES): string[] {
  const errors: string[] = [];
  const courseIds = new Set<string>();

  for (const c of courses) {
    if (!c.id.trim()) errors.push("Course missing id");
    if (courseIds.has(c.id)) errors.push(`Duplicate course id: ${c.id}`);
    courseIds.add(c.id);
    if (c.grade < 3 || c.grade > 12) errors.push(`Course ${c.id} has invalid grade ${c.grade}`);
    if (!c.chapters.length) errors.push(`Course ${c.id} has no chapters`);

    c.chapters.forEach((ch, ci) => {
      if (!ch.title.trim()) errors.push(`Course ${c.id} chapter ${ci + 1} missing title`);
      if (!ch.topics.length) errors.push(`Course ${c.id} chapter ${ci + 1} has no topics`);

      ch.topics.forEach((raw, ti) => {
        const topic: TopicData = typeof raw === "string" ? { title: raw } : raw;
        const loc = `${c.id} ch${ci + 1} t${ti + 1}`;
        if (!topic.title.trim()) errors.push(`${loc} missing title`);

        for (const [qi, cp] of (topic.checkpoints ?? []).entries()) {
          if (!cp.question.trim()) errors.push(`${loc} cp${qi + 1} missing question`);
          if (!cp.explanation.trim()) errors.push(`${loc} cp${qi + 1} missing explanation`);
          if (!Array.isArray(cp.options) || cp.options.length < 2) {
            errors.push(`${loc} cp${qi + 1} must have at least 2 options`);
          } else if (cp.answerIndex < 0 || cp.answerIndex >= cp.options.length) {
            errors.push(`${loc} cp${qi + 1} answerIndex ${cp.answerIndex} out of bounds (0..${cp.options.length - 1})`);
          }
        }
      });
    });
  }
  return errors;
}
