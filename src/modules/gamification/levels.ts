// Levels 1–150, trophy-road style: each level costs a bit more XP than the one
// before. Level L → L+1 needs 40 + 15·L + 0.12·L² XP (rounded to 10), so
// 1→2 is 60 XP (one solved problem), 49→50 about 1,060, 149→150 about 4,900.
// Roughly: level 10 in a few days, 50 in a few months, 150 in a couple of years.

export const MAX_LEVEL = 150;

/** XP needed to go from `level` to `level + 1`. */
export function xpToNext(level: number): number {
  return Math.round((40 + 15 * level + 0.12 * level * level) / 10) * 10;
}

// XP_AT[L] = total XP at which level L starts (XP_AT[1] = 0).
const XP_AT: number[] = [0, 0];
for (let l = 1; l < MAX_LEVEL; l++) XP_AT.push(XP_AT[l] + xpToNext(l));

export function xpForLevel(level: number): number {
  return XP_AT[Math.min(MAX_LEVEL, Math.max(1, level))];
}

export function levelFromXp(xp: number): number {
  let lo = 1;
  let hi = MAX_LEVEL;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (XP_AT[mid] <= xp) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// One funny title per ten levels, from first wobbly steps to the very top.
// The English text doubles as the translation key (levelTitles.* in the app).
const TITLES: [number, string][] = [
  [1, "Tiny Tadpole"],
  [10, "Pencil Chewer"],
  [20, "Homework Hunter"],
  [30, "Curious Cat"],
  [40, "Puzzle Pirate"],
  [50, "Brainy Banana"],
  [60, "Quiz Ninja"],
  [70, "Formula Fox"],
  [80, "Rocket Scholar"],
  [90, "Wizard of Why"],
  [100, "Professor Kola"],
  [110, "Genius Gorilla"],
  [120, "Galaxy Brain"],
  [130, "Legendary Owl"],
  [140, "Supreme Sage"],
  [150, "Brain Emperor"],
];

export function levelTitle(level: number): string {
  let title = TITLES[0][1];
  for (const [min, name] of TITLES) if (level >= min) title = name;
  return title;
}

export function levelProgress(xp: number) {
  const level = levelFromXp(xp);
  const maxed = level >= MAX_LEVEL;
  const floor = xpForLevel(level);
  const ceil = maxed ? floor : xpForLevel(level + 1);
  return {
    level,
    title: levelTitle(level),
    xp,
    levelStartXp: floor,
    nextLevelXp: ceil,
    progress: maxed ? 1 : (xp - floor) / (ceil - floor),
    maxed,
  };
}
