"use strict";
/**
 * Nobreak — плагин ищет и правит типографику в текстах макета.
 *
 * Файл делится на две части:
 *   1) ДЕТЕКТОР — чистые функции без Figma. Их же подключает tests/detector.test.mjs,
 *      поэтому сборка не нужна: один и тот же code.js работает и в плагине, и в Node.
 *   2) ПЛАГИН — обвязка Figma. Запускается только там, где есть объект figma.
 *
 * Почему посимвольный скан, а не регэкспы: `\b` в JS опирается на ASCII, и после
 * кириллической единицы («км», «л») границы слова нет — лукахед молча не срабатывает.
 * А `/g`-регэксп в `.test()` двигает lastIndex и пропускает ноды в цикле. Оба грабля
 * уже наступали, поэтому здесь только посимвольные проверки.
 */

/* ============================================================================
   ЧАСТЬ 1 · ДЕТЕКТОР
   ========================================================================= */

var NBSP = ' ';

/**
 * Служебные слова, которые нельзя оставлять в конце строки: они относятся
 * к следующему слову, поэтому приклеиваем их неразрывным пробелом.
 *
 * Это ЗАКРЫТЫЙ СЛОВАРЬ, а не проверка по длине: длина не определяет предлог
 * («о» — предлог, «около» — тоже, «он» — нет). Длина влияет только на то,
 * в какое из двух правил попадёт слово: короткие (1–3 буквы) правим всегда,
 * длинные (4+) — отдельным правилом, которое можно выключить, если шумит.
 *
 * Слова с «ё» пишем через «е» — при поиске «ё» нормализуется.
 */
var FUNC_WORDS = [
  // предлоги непроизводные
  'в', 'во', 'к', 'ко', 'о', 'об', 'обо', 'с', 'со', 'у', 'до', 'за', 'из', 'изо',
  'на', 'над', 'надо', 'от', 'ото', 'по', 'под', 'подо', 'при', 'про', 'без', 'безо',
  'для', 'перед', 'передо', 'через', 'чрез', 'сквозь', 'между', 'меж', 'из-за', 'из-под',
  // предлоги производные
  'близ', 'вблизи', 'ввиду', 'вдоль', 'взамен', 'включая', 'вместо', 'вне', 'внутри',
  'возле', 'вокруг', 'вопреки', 'впереди', 'вроде', 'вследствие', 'вслед', 'выше',
  'исключая', 'кроме', 'кругом', 'мимо', 'накануне', 'наперекор', 'наподобие', 'напротив',
  'наряду', 'насчет', 'начиная', 'невзирая', 'несмотря', 'ниже', 'около', 'относительно',
  'поверх', 'подле', 'после', 'помимо', 'поперек', 'посреди', 'посередине', 'посредством',
  'против', 'путем', 'ради', 'сверх', 'свыше', 'согласно', 'сообразно', 'соответственно',
  'спустя', 'среди', 'супротив', 'благодаря',
  // союзы
  'а', 'и', 'но', 'да', 'или', 'либо', 'что', 'чтоб', 'чтобы', 'как', 'чем', 'если',
  'хотя', 'пока', 'ибо', 'тоже', 'также', 'зато', 'притом', 'причем', 'будто', 'дабы',
  'коли', 'ежели', 'нежели', 'поскольку', 'потому', 'оттого', 'затем', 'впрочем', 'однако',
  // частицы, которые относятся к следующему слову
  'не', 'ни'
];

var FUNC_SHORT = {}, FUNC_LONG = {};
for (var fw = 0; fw < FUNC_WORDS.length; fw++) {
  var w = FUNC_WORDS[fw];
  if (w.length <= 3) FUNC_SHORT[w] = true; else FUNC_LONG[w] = true;
}

/**
 * Сокращения с точкой: «ул. Абая», «п. 3». Отдельное правило, а не добавка к висячим
 * словам: иначе имя «Висячие предлоги» врёт, выключить сокращения отдельно нельзя,
 * да и механика другая — за словом стоит точка, а не пробел.
 *
 * Словаря два, потому что двусмысленность снимается не самим сокращением, а тем, что
 * идёт СЛЕДОМ. «с.» — и село, и страница; «д.» — и деревня, и дом; «стр.» — и строение,
 * и страница. Поэтому класс выбирает окружение, а не порядок в словарях:
 *
 *   NAME — дальше имя собственное с заглавной: «ул. Абая», «г. Алматы».
 *   NUM  — дальше число: «п. 3», «корп. 2». Гейт железный: буква сюда не попадёт,
 *          поэтому «ст. Приходите» на стыке предложений не поймается в принципе.
 *
 * Слово может лежать в обоих словарях — это нормально, разведёт окружение.
 */
var ABBR_NAME = {}, ABBR_NUM = {};
['ул', 'пр', 'просп', 'пер', 'пл', 'бул', 'б-р', 'ш', 'наб', 'туп', 'пр-д', 'мкр',
  'кв-л', 'пос', 'с', 'д', 'г', 'обл', 'р-н', 'им'
].forEach(function (a) { ABBR_NAME[a] = true; });
['п', 'пп', 'ст', 'гл', 'разд', 'абз', 'рис', 'табл', 'прил', 'стр', 'с', 'д',
  'корп', 'кв', 'оф', 'эт', 'каб', 'тел', 'доб'
].forEach(function (a) { ABBR_NUM[a] = true; });

/**
 * Ещё два окружения, той же природы — сокращение держится за то, что справа.
 *
 *   SEQ  — «т.» в связках «т. д.», «т. п.», «т. е.», «т. н.». Хвост закрытый: только
 *          эти четыре буквы с точкой, иначе «т.» цеплялось бы к любому слову.
 *          Само «и» перед связкой держит правило висячих слов, здесь оно не нужно.
 *   REF  — отсылки: «см. таблицу», «напр. так», «ср. цены». Следом обычное слово,
 *          поэтому гейт по заглавной тут не работает — вместо него запрет на цифру
 *          слева: «5 см. таблицу» это сантиметры, а не «смотри».
 *   UNIT — множитель перед единицей: «120 тыс. км», «куб. см», «кв. м», «долл. США».
 *          Следом обязана идти единица, знак валюты или слово с заглавной.
 */
var ABBR_SEQ = { 'т': true };
var SEQ_TAIL = { 'д': true, 'п': true, 'е': true, 'н': true };
var ABBR_REF = {};
['см', 'напр', 'ср'].forEach(function (a) { ABBR_REF[a] = true; });
var ABBR_UNIT = {};
['тыс', 'млн', 'млрд', 'куб', 'кв', 'долл'].forEach(function (a) { ABBR_UNIT[a] = true; });

/**
 * Единицы измерения, которые прилипают к числу слева (TYP-03).
 *
 * Кроме сокращений держим ПОЛНЫЕ формы времени и количества: в интерфейсе «15 минут»
 * встречается чаще, чем «15 мин», и разрыв «15 / минут» — такой же дефект. Список
 * закрытый и только про время и деньги: произвольные существительные сюда нельзя,
 * иначе склеится «100 объявлений» и «3 клиента», где число и слово не единица.
 *
 * Ложные срабатывания отсекает проверка «единица не начало другого слова»:
 * «5 часть» не поймается на «час», «5 деньги» — на «день».
 */
