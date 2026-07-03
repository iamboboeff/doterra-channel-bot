// Небольшой надёжный парсер CSV: понимает кавычки, экранирование "", переводы строк
// внутри ячеек, BOM и CRLF. Ровно то, что отдаёт расширение doterra-export.

export function parseCSV(text) {
  // Убираем BOM, который расширение добавляет для Excel.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // экранированная кавычка ""
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ',' || c === ';' || c === '\t') {
      // поддерживаем запятую, точку с запятой и таб как разделители
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // пропускаем — \n обработает конец строки
    } else {
      field += c;
    }
  }
  // последняя ячейка/строка, если файл не заканчивается переводом строки
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

// "1 234,5" / "1,234.5" / "1234" -> число. Возвращает NaN, если не число.
export function toNumber(value) {
  if (value == null) return NaN;
  let s = String(value).trim();
  if (!s) return NaN;
  s = s.replace(/\s+/g, ''); // пробелы-разделители тысяч
  // Если есть и запятая, и точка — запятая считается разделителем тысяч.
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/,/g, '');
  } else if (s.includes(',')) {
    // только запятая — это десятичный разделитель
    s = s.replace(',', '.');
  }
  const n = Number(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

// Угадываем, какая колонка — ID участника, а какая — баллы.
export function detectColumns(rows, hints = {}) {
  const header = rows[0].map((h) => String(h).trim());
  const body = rows.slice(1);

  const findByHeader = (re) => header.findIndex((h) => re.test(h.toLowerCase()));

  // 1) если заданы явные имена колонок — используем их
  let idIdx = hints.idColumn ? header.findIndex((h) => h === hints.idColumn) : -1;
  let pointsIdx = hints.pointsColumn ? header.findIndex((h) => h === hints.pointsColumn) : -1;

  // 2) по ключевым словам в заголовке
  if (idIdx < 0) idIdx = findByHeader(/\bid\b|номер|account|account#|ид|код участ/);
  if (pointsIdx < 0)
    pointsIdx = findByHeader(/балл|score|очк|\bpv\b|\bov\b|point|объ[её]м|volume/);

  // 3) запасной вариант — по содержимому колонок
  const numericRatio = (idx) => {
    if (idx < 0 || !body.length) return 0;
    let ok = 0;
    for (const r of body) if (Number.isFinite(toNumber(r[idx]))) ok++;
    return ok / body.length;
  };

  if (pointsIdx < 0) {
    // самая "числовая" колонка с дробями/небольшими значениями — баллы
    let best = -1,
      bestScore = 0;
    for (let i = 0; i < header.length; i++) {
      if (i === idIdx) continue;
      const ratio = numericRatio(i);
      if (ratio > bestScore) {
        bestScore = ratio;
        best = i;
      }
    }
    if (bestScore >= 0.5) pointsIdx = best;
  }

  if (idIdx < 0) {
    // ID — обычно длинные целые числа; берём числовую колонку, не равную баллам
    let best = -1,
      bestScore = 0;
    for (let i = 0; i < header.length; i++) {
      if (i === pointsIdx) continue;
      const ratio = numericRatio(i);
      if (ratio > bestScore) {
        bestScore = ratio;
        best = i;
      }
    }
    if (bestScore >= 0.5) idIdx = best;
  }

  return {
    idIdx,
    pointsIdx,
    header,
    idName: idIdx >= 0 ? header[idIdx] : null,
    pointsName: pointsIdx >= 0 ? header[pointsIdx] : null,
  };
}

// Превращаем CSV-текст в список { id, points, raw } по выбранным колонкам.
export function extractRecords(rows, idIdx, pointsIdx, nameIdx = -1) {
  const body = rows.slice(1);
  const out = [];
  for (const r of body) {
    const id = String(r[idIdx] ?? '').trim();
    if (!id) continue;
    out.push({
      id,
      points: toNumber(r[pointsIdx]),
      name: nameIdx >= 0 ? String(r[nameIdx] ?? '').trim() : '',
    });
  }
  return out;
}
