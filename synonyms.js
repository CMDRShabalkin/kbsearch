// Синонимы и сокращения для английских запросов. Ключ -> список альтернатив (слова или фразы).
// Дополняйте под свои документы: после правки обновите версию кэша в sw.js.
export const SYNONYMS = {
  takeoff: ["take off", "take-off"],
  knots: ["kt", "kts"],
  kt: ["knots", "kts"],
  false: ["spurious", "nuisance", "erroneous"],
  spurious: ["false", "nuisance", "erroneous"],
  nuisance: ["false", "spurious"],
  warning: ["alert", "warn"],
  alert: ["warning", "caution"],
  caution: ["alert"],
  landing: ["ldg"],
  goaround: ["go around", "go-around", "g/a"],
  windshear: ["wind shear"],
  nosewheel: ["nose wheel", "n/w", "nlg"],
  cabin: ["cab"],
  altitude: ["alt"],
  engine: ["eng"],
  approach: ["appr"],
  temperature: ["temp"],
  pressure: ["press"],
  hydraulic: ["hyd"],
  electrical: ["elec"],
  emergency: ["emer"],
  failure: ["fail", "fault"],
  fault: ["failure", "fail"],
  speed: ["spd"],
  runway: ["rwy"],
  aerodrome: ["airport"],
  airport: ["aerodrome"],
  gpws: ["egpws", "taws", "t2cas"],
  taws: ["gpws", "egpws"],
  tcas: ["acas", "t2cas"],
  acas: ["tcas"],
  fl: ["flight level"],
  atc: ["air traffic control", "controller"],
  apu: ["auxiliary power"],
  fcom: ["flight crew operating manual"],
  qrh: ["quick reference handbook"],
  warm: ["warm-up", "warmup", "warming"],
  warmup: ["warm up", "warm-up", "warming"],
  stabilized: ["stabilised", "stabilization", "stabilisation"],
  stabilised: ["stabilized", "stabilization", "stabilisation"],
  sensor: ["probe", "transducer", "tachometer"],
  tire: ["tyre"],
  tyre: ["tire"],
  oxygen: ["o2"],
  extinguisher: ["extinguishing", "bottle"],
  mel: ["minimum equipment list"],
  rvr: ["runway visual range"],
  ils: ["instrument landing system"],
};

// Слова, которые в запросе склеиваются: "take off" / "take-off" -> takeoff и т.п.
export const JOINERS = [
  [/\btake[\s-]off\b/gi, "takeoff"],
  [/\bgo[\s-]around\b/gi, "goaround"],
  [/\bwind[\s-]shear\b/gi, "windshear"],
  [/\bnose[\s-]wheel\b/gi, "nosewheel"],
  [/\bwarm[\s-]up\b/gi, "warmup"],
];

export const STOP = new Set(
  ("a an the of to in on for and or is are was were be been being what when where how do does did i we my our you your " +
   "with at by if it its as from that this these those can could must should shall would will may might not no " +
   "than then there their them they which who whom whose why into onto over under about after before during " +
   "please tell me show give explain mean means long much many get make need needed right correct correctly properly " +
   "action actions do done doing procedure procedures plus minus always").split(" ")
);
// "after"/"before" полезны в авиации (before takeoff), поэтому их оставляем.
STOP.delete("after");
STOP.delete("before");
STOP.delete("not");
STOP.delete("procedure");
STOP.delete("procedures");
STOP.delete("no");