var UNITS = [
  'л.с.', 'кВт', 'млрд', 'млн', 'тыс', 'МБ', 'ГБ', 'КБ', 'ТБ', 'мес', 'мин', 'сек',
  'шт', 'чел', 'дн', 'км', 'см', 'мм', 'кг', 'мл', 'м²', 'м³', 'га', 'л', 'м', 'т',
  'г', 'ч', 'п',
  // время
  'секунда', 'секунды', 'секунд', 'минута', 'минуты', 'минут',
  'час', 'часа', 'часов', 'день', 'дня', 'дней', 'сутки', 'суток',
  'неделя', 'недели', 'недель', 'месяц', 'месяца', 'месяцев',
  'год', 'года', 'лет',
  // количество и деньги
  'тысяча', 'тысячи', 'тысяч', 'миллион', 'миллиона', 'миллионов',
  'миллиард', 'миллиарда', 'миллиардов', 'тенге', 'рубля', 'рублей'
].sort(function (a, b) { return b.length - a.length; });

/** Валюты и знаки, которые отбиваются от числа неразрывным пробелом (NUM-03). */
var CURRENCY = ['₸', '$', '€', '₽', '¥', '£'];

var RULE_ORDER = { hang: 0, hangLong: 1, abbr: 2, dash: 3, num: 4, space: 5, nofont: 6, hidden: 7 };
var STATUS_ORDER = { fix: 0, blocked: 1, unchecked: 2 };

function isWordChar(ch) {
  return !!ch && /[0-9A-Za-zА-Яа-яЁё]/.test(ch);
}
function isLetter(ch) {
  return !!ch && /[A-Za-zА-Яа-яЁё]/.test(ch);
}
function isDigit(ch) {
  return !!ch && ch >= '0' && ch <= '9';
}
function normWord(s) {
  return s.toLowerCase().replace(/ё/g, 'е');
}

/** Слово, начинающееся в позиции i (для подписи находки). */
function wordAt(t, i) {
  var s = i;
  while (i < t.length && isWordChar(t[i])) i++;
  return t.slice(s, i);
}

/**
 * Висячие служебные слова: слово из словаря + обычный пробел + слово.
 * Пробел заменяем на неразрывный. tier: 'hang' (1–3 буквы) или 'hangLong' (4+).
 */
function findHanging(t, out, enabled) {
  var i = 0;
  while (i < t.length) {
    if (!isLetter(t[i])) { i++; continue; }
    var s = i;
    while (i < t.length && isWordChar(t[i])) i++;
    var raw = t.slice(s, i);
    var key = normWord(raw);
    var tier = FUNC_SHORT[key] ? 'hang' : (FUNC_LONG[key] ? 'hangLong' : null);
    if (!tier || !enabled[tier]) continue;
    // Правим только обычный пробел: если там уже неразрывный, находки нет —
    // отсюда идемпотентность, повторный прогон ничего не меняет.
    if (t[i] !== ' ' || !isWordChar(t[i + 1])) continue;
    out.push({
      rule: tier, at: i, len: 1, put: NBSP,
      word: raw, next: wordAt(t, i + 1)
    });
  }
}

function isUpper(ch) {
  return !!ch && /[A-ZА-ЯЁ]/.test(ch);
}

/** Конец слова вместе с внутренним дефисом: «р-н», «б-р», «пр-д». */
function abbrWordEnd(t, i) {
  while (i < t.length && (isWordChar(t[i]) || (t[i] === '-' && isWordChar(t[i + 1])))) i++;
  return i;
}

/**
 * Перед сокращением стоит число: «2024 г.» — это год, он относится к числу СЛЕВА,
 * и склеивать его с тем, что справа, неверно. Такую пару чинит правило числа с единицей.
 */
function digitBefore(t, s) {
  var j = s - 1;
  if (t[j] === ' ' || t[j] === NBSP) j--;
  return isDigit(t[j]);
}

/** Хвост устойчивой связки: «д.», «п.», «е.», «н.» после «т.». */
function seqTail(t, i) {
  return SEQ_TAIL[normWord(t.charAt(i))] === true && t.charAt(i + 1) === '.';
}

/** В позиции i начинается единица измерения и не является началом другого слова. */
function unitAt(t, i) {
  var rest = t.slice(i);
  for (var u = 0; u < UNITS.length; u++) {
    var unit = UNITS[u];
    if (rest.indexOf(unit) !== 0) continue;
    if (isWordChar(rest.charAt(unit.length))) continue;
    return true;
  }
  return false;
}

/** Сокращение с точкой + обычный пробел + то, к чему оно относится. */
function findAbbrev(t, out) {
  var i = 0;
  while (i < t.length) {
    if (!isLetter(t[i])) { i++; continue; }
    var s = i;
    i = abbrWordEnd(t, i);
    var hasDot = t[i] === '.';
    var key = normWord(t.slice(s, i));
    var asName = ABBR_NAME[key] === true, asNum = ABBR_NUM[key] === true;
    var asSeq = ABBR_SEQ[key] === true, asRef = ABBR_REF[key] === true;
    var asUnit = ABBR_UNIT[key] === true;
    if (!asName && !asNum && !asSeq && !asRef && !asUnit) continue;
    // Стяжённые сокращения пишутся без точки: «р-н», «б-р», «пр-д», «кв-л» — у них
    // признак сокращения сам дефис. От остальных точка обязательна: без неё «с Алматы»
    // это предлог, а не село, и правило залезло бы в чужую работу.
    if (!hasDot && key.indexOf('-') === -1) continue;
    var sp = hasDot ? i + 1 : i;
    // Правим только обычный пробел: стоит неразрывный — находки нет. Отсюда
    // идемпотентность, как и в остальных правилах.
    if (t[sp] !== ' ') continue;
    var nx = t.charAt(sp + 1);
    var hit =
      (asNum && isDigit(nx)) ||
      (asName && isUpper(nx) && !digitBefore(t, s)) ||
      (asSeq && seqTail(t, sp + 1)) ||
      (asRef && isLetter(nx) && !digitBefore(t, s)) ||
      (asUnit && (unitAt(t, sp + 1) || CURRENCY.indexOf(nx) !== -1 || isUpper(nx)));
    if (!hit) continue;
    out.push({
      rule: 'abbr', at: sp, len: 1, put: NBSP,
      word: t.slice(s, sp), next: wordAt(t, sp + 1)
    });
  }
}

/** Перед длинным тире — неразрывный пробел, чтобы тире не уехало на новую строку. */
function findDash(t, out) {
  for (var i = 1; i < t.length; i++) {
    var ch = t[i];
    if (ch !== '—' && ch !== '–') continue;
    if (t[i - 1] !== ' ') continue;
    if (i - 2 < 0) continue;
    out.push({ rule: 'dash', at: i - 1, len: 1, put: NBSP, word: '', next: ch });
  }
}

