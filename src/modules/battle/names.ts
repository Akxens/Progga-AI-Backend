// Typical Bangladeshi student names, in English and Bangla, for practice rivals.
// First names and surnames are paired within the same naming tradition
// (no "Shreya Islam"), and female-only surnames (Akter, Begum…) go to girls.

type Pair = readonly [en: string, bn: string];
export type Gender = "boy" | "girl";

const FIRST: Record<Gender, { m: Pair[]; h: Pair[] }> = {
  boy: {
    m: [
      ["Rafi", "রাফি"], ["Tanvir", "তানভীর"], ["Arif", "আরিফ"], ["Sakib", "সাকিব"], ["Nafis", "নাফিস"], ["Rakib", "রাকিব"],
      ["Fahim", "ফাহিম"], ["Mahin", "মাহিন"], ["Ayaan", "আয়ান"], ["Rayhan", "রায়হান"], ["Siam", "সিয়াম"], ["Imran", "ইমরান"],
      ["Tahmid", "তাহমিদ"], ["Shihab", "শিহাব"], ["Nayeem", "নাঈম"], ["Sabbir", "সাব্বির"], ["Rifat", "রিফাত"], ["Fardin", "ফারদিন"],
      ["Zarif", "জারিফ"], ["Ishraq", "ইশরাক"], ["Tamim", "তামিম"], ["Abrar", "আবরার"], ["Junaid", "জুনায়েদ"], ["Mehedi", "মেহেদী"],
      ["Sajid", "সাজিদ"], ["Hasib", "হাসিব"], ["Tasin", "তাসিন"], ["Labib", "লাবিব"], ["Adnan", "আদনান"], ["Shafin", "শাফিন"], ["Riyad", "রিয়াদ"],
    ],
    h: [["Arnob", "অর্ণব"], ["Pranto", "প্রান্ত"], ["Sourav", "সৌরভ"], ["Anik", "অনিক"], ["Joy", "জয়"], ["Rudro", "রুদ্র"], ["Shuvo", "শুভ"], ["Dipto", "দীপ্ত"]],
  },
  girl: {
    m: [
      ["Nusrat", "নুসরাত"], ["Ayesha", "আয়েশা"], ["Sadia", "সাদিয়া"], ["Tasnim", "তাসনিম"], ["Farhana", "ফারহানা"], ["Mim", "মিম"],
      ["Raisa", "রাইসা"], ["Anika", "আনিকা"], ["Sumaiya", "সুমাইয়া"], ["Lamia", "লামিয়া"], ["Nabila", "নাবিলা"], ["Tahsin", "তাহসিন"],
      ["Jannat", "জান্নাত"], ["Maliha", "মালিহা"], ["Samiha", "সামিহা"], ["Nowshin", "নওশিন"], ["Fariha", "ফারিহা"], ["Tanjila", "তানজিলা"],
      ["Afia", "আফিয়া"], ["Zara", "জারা"], ["Rumana", "রুমানা"], ["Sanjida", "সানজিদা"], ["Adiba", "আদিবা"], ["Labiba", "লাবিবা"],
      ["Rodela", "রোদেলা"], ["Nazia", "নাজিয়া"], ["Meherin", "মেহেরিন"], ["Bushra", "বুশরা"], ["Orin", "অরিন"], ["Purnota", "পূর্ণতা"],
    ],
    h: [["Prova", "প্রভা"], ["Ishita", "ইশিতা"], ["Tithi", "তিথি"], ["Shreya", "শ্রেয়া"], ["Anusha", "অনুশা"], ["Mithila", "মিথিলা"], ["Puja", "পূজা"], ["Bristi", "বৃষ্টি"]],
  },
};

const LAST = {
  m: [
    ["Ahmed", "আহমেদ"], ["Hossain", "হোসেন"], ["Rahman", "রহমান"], ["Islam", "ইসলাম"], ["Hasan", "হাসান"], ["Khan", "খান"],
    ["Karim", "করিম"], ["Siddique", "সিদ্দিকী"], ["Haque", "হক"], ["Alam", "আলম"], ["Kabir", "কবির"], ["Mahmud", "মাহমুদ"],
    ["Ferdous", "ফেরদৌস"], ["Rashid", "রশিদ"], ["Sheikh", "শেখ"], ["Bhuiyan", "ভূঁইয়া"], ["Mostafa", "মোস্তফা"],
  ] as Pair[],
  mGirl: [["Akter", "আক্তার"], ["Begum", "বেগম"], ["Sultana", "সুলতানা"], ["Jahan", "জাহান"], ["Nahar", "নাহার"]] as Pair[],
  mBoy: [["Uddin", "উদ্দিন"], ["Mia", "মিয়া"]] as Pair[],
  h: [["Das", "দাস"], ["Roy", "রায়"], ["Saha", "সাহা"], ["Paul", "পাল"], ["Biswas", "বিশ্বাস"], ["Barua", "বড়ুয়া"], ["Ghosh", "ঘোষ"], ["Dey", "দে"]] as Pair[],
  shared: [["Chowdhury", "চৌধুরী"], ["Sarker", "সরকার"], ["Talukder", "তালুকদার"], ["Majumder", "মজুমদার"]] as Pair[],
};

export interface RivalName {
  name: string;
  nameBn: string;
  gender: Gender;
}

/** A believable student name. `rand` lets callers make it repeatable (seeded). */
export function makeName(rand: () => number = Math.random, gender: Gender = rand() < 0.5 ? "boy" : "girl"): RivalName {
  const pick = <T>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)];
  const hindu = rand() < 0.15;
  const first = pick(FIRST[gender][hindu ? "h" : "m"]);
  const lastPool = hindu ? [...LAST.h, ...LAST.shared] : [...LAST.m, ...LAST.shared, ...(gender === "girl" ? LAST.mGirl : LAST.mBoy)];
  const last = pick(lastPool);
  return { name: `${first[0]} ${last[0]}`, nameBn: `${first[1]} ${last[1]}`, gender };
}

/** Small, fast, seedable random numbers (mulberry32), keyed by a string. */
export function seededRandom(key: string): () => number {
  let h = 1779033703 ^ key.length;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
