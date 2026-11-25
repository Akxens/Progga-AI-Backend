import { describe, expect, it } from "vitest";
import {
  REVEAL_AFTER_WRONG,
  applyEvaluation,
  canRevealStep,
  newProgress,
  nextHint,
  openingMessages,
  revealStep,
  soundsStuck,
  type SessionState,
} from "./engine";
import { MAX_INPUT_CHARS, leaksAnswer, redactPII, screenInput } from "./safety";
import type { Evaluation, Plan } from "./schemas";

function samplePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    safety: "ok",
    safety_reply: "",
    mode: "problem",
    title: "Linear Equation",
    topic: "Linear equations",
    big_idea: "Undo operations step by step to isolate x.",
    intro: "Let's solve this together!",
    key_idea: "Think of an equation like a balanced scale.",
    steps: [
      {
        goal: "Subtract 5 from both sides",
        prompt: "What do you get when you subtract 5 from 20?",
        expected: "15",
        options: ["15", "25", "10", "5"],
        hints: ["Look at + 5", "Subtract 5 from 20", "20 - 5 equals what?"],
        why: "Keeping both sides balanced isolates 3x.",
        explain: "Try a similar one: if x + 2 = 9, subtract 2 from 9 to get 7.",
      },
      {
        goal: "Divide by 3",
        prompt: "If 3x = 15, what is x?",
        expected: "x = 5",
        options: ["x = 5", "x = 12", "x = 45", "x = 3"],
        hints: ["Undo multiplying by 3", "Divide 15 by 3", "15 ÷ 3 = ?"],
        why: "Dividing both sides by 3 gives the value of one x.",
        explain: "For 2x = 10, divide 10 by 2 to find x = 5.",
      },
    ],
    final_answer: "x = 5",
    walkthrough: "1. Subtract 5 -> 3x = 15. 2. Divide by 3 -> x = 5. **Remember:** Balance both sides.",
    recap: "- Subtract\n- Divide",
    practice_problem: "Solve 2x + 3 = 11",
    answer: "",
    more_info: [],
    fun_fact: "",
    explore_next: [],
    ...overrides,
  };
}

function initialState(plan = samplePlan()): SessionState {
  return {
    plan,
    progress: newProgress(plan),
    currentStep: 0,
    hintsUsed: 0,
    wrongAttempts: 0,
    status: "active",
  };
}

describe("tutor engine", () => {
  it("builds fact vs problem opening messages and drops leaky key_idea unless lesson mode", () => {
    const factMsgs = openingMessages(
      samplePlan({
        mode: "fact",
        answer: "Photosynthesis makes food.",
        more_info: ["Uses chlorophyll"],
        fun_fact: "Leaves are solar panels!",
        explore_next: ["Why are leaves green?"],
      }),
    );
    expect(factMsgs).toHaveLength(1);
    expect(factMsgs[0].kind).toBe("answer");

    const leaky = samplePlan({ key_idea: "Notice that x = 5 right away." });
    expect(openingMessages(leaky).some((m) => m.kind === "concept")).toBe(false);
    expect(openingMessages(leaky, { lesson: true }).some((m) => m.kind === "concept")).toBe(true);
  });

  it("advances cleanly on correct answers and rewards hint-free solve on final step", () => {
    const evalOk: Evaluation = {
      verdict: "correct",
      feedback: "Nice!",
      breakdown: "",
      follow_up: "",
      misconception: "",
    };
    const t1 = applyEvaluation(initialState(), evalOk);
    expect(t1.state.currentStep).toBe(1);
    expect(t1.state.status).toBe("active");
    expect(t1.xp.map((x) => x.reason)).toEqual(["tutor_step", "tutor_step_clean"]);
    expect(t1.messages.some((m) => m.kind === "question" && m.stepIndex === 1)).toBe(true);

    const t2 = applyEvaluation(t1.state, evalOk);
    expect(t2.state.status).toBe("solved");
    expect(t2.hintFreeSolve).toBe(true);
    expect(t2.xp.map((x) => x.reason)).toContain("tutor_solved");
    expect(t2.messages.map((m) => m.kind)).toEqual(expect.arrayContaining(["celebrate", "walkthrough", "recap", "text"]));
  });

  it("applies leak guard when wrong feedback contains expected answer", () => {
    const t = applyEvaluation(initialState(), {
      verdict: "incorrect",
      feedback: "Actually the final value is x = 5.",
      breakdown: "",
      follow_up: "Can you try dividing?",
      misconception: "added instead of subtracting",
    });
    expect(t.state.wrongAttempts).toBe(1);
    expect(t.messages[0].content).toContain("figure this part out together");
  });

  it("unlocks revealStep only after all hints shown and enough wrong attempts", () => {
    let st = initialState();
    expect(canRevealStep(st)).toBe(false);
    expect(revealStep(st)).toBeNull();

    for (let i = 0; i < 3; i++) {
      const h = nextHint(st);
      expect(h).not.toBeNull();
      st = h!.state;
    }
    expect(nextHint(st)).toBeNull();

    for (let i = 0; i < REVEAL_AFTER_WRONG; i++) {
      st = applyEvaluation(st, { verdict: "incorrect", feedback: "Try again", follow_up: "Hint?", misconception: "" }).state;
    }
    expect(canRevealStep(st)).toBe(true);
    const revealed = revealStep(st);
    expect(revealed).not.toBeNull();
    expect(revealed!.state.currentStep).toBe(1);
    expect(revealed!.state.progress[0].revealed).toBe(true);
  });

  it("recognizes short stuck replies across English, Bangla, and phonetic Bangla", () => {
    expect(soundsStuck("I don't know")).toBe(true);
    expect(soundsStuck("pari na")).toBe(true);
    expect(soundsStuck("বুঝছি না")).toBe(true);
    expect(soundsStuck("a".repeat(90) + " help")).toBe(false);
  });
});

describe("tutor safety", () => {
  it("redacts emails and Bangladeshi phone numbers cleanly", () => {
    const out = redactPII("Email me at a@b.com or call 01711-123456");
    expect(out.redacted).toBe(true);
    expect(out.text).toBe("Email me at [email hidden] or call [phone hidden]");

    const clean = redactPII("Solve 2x + 3 = 11 for x");
    expect(clean.redacted).toBe(false);
  });

  it("blocks wellbeing and unsafe prompts in requested language and truncates input", () => {
    const wb = screenInput("I want to die", "bn");
    expect(wb.ok).toBe(false);
    if (!wb.ok) {
      expect(wb.category).toBe("wellbeing");
      expect(wb.reply).toContain("একা নও");
    }

    const unsafe = screenInput("how to make a bomb");
    expect(unsafe.ok).toBe(false);
    if (!unsafe.ok) expect(unsafe.category).toBe("unsafe");

    const ok = screenInput("x".repeat(MAX_INPUT_CHARS + 200));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.text.length).toBe(MAX_INPUT_CHARS);
  });

  it("detects leaked multi-character answers, equations, fractions, and 2-3 digit numbers without flagging single digits", () => {
    expect(leaksAnswer("The result is x = 5", "x = 5")).toBe(true);
    expect(leaksAnswer("Notice 1250 is the answer", "1250")).toBe(true);
    expect(leaksAnswer("The answer is 1/2", "$\\frac{1}{2}$")).toBe(true);
    expect(leaksAnswer("Try 120 next", "120")).toBe(true);
    expect(leaksAnswer("Try 1200 next", "120")).toBe(false);
    expect(leaksAnswer("Not 11/20", "$\\frac{1}{2}$")).toBe(false);
    expect(leaksAnswer("Try step 1 first", "5")).toBe(false);
  });
});