/** Число + единица, валюта, разряды тысяч, «№», «%» слитно. */
function findNumUnit(t, out) {
  for (var i = 0; i < t.length; i++) {
    var ch = t[i];

    // «№124» → «№ 124», «№ 124» с обычным пробелом → с неразрывным (TYP-08)
    if (ch === '№') {
      var n = t[i + 1];
      if (isWordChar(n)) { out.push({ rule: 'num', at: i + 1, len: 0, put: NBSP, note: 'знак номера' }); }
      else if (n === ' ' && isWordChar(t[i + 2])) { out.push({ rule: 'num', at: i + 1, len: 1, put: NBSP, note: 'знак номера' }); }
      continue;
    }

    if (ch !== ' ') continue;
    var rest = t.slice(i + 1);
    var head = rest.charAt(0);

    // Знак валюты не должен начинать строку, и слева от пробела не обязательно цифра:
    // «5 500 000 ₸», но и «500 тысяч ₸», «4 млн ₸». Поэтому проверяем до цифровой границы.
    //
    // Исключение — знак ПЕРЕД числом («$ 50»): он относится к числу справа, и склеивать
    // его с предыдущим словом бессмысленно. Такую пару чинит другое правило, которого у нас нет.
    if (CURRENCY.indexOf(head) !== -1 && isWordChar(t[i - 1])) {
      var afterCur = rest.charAt(1);
      if (!isDigit(afterCur) && !(afterCur === ' ' && isDigit(rest.charAt(2)))) {
        out.push({ rule: 'num', at: i, len: 1, put: NBSP, note: 'валюта' });
        continue;
      }
    }

    if (!isDigit(t[i - 1])) continue;

    if (isDigit(head)) { out.push({ rule: 'num', at: i, len: 1, put: NBSP, note: 'разряды тысяч' }); continue; }
    if (head === '%') { out.push({ rule: 'num', at: i, len: 1, put: '', note: 'процент пишем слитно' }); continue; }

    for (var u = 0; u < UNITS.length; u++) {
      var unit = UNITS[u];
      if (rest.indexOf(unit) !== 0) continue;
      // единица не должна быть началом другого слова: «5 литров» — не «5 л»
      if (isWordChar(rest.charAt(unit.length))) continue;
      out.push({ rule: 'num', at: i, len: 1, put: NBSP, note: 'число и единица' });
      break;
    }
  }
}

/** Двойные пробелы и пробелы в начале и конце строки. */
function findSpaces(t, out) {
  var i = 0;
  while (i < t.length) {
    if (t[i] !== ' ') { i++; continue; }
    var j = i;
    while (j < t.length && t[j] === ' ') j++;
    var run = j - i;
    var atStart = i === 0 || t[i - 1] === '\n' || t[i - 1] === ' ';
    var atEnd = j >= t.length || t[j] === '\n' || t[j] === ' ';
    if (atStart || atEnd) {
      out.push({ rule: 'space', at: i, len: run, put: '', note: atEnd ? 'пробел в конце строки' : 'пробел в начале строки' });
    } else if (run > 1) {
      out.push({ rule: 'space', at: i + 1, len: run - 1, put: '', note: 'двойной пробел' });
    }
    i = j;
  }
}

/**
 * Разбор строки. Возвращает список правок вида
 * {rule, at, len, put} — «заменить len символов с позиции at на put».
 * Правки не пересекаются: один и тот же пробел не правим двумя правилами.
 */
function analyze(text, enabled) {
  var out = [];
  if (!text) return out;
  enabled = enabled || {};
  if (enabled.hang || enabled.hangLong) findHanging(text, out, enabled);
  if (enabled.abbr) findAbbrev(text, out);
  if (enabled.dash) findDash(text, out);
  if (enabled.num) findNumUnit(text, out);
  if (enabled.space) findSpaces(text, out);
  out.sort(function (a, b) {
    return (a.at - b.at) || (RULE_ORDER[a.rule] - RULE_ORDER[b.rule]);
  });
  var res = [], lastEnd = -1;
  for (var i = 0; i < out.length; i++) {
    var e = out[i];
    if (e.at < lastEnd) continue;
    // Что именно заменяем. Правка обязана описывать себя целиком: по `was` потом
    // сверяется, не изменился ли текст с момента проверки, и строится откат.
    e.was = text.slice(e.at, e.at + e.len);
    res.push(e);
    lastEnd = e.at + (e.len > 0 ? e.len : 1);
  }
  return res;
}

/** Применить правки к строке (используется в тестах и при правке через свойство). */
function applyEdits(text, edits) {
  var t = text;
  var sorted = edits.slice().sort(function (a, b) { return a.at - b.at; });
  for (var i = sorted.length - 1; i >= 0; i--) {
    var e = sorted[i];
    t = t.slice(0, e.at) + e.put + t.slice(e.at + e.len);
  }
  return t;
}

/**
 * Обратные правки для кнопки «Вернуть». Позиции считаются в УЖЕ исправленной строке:
 * каждая применённая правка сдвигает всё, что правее неё, на put.length - len.
 * Возвращать текст целиком нельзя — перезапись строки схлопывает смешанное
 * форматирование так же, как и при правке, поэтому откат тоже точечный.
 */
function inverseEdits(edits) {
  var asc = edits.slice().sort(function (a, b) { return a.at - b.at; });
  var out = [];
  var offset = 0;
  for (var i = 0; i < asc.length; i++) {
    var e = asc[i];
    var was = e.was == null ? '' : e.was;
    out.push({ at: e.at + offset, len: e.put.length, put: was });
    offset += e.put.length - e.len;
  }
  return out;
}

/* ————— раскладка строк: что Figma реально отрисовала ————— */

function decodeXml(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(parseInt(d, 10)); })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Строки текста в том виде, в каком их разложила Figma. На входе SVG-экспорт слоя.
 *
 * Одна визуальная строка — это НЕ один <tspan>. Как только внутри строки меняется
 * стиль (жирный фрагмент, другой размер, подчёркивание, цвет), Figma пишет несколько
 * элементов <text>, и куски одной строки оказываются в разных из них с одинаковым y.
 * Поэтому группируем по y, а внутри строки сортируем по x. Склейка по порядку
 * документа даёт мусор — проверено на живом файле.
 */
function parseSvgLines(svg) {
  var re = /<tspan([^>]*)>([\s\S]*?)<\/tspan>/g;
  var rows = [], m;
  while ((m = re.exec(svg)) !== null) {
    var my = m[1].match(/\by="(-?[0-9.]+)"/);
    var mx = m[1].match(/\bx="(-?[0-9.]+)"/);
    rows.push({
      y: my ? Math.round(parseFloat(my[1]) * 10) / 10 : 0,
      x: mx ? parseFloat(mx[1]) : 0,
      text: decodeXml(m[2])
    });
  }
  var byY = new Map();
  for (var i = 0; i < rows.length; i++) {
    if (!byY.has(rows[i].y)) byY.set(rows[i].y, []);
    byY.get(rows[i].y).push(rows[i]);
  }
  return Array.from(byY.keys()).sort(function (a, b) { return a - b; })
    .map(function (k) {
      return byY.get(k).sort(function (a, b) { return a.x - b.x; })
        .map(function (r) { return r.text; }).join('');
    });
}

/**
 * Индексы пробелов, на которых произошёл перенос. Пробел входит в конец строки —
 * это видно по экспорту, поэтому берём последний символ строки.
 *
 * Строку, кончающуюся переводом строки, пропускаем: перенос там поставил дизайнер
 * руками, и неразрывный пробел его не сдвинет — починить нечем.
 */
