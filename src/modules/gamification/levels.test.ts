import { describe, expect, it } from "vitest";
import { MAX_LEVEL, levelFromXp, levelProgress, levelTitle, xpForLevel, xpToNext } from "./levels";

describe("levels", () => {
  it("starts at level 1 and caps at 150", () => {
    expect(levelFromXp(0)).toBe(1);
    expect(levelFromXp(-5)).toBe(1);
    expect(levelFromXp(xpForLevel(MAX_LEVEL))).toBe(MAX_LEVEL);
    expect(levelFromXp(Number.MAX_SAFE_INTEGER)).toBe(MAX_LEVEL);
  });

  it("asks for more XP at every level", () => {
    for (let l = 1; l < MAX_LEVEL - 1; l++) expect(xpToNext(l + 1)).toBeGreaterThanOrEqual(xpToNext(l));
    expect(xpToNext(1)).toBe(60);
  });

  it("lands exactly on level boundaries", () => {
    for (const l of [2, 10, 50, 100, 149]) {
      expect(levelFromXp(xpForLevel(l))).toBe(l);
      expect(levelFromXp(xpForLevel(l) - 1)).toBe(l - 1);
    }
  });

  it("names every level and reports a full bar at the cap", () => {
    expect(levelTitle(1)).toBe("Tiny Tadpole");
    expect(levelTitle(55)).toBe("Brainy Banana");
    expect(levelTitle(150)).toBe("Brain Emperor");
    const top = levelProgress(xpForLevel(MAX_LEVEL) + 999);
    expect(top).toMatchObject({ level: 150, maxed: true, progress: 1 });
  });
});
