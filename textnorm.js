// Нормализация текста для смыслового поиска (зеркало tools/textnorm.py).
const SYMBOLS = [
  [/±/g, " plus or minus "],
  [/[≥⩾]/g, " greater than or equal to "],
  [/[≤⩽]/g, " less than or equal to "],
  [/(?<=\s)>(?=\s|\d)/g, " greater than "],
  [/(?<=\s)</g, " less than "],
  [/(?:(?<=[\s(])|^)[−–](?=\s?\d)|(?<=[\s(])-(?=\d)/g, " minus "],
  [/(?<=\S)\+(?=\s?\d)|(?:(?<=\s)|^)\+(?=\s?\d)/g, " plus "],
  [/\bft\/min\b/gi, " feet per minute "],
  [/\bkts?\b|\bkn\b/gi, " knots "],
  [/\bft\b/gi, " feet "],
  [/\bnm\b|\bNM\b/g, " nautical miles "],
  [/°\s?C/g, " degrees Celsius "],
  [/°/g, " degrees "],
  [/%/g, " percent "],
  [/&/g, " and "],
];
// В Python правило "<" такое же, как ">": (?<=\s)<(?=\s|\d)
SYMBOLS[4] = [/(?<=\s)<(?=\s|\d)/g, " less than "];

export function symbolsToWords(s) {
  for (const [rx, rep] of SYMBOLS) s = s.replace(rx, rep);
  return s.replace(/[ \t]+/g, " ");
}

const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Для запросов: расшифровка сокращений из глоссария базы (регистр не важен для слов от 3 букв)
export function makeQueryExpander(gloss) {
  const keys = [...gloss.keys()].filter((k) => k.length >= 2 && k.length <= 9).sort((a, b) => b.length - a.length);
  if (!keys.length) return (s) => s;
  const rx = new RegExp("(?<![A-Za-z0-9/\\-])(" + keys.map(esc).join("|") + ")(?![A-Za-z0-9/\\-])", "gi");
  return (s) => s.replace(rx, (m) => {
    const key = m.toUpperCase();
    if (!gloss.has(key)) return m;
    if (m.length < 3 && m !== key) return m; // короткие слова в нижнем регистре ("is", "as") не трогаем
    return `${m} (${gloss.get(key)})`;
  });
}