function lineBreakSpaces(lines) {
  var out = [], pos = 0;
  for (var i = 0; i < lines.length; i++) {
    pos += lines[i].length;
    if (i === lines.length - 1) break;
    if (lines[i].charAt(lines[i].length - 1) === ' ') out.push(pos - 1);
  }
  return out;
}

/**
 * Оставляем только то, что висит на макете сейчас: находка признаётся, если её пробел —
 * это тот самый пробел, на котором Figma перенесла строку.
 *
 * Правило «пробелы» не про переносы: двойной или хвостовой пробел — дефект текста
 * при любой раскладке, поэтому оно проходит без проверки.
 */
function keepVisible(edits, lines) {
  var brk = {};
  lineBreakSpaces(lines).forEach(function (p) { brk[p] = true; });
  return edits.filter(function (e) {
    if (e.rule === 'space') return true;
    // Вставка (len 0) — тоже не про переносы: «№3» неверно при любой ширине, как двойной
    // пробел. Заменять там нечего, значит и пробела на переносе у такой находки быть
    // не может, и проверка «висит ли сейчас» отбрасывала бы её всегда.
    if (e.len === 0) return true;
    return brk[e.at] === true;
  });
}

/** Кусок текста вокруг находки — чтобы в списке было видно место, а не только имя слоя. */
function snippet(text, e) {
  var from = Math.max(0, e.at - 24);
  var to = Math.min(text.length, e.at + e.len + 30);
  return {
    left: (from > 0 ? '…' : '') + text.slice(from, e.at).replace(/\n/g, ' '),
    mid: text.slice(e.at, e.at + e.len).replace(/\n/g, ' '),
    put: e.put,
    right: text.slice(e.at + e.len, to).replace(/\n/g, ' ') + (to < text.length ? '…' : '')
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    analyze: analyze, applyEdits: applyEdits, inverseEdits: inverseEdits,
    parseSvgLines: parseSvgLines, lineBreakSpaces: lineBreakSpaces, keepVisible: keepVisible,
    snippet: snippet, NBSP: NBSP, FUNC_WORDS: FUNC_WORDS
  };
}

/* ============================================================================
   ЧАСТЬ 2 · ПЛАГИН
   ========================================================================= */

