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
   "action actions do done doing procedure procedures").split(" ")
);
// "after"/"before" полезны в авиации (before takeoff), поэтому их оставляем.
STOP.delete("after");
STOP.delete("before");
STOP.delete("not");
STOP.delete("procedure");
STOP.delete("procedures");
STOP.delete("no");
