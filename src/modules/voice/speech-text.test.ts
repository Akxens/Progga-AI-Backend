import { describe, expect, it } from "vitest";
import { detectLang, mathToWords, toSpokenText } from "./speech-text";

describe("speech-text", () => {
  it("detects English vs Bangla from script characters", () => {
    expect(detectLang("Solve $2x + 3 = 11$")).toBe("en");
    expect(detectLang("সমাধান করো: $2x + 3 = 11$")).toBe("bn");
  });

  it("converts LaTeX math expressions into English and Bangla words", () => {
    expect(mathToWords("\\frac{3}{4} + x^2 = \\sqrt{16}", "en")).toBe("3 over 4 plus x squared equals the square root of 16");
    expect(mathToWords("\\frac{1}{2} + x^3 \\approx 5", "bn")).toBe("1 ভাগ 2 যোগ x এর ঘন প্রায় 5");
    expect(mathToWords("90^\\circ \\neq 180^\\circ", "en")).toBe("90 degrees is not equal to 180 degrees");
    expect(mathToWords("\\unknowncmd x + 1", "en")).toBe("x plus 1");
  });

  it("strips Markdown/emoji, expands inline math, and caps output cleanly at MAX_CHARS", () => {
    const spoken = toSpokenText("## Great job! 🎉\n- You solved **$2x+3=11$**\n- See [notes](https://example.com)");
    expect(spoken).not.toContain("#");
    expect(spoken).not.toContain("*");
    expect(spoken).not.toContain("🎉");
    expect(spoken).not.toContain("https://example.com");
    expect(spoken).toContain("2x plus 3 equals 11.");

    const longInput = Array.from({ length: 120 }, (_, i) => `Sentence number ${i} explains the next algebraic step clearly.`).join("\n");
    const clipped = toSpokenText(longInput);
    expect(clipped.length).toBeLessThanOrEqual(1500);
    expect(clipped.endsWith(".")).toBe(true);
  });
});