if (typeof figma !== 'undefined') {

  var UI_W = 420;
  figma.skipInvisibleInstanceChildren = true;
  figma.showUI(__html__, { width: UI_W, height: 280, themeColors: true });

  var scanHidden = false;
  var rules = { hang: true, hangLong: true, abbr: true, dash: true, num: true, space: true };
  var scanCancelled = false;
  var fixCancelled = false;
  var writing = false;

  var findings = new Map();   // id → находка
  var nodeMeta = new Map();   // nodeId → {pageId, pageName, screen, status, reason}
  var undoText = new Map();   // nodeId → текст до правки (нужен там, где пишем в свойство компонента)
  // nodeId → обратные точечные правки. Возвращать текст целиком нельзя: перезапись строки
  // схлопывает смешанное форматирование так же, как и при правке. Поэтому «Вернуть» —
  // это те же удаления и вставки, только наоборот.
  var undoEdits = new Map();
  var tracked = new Set();    // nodeId, за которыми следим после скана
  var attachedPages = new Set();

  var pause = function () { return new Promise(function (r) { setTimeout(r, 0); }); };

  /* ——— выделение: одно сообщение и на старте, и на каждое изменение ——— */
  function postSelection() {
    var sel = figma.currentPage.selection;
    figma.ui.postMessage({
      type: 'selection',
      count: sel.length,
      name: sel.length === 1 ? sel[0].name : '',
      ids: sel.map(function (n) { return n.id; })
    });
  }

  function postPages() {
    var pages = figma.root.children
      .filter(function (c) { return c.type === 'PAGE'; })
      .map(function (p) { return { id: p.id, name: p.name }; });
    figma.ui.postMessage({ type: 'pages', pages: pages });
  }

  /* ——— контекст ноды ——— */

  // Имя экрана: поднимаемся до верхнего фрейма, пропуская секции.
  function screenOf(node) {
    var chain = [], cur = node.parent;
    while (cur && cur.type !== 'PAGE') { chain.push(cur); cur = cur.parent; }
    if (!chain.length) return 'Вне фрейма';
    var i = chain.length - 1;
    while (i > 0 && chain[i].type === 'SECTION') i--;
    return chain[i].name;
  }

  function visibleChain(node) {
    var p = node;
    while (p && p.type !== 'PAGE') { if (p.visible === false) return false; p = p.parent; }
    return true;
  }

  function textPropRef(node) {
    try {
      var r = node.componentPropertyReferences;
      return r && r.characters ? r.characters : null;
    } catch (e) { return null; }
  }

  // Причина, по которой Figma не даст переписать текст. Находки показываем, но не правим —
  // молча прятать их нельзя, иначе «0 находок» будет неправдой. Раскладку строк у таких
  // слоёв прочитать можно, поэтому проверка на реальный перенос работает как обычно.
  function blockedReason(node) {
    try {
      var bv = node.boundVariables;
      if (bv && bv.characters) return 'текст подставляется из переменной';
    } catch (e) { }
    return '';
  }

  // Причина, по которой нельзя ДОВЕРЯТЬ раскладке строк. Без шрифта Figma рисует
  // подменным, и переносы получаются не те, что видит дизайнер. Такой слой показываем
  // одной строкой без разбора находок — лучше честная пометка, чем ложная точность.
  function uncheckedReason(node) {
    // Причина уходит в строку находки под общим заголовком группы, поэтому она короткая:
    // длинная фраза там всё равно обрезается многоточием.
    if (node.hasMissingFont) return 'нет нужного шрифта';
    return '';
  }

  // Раскладка строк слоя: экспортируем в SVG и читаем, что Figma отрисовала.
  // Экспорт только читает — файл не меняется, история отмены не растёт.
  //
  // Самопроверка: склейка строк обязана совпасть с текстом слоя. Если не совпала —
  // помечаем слой непроверенным, а не гадаем. При ВЕРХНЕМ РЕГИСТРЕ экспорт отдаёт
  // преобразованный текст той же длины, поэтому сравниваем без учёта регистра.
  async function layoutLines(node, chars) {
    var svg;
    try {
      svg = await node.exportAsync({ format: 'SVG_STRING', svgOutlineText: false });
    } catch (e) {
      // Figma отказывается отдавать SVG для слоёв внутри некоторых обрезанных поддеревьев
      // и врёт при этом про «нет видимых слоёв»: PNG у того же слоя отдаётся, у родителя
      // SVG тоже падает, а тремя уровнями выше — уже нет. Спасает useAbsoluteBounds:
      // на живом макете так вернулись 134 слоя из 1639. Флаг меняет только рамку экспорта,
      // не раскладку, а если разбор всё же собьётся — поймает самопроверка ниже.
      //
      // Вторым заходом, а не первым: основной путь проверен на тысяче слоёв, и менять
      // его ради восьми процентов случаев незачем.
      try {
        svg = await node.exportAsync({
          format: 'SVG_STRING', svgOutlineText: false, useAbsoluteBounds: true
        });
      } catch (e2) {
        return { lines: [], ok: false, why: 'слой не экспортируется' };
      }
    }
    var lines = parseSvgLines(svg);
    if (!lines.length) return { lines: [], ok: false, why: 'в экспорте нет текста' };
    var joined = lines.join('').toLowerCase();
    var src = chars.toLowerCase();
    if (joined === src) return { lines: lines, ok: true, truncated: false };
    // Обрезанный текст: в экспорте только видимая часть, и она обязана быть началом
    // текста. Последняя видимая строка ничего не переносит, поэтому её обрыв
    // посреди слова на результат не влияет — сама она находок не даёт.
    if (src.indexOf(joined) === 0) return { lines: lines, ok: true, truncated: true };
    return { lines: lines, ok: false, why: 'раскладка не сошлась с текстом' };
  }

  /* ——— сбор текстовых слоёв ——— */

  function collectFrom(roots) {
    var out = [];
    for (var i = 0; i < roots.length; i++) {
      var root = roots[i];
      if (root.type === 'TEXT') out.push(root);
      if ('findAllWithCriteria' in root) {
        out = out.concat(root.findAllWithCriteria({ types: ['TEXT'] }));
      }
    }
    return out;
  }

  async function collectTexts(scope, excludePageIds) {
    var res = [];
    if (scope === 'selection') {
      var sel = figma.currentPage.selection;
      var nodes = collectFrom(sel);
      for (var i = 0; i < nodes.length; i++) {
        res.push({ node: nodes[i], pageId: figma.currentPage.id, pageName: figma.currentPage.name });
      }
      return res;
    }
    var exclude = {};
    (excludePageIds || []).forEach(function (id) { exclude[id] = true; });
    var pages = scope === 'page'
      ? [figma.currentPage]
      : figma.root.children.filter(function (c) { return c.type === 'PAGE' && !exclude[c.id]; });

    for (var p = 0; p < pages.length; p++) {
      if (scanCancelled) return res;
      var page = pages[p];
      figma.ui.postMessage({ type: 'scan-collect', pageName: page.name, current: p + 1, total: pages.length });
      if (page !== figma.currentPage) await page.loadAsync();
      var found = page.findAllWithCriteria({ types: ['TEXT'] });
      for (var k = 0; k < found.length; k++) {
        res.push({ node: found[k], pageId: page.id, pageName: page.name });
      }
      await pause();
    }
    return res;
  }

  /* ——— сканирование ——— */

  // Единый разбор одного слоя. Им пользуются и сканирование, и пересчёт после правки:
  // если развести эти два пути, после исправления в списке всплывут находки,
  // отобранные по другому принципу.
  async function analyzeNode(node, chars) {
    var unchecked = uncheckedReason(node);
    if (unchecked) return { status: 'unchecked', reason: unchecked, edits: [], truncated: false };

    var edits = analyze(chars, rules);
    if (!edits.length) return { status: 'fix', reason: '', edits: [], truncated: false };

    var canWrap = node.textAutoResize !== 'WIDTH_AND_HEIGHT' || chars.indexOf('\n') !== -1;
    var truncated = false;
    if (!canWrap) {
      // В одну строку текст не разложится — висеть нечему. Остаётся то, что дефект
      // при любой раскладке: лишние пробелы и вставки вроде «№3».
      edits = edits.filter(function (e) { return e.rule === 'space' || e.len === 0; });
    } else {
      var lay = await layoutLines(node, chars);
      if (!lay.ok) return { status: 'unchecked', reason: lay.why, edits: [], truncated: false };
      edits = keepVisible(edits, lay.lines);
      truncated = !!lay.truncated;
    }
    var reason = edits.length ? blockedReason(node) : '';
    return {
      status: reason ? 'blocked' : 'fix', reason: reason,
      edits: edits, truncated: truncated
    };
  }

  // Слой, раскладку которого проверить не удалось. Одна строка на слой: находки внутри
  // не разбираем, потому что без надёжной раскладки любая из них была бы догадкой.
  function uncheckedFinding(node, chars, meta, rule) {
    var head = chars.length > 60 ? chars.slice(0, 60) + '…' : chars;
    return {
      id: node.id + '#' + (rule || 'nofont'),
      nodeId: node.id,
      rule: rule || 'nofont',
      at: 0, len: 0, put: '', was: '',
      snippet: { left: head, mid: '', put: '', right: '' },
      note: '',
      status: 'unchecked',
      reason: meta.reason
    };
  }

  function makeFinding(node, chars, e, meta) {
    return {
      id: node.id + '#' + e.rule + '#' + e.at,
      nodeId: node.id,
      rule: e.rule,
      at: e.at, len: e.len, put: e.put,
      was: e.was,
      word: e.word || '', next: e.next || '',
      snippet: snippet(chars, e),
      note: e.note || '',
      status: meta.status,
      reason: meta.reason
    };
  }

  async function runScan(scope, excludePageIds) {
    findings.clear(); nodeMeta.clear(); tracked = new Set();
    var texts = await collectTexts(scope, excludePageIds);
    if (scanCancelled) return null;
    var total = texts.length, done = 0;

    for (var i = 0; i < texts.length; i++) {
      if (scanCancelled) return null;
      done++;
      // Разбор синхронный, поэтому без этой паузы окно плагина замирает
      // и кнопка «Отменить» не успевает сработать.
      // Раз в 10 слоёв, а не в 100: с чтением раскладки проверка идёт медленнее,
      // и на редком шаге счётчик замирал — выглядело так, будто плагин повис.
      if (done % 10 === 0 || done === total) {
        figma.ui.postMessage({ type: 'scan-progress', current: done, total: total, pageName: texts[i].pageName });
        await pause();
      }
      var node = texts[i].node;
      var chars;
      try { chars = node.characters; } catch (e) { continue; }

      // Скрытый слой — это обычно другое состояние экрана, и его текст поедет в продукт.
      // Проверить его нельзя: у невидимого текста нет переносов. Поэтому не пропускаем
      // молча, а показываем в «Не проверено» — но только если в тексте есть кандидат,
      // иначе чистые скрытые слои шумели бы без пользы.
      if (!node.visible || !visibleChain(node)) {
        if (!scanHidden) continue;
        if (!analyze(chars, rules).length) continue;
        var hmeta = {
          pageId: texts[i].pageId, pageName: texts[i].pageName, screen: screenOf(node),
          status: 'unchecked', reason: '', name: node.name, head: chars.slice(0, 80)
        };
        nodeMeta.set(node.id, hmeta);
        findings.set(node.id + '#hidden', uncheckedFinding(node, chars, hmeta, 'hidden'));
        continue;
      }

      var res = await analyzeNode(node, chars);
      if (res.status !== 'unchecked' && !res.edits.length) continue;

      var meta = {
        pageId: texts[i].pageId, pageName: texts[i].pageName, screen: screenOf(node),
        status: res.status, reason: res.reason, name: node.name, truncated: res.truncated,
        head: chars.slice(0, 80)
      };
      nodeMeta.set(node.id, meta);

      if (res.status === 'unchecked') {
        findings.set(node.id + '#nofont', uncheckedFinding(node, chars, meta, 'nofont'));
        continue;
      }
      for (var e2 = 0; e2 < res.edits.length; e2++) {
        var f = makeFinding(node, chars, res.edits[e2], meta);
        findings.set(f.id, f);
      }
      tracked.add(node.id);
    }
    return { total: total };
  }

  /* ——— группировка для интерфейса ——— */

  function itemOf(f) {
    var meta = nodeMeta.get(f.nodeId) || {};
    return {
      id: f.id, nodeId: f.nodeId, rule: f.rule, status: f.status,
      snippet: f.snippet, note: f.note,
      screen: meta.screen || '', pageId: meta.pageId, pageName: meta.pageName,
      layer: meta.name || '', reason: f.reason,
      word: f.word || '', next: f.next || '', head: meta.head || ''
    };
  }

  function buildGroups() {
    var map = new Map();
    findings.forEach(function (f) {
      var key = f.rule + '::' + f.status;
      if (!map.has(key)) map.set(key, { key: key, rule: f.rule, status: f.status, items: [] });
      map.get(key).items.push(itemOf(f));
    });
    var groups = Array.from(map.values());
    groups.sort(function (a, b) {
      var s = (STATUS_ORDER[a.status] || 0) - (STATUS_ORDER[b.status] || 0);
      if (s !== 0) return s;
      return RULE_ORDER[a.rule] - RULE_ORDER[b.rule];
    });
    return groups;
  }

  function counts() {
    var c = { fix: 0, blocked: 0 };
    findings.forEach(function (f) { c[f.status] = (c[f.status] || 0) + 1; });
    return c;
  }

  function postResults(extra) {
    var payload = { type: 'results', groups: buildGroups(), counts: counts() };
    if (extra) Object.keys(extra).forEach(function (k) { payload[k] = extra[k]; });
    figma.ui.postMessage(payload);
  }

  /* ——— правка ——— */

  async function loadFonts(node) {
    var seen = {};
    var segs = node.getStyledTextSegments(['fontName']);
    if (!segs.length && node.fontName && node.fontName !== figma.mixed) {
      await figma.loadFontAsync(node.fontName);
      return;
    }
    for (var i = 0; i < segs.length; i++) {
      var f = segs[i].fontName;
      var k = f.family + '|' + f.style;
      if (seen[k]) continue;
      seen[k] = true;
      await figma.loadFontAsync(f);
    }
  }

  // Правим точечно: удалить символ и вставить неразрывный. Через `node.characters = …`
  // делать нельзя — присваивание всей строки схлопывает смешанное форматирование
  // (жирный фрагмент, ссылка, другой цвет) к стилю первого символа.
  // Правки применяются ровно в том порядке, в каком перечислены. Нужно там, где каждая
  // следующая посчитана по уже изменённому тексту: сортировать их нельзя.
  function writeSeq(node, edits) {
    for (var i = 0; i < edits.length; i++) {
      var e = edits[i];
      if (e.len > 0) node.deleteCharacters(e.at, e.at + e.len);
      if (e.put) node.insertCharacters(e.at, e.put, e.at === 0 ? 'AFTER' : 'BEFORE');
    }
  }

  // Набор правок, посчитанных по одному тексту: идём с конца, чтобы позиции не съезжали.
  function writeInPlace(node, edits) {
    writeSeq(node, edits.slice().sort(function (a, b) { return b.at - a.at; }));
  }

  // Находка «та же самая» — по смыслу, а не по позиции: после первой правки текст
  // перетекает и все позиции ниже уезжают. Правило плюс склеиваемая пара слов
  // (у чисел и пробелов — пометка) опознают находку и в переставшемся тексте.
  function editKey(e) {
    return e.rule + '|' + (e.word || '') + '|' + (e.next || '') + '|' + (e.note || '');
  }

  // Не во всех окружениях commitUndo доступен. Если его нет, шаг отмены просто не делится —
  // это не повод валить уже применённую правку.
  function commitUndoSafe() {
    try { figma.commitUndo(); } catch (e) { }
  }

  // Сколько в слое стилевых сегментов. Один — значит текст однородный и его можно
  // писать целиком; больше — внутри есть цветные ссылки, жирные фрагменты, и любая
  // запись всей строки их схлопнет.
  function styleSegments(node) {
    try {
      return node.getStyledTextSegments(['fills', 'fontName', 'textDecoration', 'hyperlink']).length;
    } catch (e) { return 2; }
  }

  // Текст может быть не своим, а значением текстового свойства компонента.
  // Тогда пишем в свойство ближайшего инстанса, который им владеет.
  function writeViaProperty(node, key, newText) {
    var p = node.parent;
    while (p && p.type !== 'PAGE') {
      if (p.type === 'INSTANCE') {
        var props = null;
        try { props = p.componentProperties; } catch (e) { }
        if (props && Object.prototype.hasOwnProperty.call(props, key)) {
          var patch = {}; patch[key] = newText;
          p.setProperties(patch);
          return true;
        }
      }
      p = p.parent;
    }
    return false;
  }

  // Сколько догоняющих проходов делаем максимум. Замер на живом файле: колонка из восьми
  // абзацев сходится за три. Шесть — с запасом, а не бесконечный цикл: если не сошлось,
  // честно говорим «осталось столько-то», а не крутимся молча.
  var MAX_CHASE = 6;

  /**
   * Правка выделенных находок.
   *
   * Два вложенных цикла, и оба нужны по одной причине — склейка сдвигает текст:
   *   внутренний  — правки в одном слое применяем по одной, между ними разбирая слой
   *                 заново: после первой части находок уже ничего не держит;
   *   внешний     — когда текст сдвинулся, повиснуть может то, что стояло ровно.
   *                 Догоняем, пока слой не станет чистым.
   *
   * `figma.commitUndo()` стоит один раз в самом конце, поэтому все проходы — один шаг
   * отмены: Cmd + Z возвращает всё сразу. Звать applyFix повторно снаружи нельзя,
   * иначе шагов станет столько же, сколько проходов.
   */
  async function applyFix(ids) {
    var byNode = new Map();
    var askedRules = {};
    for (var i = 0; i < ids.length; i++) {
      var f = findings.get(ids[i]);
      if (!f || f.status !== 'fix') continue;
      if (!byNode.has(f.nodeId)) byNode.set(f.nodeId, []);
      byNode.get(f.nodeId).push(f);
      askedRules[f.rule] = true;
    }

    var applied = 0, dropped = 0, failed = [], resized = [], rounds = 0;
    var touched = {};    // nodeId → true, за все проходы
    var origSize = {};   // nodeId → размер до ПЕРВОЙ правки
    // Догоняем только там, где нажали пакетную кнопку: она значит «почини это место».
    // Нажали «Исправить» на одной строке — делаем ровно одну правку, без самодеятельности.
    var chase = ids.length > 1;

    writing = true;

    while (true) {
      rounds++;
      var nodeIds = Array.from(byNode.keys());

      for (var n = 0; n < nodeIds.length; n++) {
        if (fixCancelled) break;
        var nodeId = nodeIds[n];
        figma.ui.postMessage({
          type: 'fix-progress', current: n + 1, total: nodeIds.length, round: rounds
        });
        var meta = nodeMeta.get(nodeId) || {};
        var node = await figma.getNodeByIdAsync(nodeId);
        if (!node || node.type !== 'TEXT') {
          failed.push({ nodeId: nodeId, screen: meta.screen || '', head: meta.head || '', reason: 'слой не найден' });
          continue;
        }
        var before = node.characters;
        // Текст мог измениться после проверки. Позиции сверяем один раз, до первой правки:
        // дальше они всё равно поедут, и слой будет разбираться заново.
        var asked = byNode.get(nodeId).filter(function (x) {
          return before.slice(x.at, x.at + x.len) === x.was;
        });
        if (!asked.length) {
          failed.push({ nodeId: nodeId, screen: meta.screen || '', head: meta.head || '', reason: 'текст изменился — проверьте заново' });
          continue;
        }
        // Сколько правок какого вида просили. Больше запрошенного за один проход
        // не чиним — новое пойдёт следующим проходом и будет посчитано отдельно.
        var want = {};
        asked.forEach(function (x) { var k = editKey(x); want[k] = (want[k] || 0) + 1; });

        if (origSize[nodeId] === undefined) origSize[nodeId] = { w: node.width, h: node.height };
        var undoStack = [], fontsLoaded = false, madeHere = 0;
        try {
          for (var pass = 0; pass < asked.length; pass++) {
            if (fixCancelled) break;
            var res = await analyzeNode(node, node.characters);
            if (res.status !== 'fix') break;
            var pick = null;
            for (var q = 0; q < res.edits.length; q++) {
              var kk = editKey(res.edits[q]);
              if (want[kk] > 0) { want[kk]--; pick = res.edits[q]; break; }
            }
            if (!pick) break;
            // Значение свойства — плоская строка, поэтому запись через свойство схлопывает
            // пораздельные стили. В тексте согласий это выглядело как сброс цвета у ссылок.
            // Точечная правка на таком слое проходит и цвета сохраняет — проверено на живом
            // инстансе, — поэтому свойство используем только для однородного текста, где
            // терять нечего: так мы не плодим текстовый оверрайд без нужды.
            var ref = textPropRef(node);
            var viaProp = false;
            if (ref && styleSegments(node) === 1) {
              viaProp = writeViaProperty(node, ref, applyEdits(node.characters, [pick]));
            }
            if (!viaProp) {
              if (!fontsLoaded) { await loadFonts(node); fontsLoaded = true; }
              writeInPlace(node, [pick]);
            }
            // Обратная правка посчитана по уже изменённому тексту, поэтому откатывать их
            // надо от последней к первой — складываем стопкой.
            undoStack.unshift(inverseEdits([pick])[0]);
            madeHere++;
          }
          if (madeHere) {
            // Текст до первой правки, а не до текущего прохода: «вернуть» должно
            // отменить всё, что мы сделали с этим слоем, а не последний проход.
            if (!undoText.has(nodeId)) undoText.set(nodeId, before);
            // Правки прошлых проходов откатываются ПОСЛЕ нынешних — стопка растёт с начала.
            undoEdits.set(nodeId, undoStack.concat(undoEdits.get(nodeId) || []));
            applied += madeHere;
            touched[nodeId] = true;
          }
          // Остальное перестало висеть само — это не ошибка, но сказать об этом надо:
          // иначе «исправил 2» там, где в списке было 4 строки, читается как сбой.
          dropped += asked.length - madeHere;
        } catch (err) {
          failed.push({
            nodeId: nodeId, screen: meta.screen || '', head: meta.head || '',
            reason: (err && err.message) ? err.message : String(err)
          });
        }
        if (n % 10 === 9) await pause();
      }

      // Разбираем затронутые слои заново: отсюда и берётся список для догона.
      await refreshNodes(Object.keys(touched), true);

      if (!chase || fixCancelled || rounds >= MAX_CHASE) break;

      // В догон идёт только то, что всплыло на затронутых слоях и по тем же правилам,
      // о которых просили. Иначе проход залезет в работу, которую не заказывали.
      var next = new Map();
      findings.forEach(function (x) {
        if (x.status !== 'fix' || !touched[x.nodeId] || !askedRules[x.rule]) return;
        if (!next.has(x.nodeId)) next.set(x.nodeId, []);
        next.get(x.nodeId).push(x);
      });
      if (!next.size) break;
      byNode = next;
    }

    writing = false;
    commitUndoSafe();

    // Размер сравниваем с тем, что было до первого прохода: иначе один слой попадёт
    // в предупреждение столько раз, сколько проходов его касалось.
    var sized = Object.keys(origSize);
    for (var s = 0; s < sized.length; s++) {
      if (!touched[sized[s]]) continue;
      var nd = await figma.getNodeByIdAsync(sized[s]);
      if (!nd || nd.type !== 'TEXT') continue;
      var o = origSize[sized[s]], mt = nodeMeta.get(sized[s]) || {};
      if (Math.abs(nd.width - o.w) > 0.5 || Math.abs(nd.height - o.h) > 0.5) {
        resized.push({
          nodeId: sized[s], screen: mt.screen || '', layer: nd.name,
          // Начало текста, а не имя слоя: в макетах слой обычно называется «text»,
          // и по такому имени не понять, что именно вернётся.
          head: mt.head || '',
          dw: Math.round(nd.width - o.w), dh: Math.round(nd.height - o.h)
        });
      }
    }

    // Что осталось непочиненным на затронутых слоях. В норме ноль — мы догнали.
    // Не ноль значит одно из двух: кончились проходы или прогон отменили.
    var left = 0;
    findings.forEach(function (x) {
      if (x.status === 'fix' && touched[x.nodeId] && askedRules[x.rule]) left++;
    });

    return {
      applied: applied, dropped: dropped, left: left, rounds: rounds,
      failed: failed, resized: resized, cancelled: fixCancelled
    };
  }

  async function revert(nodeId) {
    var before = undoText.get(nodeId);
    if (before == null) return false;
    var node = await figma.getNodeByIdAsync(nodeId);
    if (!node || node.type !== 'TEXT') return false;
    writing = true;
    try {
      // Откатываем тем же способом, которым правили. Если правка была точечной,
      // возврат целой строкой схлопнул бы стили ровно так же, как это делала запись
      // в свойство, — поэтому сохранённые обратные правки идут первыми.
      //
      // Порядок здесь значащий: правки применялись по одной, каждая следующая считалась
      // по уже изменённому тексту. Поэтому откат идёт от последней к первой — стопка
      // сложена в этом порядке, и сортировать её нельзя.
      var inv = undoEdits.get(nodeId);
      var ref = textPropRef(node);
      if (inv && inv.length) {
        await loadFonts(node);
        writeSeq(node, inv);
      } else if (ref) {
        writeViaProperty(node, ref, before);
      } else {
        await loadFonts(node);
        node.deleteCharacters(0, node.characters.length);
        node.insertCharacters(0, before);
      }
      undoText.delete(nodeId);
      undoEdits.delete(nodeId);
    } finally {
      writing = false;
      commitUndoSafe();
    }
    await refreshNodes([nodeId], true);
    return true;
  }

  /* ——— пересчёт отдельных слоёв ——— */

  // После любой правки индексы остальных находок в этом же слое съезжают,
  // поэтому слой всегда разбираем заново, а не пересчитываем смещения руками.
  async function refreshNodes(nodeIds, silent) {
    var updates = [];
    for (var i = 0; i < nodeIds.length; i++) {
      var id = nodeIds[i];
      findings.forEach(function (f, key) { if (f.nodeId === id) findings.delete(key); });
      var node = await figma.getNodeByIdAsync(id);
      if (!node || node.type !== 'TEXT' || !node.visible || !visibleChain(node)) {
        tracked.delete(id);
        updates.push({ nodeId: id, items: [] });
        continue;
      }
      var chars;
      try { chars = node.characters; } catch (e) { chars = ''; }
      var res = await analyzeNode(node, chars);
      var meta = nodeMeta.get(id) || {};
      meta.status = res.status;
      meta.reason = res.reason;
      meta.truncated = res.truncated;
      meta.name = node.name;
      meta.head = chars.slice(0, 80);
      if (!meta.screen) meta.screen = screenOf(node);
      if (!meta.pageId) { meta.pageId = figma.currentPage.id; meta.pageName = figma.currentPage.name; }
      nodeMeta.set(id, meta);
      var items = [];
      if (res.status === 'unchecked') {
        var fu = uncheckedFinding(node, chars, meta, 'nofont');
        findings.set(fu.id, fu);
        items.push(itemOf(fu));
      }
      for (var e = 0; e < res.edits.length; e++) {
        var f2 = makeFinding(node, chars, res.edits[e], meta);
        findings.set(f2.id, f2);
        items.push(itemOf(f2));
      }
      if (!items.length) tracked.delete(id);
      updates.push({ nodeId: id, items: items });
    }
    if (!silent) {
      figma.ui.postMessage({ type: 'nodes-updated', updates: updates, counts: counts() });
    }
    return updates;
  }

  /* ——— слежение за изменениями текста на канвасе ——— */

  var pendingRefresh = {}, refreshTimer = null;

  function scheduleRefresh(id) {
    pendingRefresh[id] = true;
    if (refreshTimer) return;
    refreshTimer = setTimeout(async function () {
      refreshTimer = null;
      var ids = Object.keys(pendingRefresh);
      pendingRefresh = {};
      if (!ids.length) return;
      var updates = await refreshNodes(ids, true);
      figma.ui.postMessage({ type: 'nodes-updated', updates: updates, counts: counts() });
    }, 300);
  }

  function onNodeChange(ev) {
    if (writing || !tracked.size) return;
    for (var i = 0; i < ev.nodeChanges.length; i++) {
      var ch = ev.nodeChanges[i];
      if (tracked.has(ch.id)) scheduleRefresh(ch.id);
    }
  }

  // Слушатель живёт на конкретной странице, а не на документе. Если подписаться
  // только на старте, после перехода на другую страницу список тихо перестанет
  // сам обновляться — поэтому подписываемся заново на каждой странице.
  function attachNodeChange() {
    var page = figma.currentPage;
    if (attachedPages.has(page.id)) return;
    try { page.on('nodechange', onNodeChange); attachedPages.add(page.id); } catch (e) { }
  }

  /* ——— сообщения из интерфейса ——— */

  figma.ui.onmessage = async function (msg) {
    if (msg.type === 'resize') {
      figma.ui.resize(UI_W, Math.max(160, Math.min(900, Math.round(msg.height))));
      return;
    }
    if (msg.type === 'cancel-scan') { scanCancelled = true; return; }
    if (msg.type === 'cancel-fix') { fixCancelled = true; return; }

    if (msg.type === 'scan') {
      rules = msg.rules || rules;
      scanHidden = !!msg.scanHidden;
      scanCancelled = false;
      figma.ui.postMessage({ type: 'scan-start' });
      try {
        var res = await runScan(msg.scope, msg.excludePageIds);
        if (scanCancelled || !res) {
          figma.ui.postMessage({ type: 'scan-cancelled' });
          figma.notify('Проверка отменена');
          return;
        }
        attachNodeChange();
        var c = counts();
        postResults({ scanned: res.total });
        if (!c.fix && !c.blocked) figma.notify('Чисто — ни одной находки');
        else figma.notify('Нашёл ' + (c.fix + c.blocked) + ' ' + plural(c.fix + c.blocked, 'находку', 'находки', 'находок'));
      } catch (e) {
        figma.ui.postMessage({ type: 'scan-error', message: (e && e.message) ? e.message : String(e) });
        figma.notify('Проверка сломалась: ' + ((e && e.message) ? e.message : String(e)), { error: true });
      }
      return;
    }

    if (msg.type === 'fix') {
      fixCancelled = false;
      figma.ui.postMessage({ type: 'fix-start', total: msg.ids.length });
      try {
        var r = await applyFix(msg.ids);
        postResults({
          fixed: r.applied, dropped: r.dropped, left: r.left, rounds: r.rounds,
          failed: r.failed, resized: r.resized, fixCancelled: r.cancelled
        });
        var parts = [];
        if (r.applied) {
          parts.push('Исправил ' + r.applied +
            (r.rounds > 1 ? ' за ' + r.rounds + ' ' + plural(r.rounds, 'проход', 'прохода', 'проходов') : ''));
        }
        if (r.left) parts.push('осталось ' + r.left);
        if (r.resized.length) parts.push('у ' + r.resized.length + ' ' + plural(r.resized.length, 'слоя', 'слоёв', 'слоёв') + ' изменился размер');
        if (r.failed.length) parts.push('не смог ' + r.failed.length);
        figma.notify(parts.length ? parts.join(', ') : 'Нечего исправлять');
      } catch (e) {
        figma.ui.postMessage({ type: 'fix-error', message: (e && e.message) ? e.message : String(e) });
        figma.notify('Правка сломалась: ' + ((e && e.message) ? e.message : String(e)), { error: true });
      }
      return;
    }

    if (msg.type === 'revert') {
      var ok = await revert(msg.nodeId);
      // Сообщаем, какой слой вернули: интерфейс снимет его строку из предупреждений,
      // иначе она продолжает предлагать «вернуть» для уже возвращённого слоя.
      postResults({ reverted: ok ? msg.nodeId : null });
      figma.notify(ok ? 'Вернул как было' : 'Вернуть не получилось');
      return;
    }

    if (msg.type === 'focus') {
      var f = findings.get(msg.id);
      if (!f) return;
      var meta2 = nodeMeta.get(f.nodeId) || {};
      if (meta2.pageId && meta2.pageId !== figma.currentPage.id) {
        var page = await figma.getNodeByIdAsync(meta2.pageId);
        if (page && page.type === 'PAGE') await figma.setCurrentPageAsync(page);
      }
      var node = await figma.getNodeByIdAsync(f.nodeId);
      if (!node || node.type === 'PAGE' || node.type === 'DOCUMENT') {
        figma.notify('Слой не найден — возможно, его удалили', { error: true });
        return;
      }
      figma.currentPage.selection = [node];
      figma.viewport.scrollAndZoomIntoView([node]);
      // Мелкий текст иначе раздувается на весь экран и теряется контекст.
      if (figma.viewport.zoom > 2) figma.viewport.zoom = 2;
      return;
    }
  };

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  postSelection();
  postPages();
  attachNodeChange();
  figma.on('selectionchange', postSelection);
  figma.on('currentpagechange', function () { attachNodeChange(); postSelection(); });
}