// ---------- Группы равнозначных терминов (в разных мануалах используются разные слова) ----------
// Члены группы взаимозаменяемы в поиске по словам, а в смысловом поиске добавляются к запросу.
// Свои группы можно вносить в приложении: ☰ -> "Словарь синонимов" (строка вида: captain = pic = pilot in command).
export const EQUIV = [
  ["captain", "pic", "pilot in command", "commander", "capt", "cpt"],
  ["first officer", "fo", "f/o", "co-pilot", "copilot"],
  ["pilot flying", "pf"],
  ["pilot monitoring", "pm", "pnf", "pilot not flying"],
  ["second in command", "sic"],
  ["flight crew", "cockpit crew", "flight deck crew"],
  ["cabin crew", "flight attendant", "cabin attendant"],
  ["minima", "minimums"],
  ["weight", "mass"],
  ["maximum takeoff weight", "mtow", "mtom", "maximum takeoff mass"],
  ["maximum landing weight", "mlw", "mlm", "maximum landing mass"],
  ["visibility", "vis"],
  ["runway visual range", "rvr"],
  ["converted meteorological visibility", "cmv"],
  ["alternate", "altn", "alternate aerodrome", "alternate airport"],
  ["flight duty period", "fdp"],
  ["flight time limitations", "ftl"],
  ["rescue and fire fighting", "rffs", "arff", "fire fighting category", "fire category", "rff"],
  ["edto", "etops", "extended diversion time operations"],
  ["minimum equipment list", "mel"],
  ["standard operating procedures", "sop", "sops"],
  ["quick reference handbook", "qrh"],
  ["low visibility procedures", "lvp"],
  ["low visibility takeoff", "lvto"],
  ["decision height", "dh", "decision altitude", "da"],
  ["autopilot", "ap", "automatic pilot"],
  ["autothrust", "a/thr", "athr", "autothrottle"],
  ["flight director", "fd"],
  ["sterile cockpit", "sterile flight deck"],
  ["seatbelt", "seat belt"],
  ["checklist", "check list"],
  ["crosswind", "cross wind"],
  ["tailwind", "tail wind"],
  ["headwind", "head wind"],
  ["goaround", "go around", "missed approach"],
  ["destination", "dest"],
  ["airport", "aerodrome"],
  ["takeoff", "take off"],
];

const BASE_SYN = JSON.parse(JSON.stringify(SYNONYMS));
const BASE_JOIN = JOINERS.slice();
let groups = EQUIV.slice();
const normTerm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

function rebuild() {
  for (const k of Object.keys(SYNONYMS)) delete SYNONYMS[k];
  for (const [k, v] of Object.entries(BASE_SYN)) SYNONYMS[k] = v.slice();
  JOINERS.length = 0;
  JOINERS.push(...BASE_JOIN);
  for (const g of groups) {
    const members = [...new Set(g.map(normTerm).filter(Boolean))];
    const singles = members.filter((m) => !m.includes(" "));
    const canon = singles[0];
    for (const t of singles) {
      const cur = SYNONYMS[t] || (SYNONYMS[t] = []);
      for (const m of members) if (m !== t && !cur.includes(m)) cur.push(m);
    }
  }
}

// Применить свои группы: текст, по строке на группу, члены через "=". Строки с # - комментарии.
export function setUserEquiv(text) {
  const user = (text || "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("=").map((x) => x.trim()).filter(Boolean)).filter((g) => g.length >= 2);
  groups = EQUIV.concat(user);
  rebuild();
  return user.length;
}

// Для смыслового поиска: к запросу добавляются равнозначные названия ("captain" -> "captain (pic, pilot in command)")
export function equivExpand(q) {
  const low = " " + normTerm(q) + " ";
  const extra = [];
  for (const g of groups) {
    const members = g.map(normTerm).filter(Boolean);
    if (members.some((m) => low.includes(" " + m + " "))) {
      for (const m of members) if (!low.includes(" " + m + " ") && extra.length < 12) extra.push(m);
    }
  }
  return extra.length ? q + " (" + extra.join(", ") + ")" : q;
}

rebuild();

// Многословные члены групп, найденные в запросе подряд ("first officer"): каждому слову фразы
// добавляются альтернативы - остальные члены группы ("fo", "f/o", "co-pilot"...). Возвращает {слово: [альтернативы]}.
export function equivPhraseAlts(toks) {
  const out = {};
  const s = toks.join(" ");
  for (const g of groups) {
    const members = [...new Set(g.map(normTerm).filter(Boolean))];
    for (const m of members.filter((x) => x.includes(" "))) {
      const words = m.split(" ").filter((w) => !STOP.has(w));
      if (words.length < 2 || !(" " + s + " ").includes(" " + words.join(" ") + " ")) continue;
      const others = members.filter((x) => x !== m);
      for (const w of words) { out[w] = out[w] || []; for (const o of others) if (!out[w].includes(o)) out[w].push(o); }
    }
  }
  return out;
}
