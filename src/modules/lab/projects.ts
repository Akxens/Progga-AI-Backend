// Innovation Lab: learn a skill by building something real. Each sample project
// carries the real data the student builds with; the AI turns it into a
// step-by-step mentor session (the same stepper as Ask Progga). Prices are
// approximate Dhaka retail prices; measurements are typical for the setup.

type Text = { en: string; bn: string };

export interface LabProject {
  id: string;
  emoji: string;
  color: string;
  /** subject the session is filed under (history, related videos) */
  subject: string;
  /** youngest class it suits */
  minGrade: number;
  minutes: number;
  title: Text;
  skill: Text;
  pitch: Text;
  learn: { en: string[]; bn: string[] };
  /** scenario + real data for the planner (English; the plan is written in the student's language) */
  brief: string;
}

export const LAB_PROJECTS: LabProject[] = [
  {
    id: "pitha-shop",
    emoji: "🥮",
    color: "#F97316",
    subject: "ict",
    minGrade: 6,
    minutes: 25,
    title: { en: "A website for Ammu's Pitha Shop", bn: "আম্মুর পিঠার দোকানের ওয়েবসাইট" },
    skill: { en: "HTML basics", bn: "HTML-এর শুরু" },
    pitch: {
      en: "Your mother sells winter pitha. Build her shop a real web page with a menu and a price table.",
      bn: "আম্মু শীতের পিঠা বিক্রি করেন। তাঁর দোকানের জন্য মেনু আর দামের টেবিলসহ একটা আসল ওয়েব পেজ বানাও।",
    },
    learn: {
      en: ["Page structure: html, head, body", "Headings, paragraphs and lists", "A price table and a button link"],
      bn: ["পেজের কাঠামো: html, head, body", "হেডিং, প্যারাগ্রাফ আর লিস্ট", "দামের টেবিল আর বাটন লিংক"],
    },
    brief: [
      "The student builds a one-page website in plain HTML (no CSS or JavaScript needed) for their mother's home pitha business.",
      "Shop name: Ammu's Pitha Ghor (আম্মুর পিঠা ঘর). Tagline: Fresh winter pitha, made at home with love.",
      "Open: every day 4 pm to 9 pm, November to February.",
      "Menu (price in taka): Bhapa Pitha ৳20 per piece; Chitoi Pitha ৳15 per piece; Patishapta ৳25 per piece; Puli Pitha ৳20 per piece; Dudh Chitoi ৳40 per bowl.",
      "Today's special: Patishapta with nolen gur.",
      "Orders: a 'Call to order' link styled as a button. Do NOT use any real phone number; use href=\"#order\".",
      "Milestones to cover: page skeleton (<!DOCTYPE html>, html, head with title, body) → h1 shop name → p tagline and opening hours → ul list of pitha names → table with Pitha and Price columns → img with an alt text (src can be pitha.jpg) → a link for ordering.",
    ].join("\n"),
  },
  {
    id: "bazar-budget",
    emoji: "🛒",
    color: "#22C493",
    subject: "math",
    minGrade: 5,
    minutes: 20,
    title: { en: "Our family's monthly bazar budget", bn: "আমাদের পরিবারের মাসিক বাজার বাজেট" },
    skill: { en: "Totals, percentages & budgeting", bn: "যোগফল, শতকরা ও বাজেট" },
    pitch: {
      en: "Plan a real month of groceries with Dhaka bazar prices. Will ৳6,000 be enough?",
      bn: "ঢাকার বাজারদর দিয়ে এক মাসের বাজারের হিসাব করো। ৬,০০০ টাকায় কি হবে?",
    },
    learn: {
      en: ["Price × quantity = cost", "Grand total and savings", "What share of the budget is each item (%)"],
      bn: ["দাম × পরিমাণ = খরচ", "মোট খরচ আর সঞ্চয়", "বাজেটের কত শতাংশ কোন জিনিসে (%)"],
    },
    brief: [
      "The student plans one month of groceries for a family of four and checks it against a budget of ৳6,000.",
      "Approximate Dhaka prices and monthly quantities (say once that real prices change):",
      "Rice (miniket) ৳75/kg × 25 kg = ৳1,875; Masur dal ৳110/kg × 3 kg = ৳330; Soybean oil ৳175/litre × 4 litres = ৳700; Potatoes ৳40/kg × 8 kg = ৳320; Onions ৳80/kg × 4 kg = ৳320; Eggs ৳140/dozen × 4 dozen = ৳560; Chicken (broiler) ৳190/kg × 4 kg = ৳760.",
      "Grand total = ৳4,865. Money left from ৳6,000 = ৳1,135. Rice is 1,875 ÷ 6,000 = 31.25% of the budget.",
      "What-if: if every price goes up by 10%, the total becomes ৳5,351.50, still within budget, leaving ৳648.50.",
      "Milestones: cost of one item (price × quantity) → a few more line costs → grand total → money left → percentage of the budget for rice → the 10% price rise what-if → one smart saving idea.",
    ].join("\n"),
  },
  {
    id: "rooftop-garden",
    emoji: "🌱",
    color: "#10B981",
    subject: "science",
    minGrade: 4,
    minutes: 20,
    title: { en: "Plan a rooftop vegetable garden", bn: "ছাদে সবজি বাগানের পরিকল্পনা" },
    skill: { en: "How plants grow", bn: "গাছ কীভাবে বাড়ে" },
    pitch: {
      en: "Turn a 3 m × 4 m roof into a garden: pick plants for the sunlight you have and plan your harvest.",
      bn: "৩ মি × ৪ মি ছাদকে বাগান বানাও: রোদ বুঝে গাছ বাছো আর কবে ফসল তুলবে তা ঠিক করো।",
    },
    learn: {
      en: ["What plants need: light, water, air, soil", "Photosynthesis in simple words", "Area and a harvest timeline"],
      bn: ["গাছের যা লাগে: আলো, পানি, বাতাস, মাটি", "সহজ কথায় সালোকসংশ্লেষণ", "ক্ষেত্রফল আর ফসল তোলার সময়সূচি"],
    },
    brief: [
      "The student plans a small winter vegetable garden in pots on a Dhaka rooftop.",
      "Roof space: 3 m × 4 m = 12 square metres. Direct sunlight: about 6 hours a day.",
      "Plants (typical): Lal shak / red amaranth: harvest in 25-30 days, needs 4-6 h sun. Tomato: 60-70 days, needs 6-8 h sun. Green chilli: 75-90 days, needs 6 h sun. Pui shak / Malabar spinach: 40-50 days, climbs, needs support.",
      "Each pot needs about 1 litre of water a day in winter. Plan 10 pots.",
      "Milestones: what every plant needs → why leaves need sunlight (photosynthesis: light + water + carbon dioxide → food + oxygen) → roof area → which plants suit 6 hours of sun → water needed per day for 10 pots (10 litres) → which crop is ready first and when → a simple harvest plan.",
    ].join("\n"),
  },
  {
    id: "rainfall-chart",
    emoji: "🌧️",
    color: "#3BA7FF",
    subject: "math",
    minGrade: 7,
    minutes: 20,
    title: { en: "Dhaka's rainfall in a chart", bn: "চার্টে ঢাকার বৃষ্টিপাত" },
    skill: { en: "Bar charts, mean, median & range", bn: "বার চার্ট, গড়, মধ্যমা ও পরিসর" },
    pitch: {
      en: "Use a year of Dhaka rainfall data to find the monsoon, draw a bar chart and work out the averages.",
      bn: "ঢাকার এক বছরের বৃষ্টির তথ্য দিয়ে বর্ষাকাল খুঁজে বের করো, বার চার্ট আঁকো আর গড় বের করো।",
    },
    learn: {
      en: ["Reading and drawing a bar chart", "Mean, median and range", "What the data says about the monsoon"],
      bn: ["বার চার্ট পড়া ও আঁকা", "গড়, মধ্যমা আর পরিসর", "তথ্য থেকে বর্ষাকাল বোঝা"],
    },
    brief: [
      "The student analyses approximate long-term average monthly rainfall in Dhaka, in millimetres (say once that these are rounded averages):",
      "Jan 7, Feb 28, Mar 55, Apr 140, May 290, Jun 360, Jul 375, Aug 320, Sep 300, Oct 175, Nov 30, Dec 10.",
      "Total = 2,090 mm. Mean = 2,090 ÷ 12 ≈ 174.2 mm. Sorted: 7, 10, 28, 30, 55, 140, 175, 290, 300, 320, 360, 375, so median = (140 + 175) ÷ 2 = 157.5 mm. Range = 375 − 7 = 368 mm. Wettest month: July. Driest: January. June to September together = 1,355 mm, about 65% of the year's rain.",
      "Milestones: read the wettest and driest month → choose a scale for the bar chart's vertical axis → total for the year → mean → median (sort first) → range → what share falls in the monsoon (June-September) and what that means for farmers.",
    ].join("\n"),
  },
  {
    id: "cricket-flowchart",
    emoji: "🏏",
    color: "#8B5CF6",
    subject: "ict",
    minGrade: 6,
    minutes: 20,
    title: { en: "A cricket chase calculator", bn: "ক্রিকেট রান-তাড়ার ক্যালকুলেটর" },
    skill: { en: "Algorithms & flowcharts", bn: "অ্যালগরিদম ও ফ্লোচার্ট" },
    pitch: {
      en: "Design the algorithm a scoreboard uses: run rate, required rate and who wins, drawn as a flowchart.",
      bn: "স্কোরবোর্ড যেভাবে হিসাব করে সেই অ্যালগরিদম বানাও: রান রেট, প্রয়োজনীয় রান রেট আর কে জিতবে, ফ্লোচার্টে।",
    },
    learn: {
      en: ["Inputs, process and output", "Flowchart symbols and decisions (if/else)", "Writing simple pseudocode"],
      bn: ["ইনপুট, প্রসেস আর আউটপুট", "ফ্লোচার্টের চিহ্ন আর সিদ্ধান্ত (যদি/নইলে)", "সহজ সিউডোকোড লেখা"],
    },
    brief: [
      "The student designs the algorithm for a T20 chase calculator in a school match (made-up teams: Padma Tigers bat first, Meghna Kings chase).",
      "Padma Tigers scored 168 in 20 overs. Run rate = 168 ÷ 20 = 8.4. Target = 169.",
      "After 12 overs Meghna Kings are 98. Runs needed = 169 − 98 = 71. Overs left = 8. Required run rate = 71 ÷ 8 = 8.875 ≈ 8.88.",
      "Decision: if the chasing team's runs ≥ target, they win; else if overs are finished, the first team wins; else keep playing.",
      "Milestones: name the inputs (runs, overs) → the process for run rate → the target → runs needed and overs left → required run rate → the decision box (diamond) with if/else → the full flowchart in order (start oval → input parallelogram → process rectangle → decision diamond → output → end) → pseudocode.",
      "Flowcharts are drawn in words or as a numbered list of boxes; pseudocode goes in a code fence.",
    ].join("\n"),
  },
  {
    id: "solar-lamp",
    emoji: "💡",
    color: "#F5B819",
    subject: "science",
    minGrade: 8,
    minutes: 25,
    title: { en: "A solar lamp for load-shedding", bn: "লোডশেডিংয়ের জন্য সোলার ল্যাম্প" },
    skill: { en: "Circuits, Ohm's law & energy", bn: "বর্তনী, ওহমের সূত্র ও শক্তি" },
    pitch: {
      en: "Design a small solar lamp with real parts: work out the resistor and how many hours of light you get.",
      bn: "আসল যন্ত্রাংশ দিয়ে ছোট একটা সোলার ল্যাম্পের নকশা করো: রোধ কত লাগবে আর কত ঘণ্টা আলো পাবে বের করো।",
    },
    learn: {
      en: ["A complete circuit, series and parallel", "Ohm's law: V = I × R", "Power, battery capacity and hours of light"],
      bn: ["পূর্ণ বর্তনী, শ্রেণি ও সমান্তরাল", "ওহমের সূত্র: V = I × R", "ক্ষমতা, ব্যাটারির ধারণক্ষমতা আর আলোর ঘণ্টা"],
    },
    brief: [
      "The student designs (on paper) a small solar lamp for evening study during load-shedding. It is low-voltage and safe; never connect anything to mains electricity, and build only with an adult.",
      "Parts: a 6 V, 3 W solar panel; a 3.7 V, 2000 mAh rechargeable battery with a charging module; 3 white LEDs, each needing 3.0 V and 20 mA; one resistor per LED; a switch.",
      "Each LED with its own resistor is connected in parallel across the battery. Resistor = (3.7 − 3.0) V ÷ 0.020 A = 35 Ω; the nearest standard value above is 39 Ω.",
      "Total current = 3 × 20 mA = 60 mA. Light time on a full battery ≈ 2000 mAh ÷ 60 mA ≈ 33 hours (less in practice).",
      "Panel current in full sun ≈ 3 W ÷ 6 V = 0.5 A.",
      "Milestones: what makes a complete circuit → why LEDs go in parallel here → voltage left for the resistor (0.7 V) → resistor value with V = I × R → pick a standard resistor → total current → hours of light → the panel's current in sunlight.",
    ].join("\n"),
  },
  {
    id: "water-filter",
    emoji: "💧",
    color: "#0EA5E9",
    subject: "science",
    minGrade: 5,
    minutes: 15,
    title: { en: "A pond-water filter from a bottle", bn: "বোতল দিয়ে পুকুরের পানির ফিল্টার" },
    skill: { en: "Mixtures & filtration", bn: "মিশ্রণ ও পরিস্রাবণ" },
    pitch: {
      en: "Layer gravel, sand and charcoal in a bottle to clean muddy water, and learn why it still isn't safe to drink.",
      bn: "বোতলে নুড়ি, বালি আর কাঠকয়লা সাজিয়ে ঘোলা পানি পরিষ্কার করো, আর জানো কেন তবুও তা পানের উপযোগী নয়।",
    },
    learn: {
      en: ["Mixtures and how to separate them", "Why each filter layer is there", "Why we must still boil water"],
      bn: ["মিশ্রণ আর তা আলাদা করার উপায়", "ফিল্টারের প্রতিটি স্তর কেন", "কেন তবুও পানি ফোটাতে হয়"],
    },
    brief: [
      "The student builds a simple filter from a cut 1.5 litre plastic bottle (an adult does the cutting), turned upside down, for muddy pond water.",
      "Layers from bottom (the neck, covered with a clean cotton cloth) to top: cloth → 3 cm charcoal (crushed, from the kitchen) → 5 cm fine sand → 5 cm coarse sand → 5 cm small gravel (nuri pathor).",
      "Test: pour 500 ml of muddy water; compare its colour before and after.",
      "Safety fact: filtering removes mud and some smell, but NOT germs. The water must be boiled for at least 1 minute (or treated) before drinking; filtered pond water should never be drunk as it is.",
      "Milestones: muddy water is a mixture → which parts are big and which are tiny → why gravel goes on top → what sand traps → what charcoal does → why the cloth → why the clear water is still not safe → boiling as the final step.",
    ].join("\n"),
  },
];

export const labProject = (id: string) => LAB_PROJECTS.find((p) => p.id === id);

/** What the app shows on a project card (the planner brief stays on the server). */
export function publicProject(p: LabProject) {
  const { brief: _brief, ...card } = p;
  return card;
}
