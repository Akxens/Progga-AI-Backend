// Battle Arena leagues. Every class has its own ladder: a Class 8 student only
// meets Class 8 rivals and climbs the Class 8 league. Trophy thresholds follow
// the classic trophy-road layout (Bronze III at 400 … Legend I at 6000).

export type LeagueFamily = "unranked" | "bronze" | "silver" | "gold" | "crystal" | "master" | "champion" | "titan" | "legend";

export interface League {
  id: string; // bronze-3
  family: LeagueFamily;
  division: 0 | 1 | 2 | 3; // III = 3 (entry) … I = 1; 0 for Unranked
  name: string; // "Bronze League III"
  min: number; // trophies needed
  difficulty: number; // 1..6 — how hard the battle questions are
}

const FAMILIES: [LeagueFamily, string, number[], number][] = [
  // family, name, [III, II, I] thresholds, question difficulty
  ["bronze", "Bronze", [400, 500, 600], 1],
  ["silver", "Silver", [800, 1000, 1200], 2],
  ["gold", "Gold", [1400, 1600, 1800], 3],
  ["crystal", "Crystal", [2000, 2200, 2400], 4],
  ["master", "Master", [2600, 2800, 3000], 5],
  ["champion", "Champion", [3200, 3500, 3800], 6],
  ["titan", "Titan", [4100, 4400, 4700], 6],
  ["legend", "Legend", [5000, 5500, 6000], 6],
];

const ROMAN = ["", "I", "II", "III"] as const;

export const LEAGUES: League[] = [
  { id: "unranked", family: "unranked", division: 0, name: "Unranked", min: 0, difficulty: 1 },
  ...FAMILIES.flatMap(([family, name, mins, difficulty]) =>
    mins.map((min, i) => {
      const division = (3 - i) as 3 | 2 | 1;
      return { id: `${family}-${division}`, family, division, name: `${name} League ${ROMAN[division]}`, min, difficulty };
    }),
  ),
];

export const FAMILY_ORDER: LeagueFamily[] = ["unranked", "bronze", "silver", "gold", "crystal", "master", "champion", "titan", "legend"];

/** Trophy span of a whole league family (all its divisions). Legend has no ceiling, so it gets a soft one. */
export function familyRange(family: LeagueFamily): { min: number; max: number } {
  const own = LEAGUES.filter((l) => l.family === family);
  const after = LEAGUES.find((l) => l.min > own[own.length - 1].min);
  return { min: own[0].min, max: after ? after.min - 1 : own[own.length - 1].min + 1200 };
}

export function leagueFor(trophies: number): League {
  let league = LEAGUES[0];
  for (const l of LEAGUES) if (trophies >= l.min) league = l;
  return league;
}

export function nextLeague(trophies: number): League | null {
  return LEAGUES.find((l) => l.min > trophies) ?? null;
}

/** Question difficulty for a battle between these trophy counts. */
export function battleDifficulty(...trophies: number[]): number {
  const avg = trophies.reduce((s, t) => s + t, 0) / Math.max(1, trophies.length);
  return leagueFor(avg).difficulty;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Trophies at stake when `winner` beats `loser`: the loser hands exactly this
 * many to the winner. Equal rivals: 30. Beating a much stronger rival pays up
 * to 59; beating a much weaker one pays as little as 1.
 */
export function trophyStake(winner: number, loser: number): number {
  const expected = 1 / (1 + 10 ** ((loser - winner) / 400));
  return clamp(Math.round(60 * (1 - expected)), 1, 59);
}

/**
 * Trophy change for one player, worked out from both players' trophies before
 * the battle so the two sides always mirror each other (+N for the winner, −N
 * for the loser). A loser can't drop below zero; the winner still gets the full stake.
 */
export function trophyChange(mine: number, theirs: number, result: "win" | "loss" | "draw"): number {
  if (result === "draw") return 0;
  if (result === "win") return trophyStake(mine, theirs);
  return -Math.min(trophyStake(theirs, mine), mine);
}

/** What a student sees about a league (and their place in it). */
export function leagueView(trophies: number) {
  const league = leagueFor(trophies);
  const next = nextLeague(trophies);
  return {
    league,
    next,
    progress: next ? (trophies - league.min) / (next.min - league.min) : 1,
  };
}
