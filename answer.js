// Ответ из найденной страницы: очистка текста, деление на фразы, выбор лучшей фразы (ответ) и окружающей цитаты.
const HEAD_LINE = /^(OPERATIONS MANUAL|PART [ABC]|PART [ABC] .*|Page [\dA-Z]+[ -]+\d+|Iss\d+\/Rev\d+|\d{1,2} [A-Z][a-z]{2} \d{4}|\d{1,2} [A-Z]{3} \d\d|NORMAL PROCEDURES|OPERATING POLICY|LIMITATIONS|Ident\.:.*|Applicable to:.*)$/;

// Строки текста без шапки страницы (первые строки), одной строкой на элемент
export function cleanLines(text) {
  let lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const di = lines.slice(0, 16).findIndex((l) => /^\d{1,2} [A-Z]{3} \d\d$/.test(l)); // шапка FCOM кончается датой ревизии
  if (di >= 0 && di < lines.length - 1) lines = lines.slice(di + 1);
  const head = lines.slice(0, 10).filter((l) => !HEAD_LINE.test(l));
  return head.concat(lines.slice(10));
}

export function candidateText(heading, text, maxChars = 1400) {
  const body = cleanLines(text).join(" ").replace(/\s+/g, " ");
  return ((heading ? heading + ". " : "") + body).slice(0, maxChars);
}

// Фразы страницы: по точке/точке с запятой и по пунктам списка; короткие обрывки склеиваются со следующей
export function splitUnits(text, minLen = 60, maxLen = 340) {
  const lines = cleanLines(text);
  const joined = [];
  let buf = "";
  for (const l of lines) {
    const startsItem = /^([a-z]\)|\d+\)|\d+\.|•|-|[ivx]+\.|[A-Z]\))\s/.test(l);
    if (buf && (startsItem || /[.;:]$/.test(buf)) && buf.length >= minLen) { joined.push(buf); buf = ""; }
    buf += (buf ? " " : "") + l;
    if (buf.length >= maxLen) { joined.push(buf); buf = ""; }
  }
  if (buf) joined.push(buf);
  // обрезаем слишком длинные и склеиваем совсем короткие
  const out = [];
  for (const u of joined) {
    if (out.length && out[out.length - 1].length < 30) out[out.length - 1] += " " + u;
    else out.push(u.slice(0, maxLen + 120));
  }
  return out;
}

// Лучшая фраза по совпадению слов (когда нет reranker)
export function lexicalScore(unit, stems) {
  const low = unit.toLowerCase();
  let n = 0;
  for (const s of stems) if (low.includes(s)) n++;
  return n;
}

export function stemsOf(toks, extra) {
  const stems = [...new Set(toks.map((t) => t.slice(0, Math.max(4, t.length - 2))))];
  for (const t of toks) for (const a of (extra && extra[t]) || []) if (a.length >= 2) stems.push(a.slice(0, Math.max(4, a.length - 2)));
  return stems;
}

// Номер раздела из заголовка: "8.1.7.7 In-Flight Fuel Management" -> {num:"8.1.7.7", title:"In-Flight Fuel Management"}
export function parseHeading(h) {
  const m = /^(\d+(?:\.\d+)*)\.?\s+(.*)$/.exec(h || "");
  return m ? { num: m[1], title: m[2] } : { num: "", title: h || "" };
}

// Цвет уверенности по оценке reranker (логит). Пороги подобраны по проверочным вопросам.
export const CONF = { green: 3.0, yellow: -1.0 };
export function confLevel(rr) {
  if (rr == null) return null;
  return rr >= CONF.green ? "green" : rr >= CONF.yellow ? "yellow" : "red";
}
