/* eslint-disable no-console */
import { COURSES } from "./courses";
import { validateCourseCatalog } from "./courses/validate";

const errors = validateCourseCatalog(COURSES);
if (errors.length) {
  console.error("Course seed validation failed:");
  for (const e of errors) console.error(` - ${e}`);
  process.exit(1);
}
const chapters = COURSES.reduce((s, c) => s + c.chapters.length, 0);
const topics = COURSES.reduce((s, c) => s + c.chapters.reduce((n, ch) => n + ch.topics.length, 0), 0);
console.log(`Course catalog valid: ${COURSES.length} courses, ${chapters} chapters, ${topics} topics`);
