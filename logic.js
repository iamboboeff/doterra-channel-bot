// «Мозг» бота: по импортированным баллам и реестру регистраций решаем,
// кого удалять. Чистые функции — без Telegram и без хранилища, полностью
// тестируются офлайн на реальном CSV.

// Объединяет несколько выгрузок (например, из двух кабинетов doTERRA) в один
// словарь id -> PV. Если человек встретился в обоих — берём максимум баллов,
// чтобы случайно не удалить из-за того, что во втором кабинете у него 0.
// (Используется офлайн-тестами. Боевой путь — store.addImportFile — считает
// так же: пустой PV = 0, дубль из двух кабинетов = максимум.)
export function mergePoints(recordLists) {
  const map = new Map();
  for (const records of recordLists) {
    for (const r of records) {
      const id = String(r.id ?? '').trim();
      if (!id) continue;
      const pv = Number(r.points ?? r.pv);
      const val = Number.isFinite(pv) ? pv : 0; // пусто/битый PV = 0
      map.set(id, Math.max(map.has(id) ? map.get(id) : -Infinity, val));
    }
  }
  return map;
}

// registry: [{ doterraId, userId, username, name }]  — кто связал Telegram с ID
// pointsMap: Map<id, pv>                              — из mergePoints
// threshold: число (по умолчанию 50)
//
// Возвращает 4 списка:
//  toRemove        — зарегистрированные с PV < порога  → их бот может удалить
//  toKeep          — зарегистрированные с PV >= порога → остаются
//  missing         — зарегистрированные, которых НЕТ в выгрузке → НЕ трогаем,
//                    показываем админу (могли не попасть из второго кабинета)
//  unregisteredLow — есть в выгрузке с PV < порога, но не привязаны к Telegram →
//                    бот их не знает, только справочно
export function classify(registry, pointsMap, threshold = 50) {
  const toRemove = [];
  const toKeep = [];
  const missing = [];

  for (const m of registry) {
    const id = String(m.doterraId ?? '').trim();
    if (!pointsMap.has(id)) {
      missing.push({ ...m });
      continue;
    }
    const pv = pointsMap.get(id);
    if (Number.isFinite(pv) && pv < threshold) toRemove.push({ ...m, pv });
    else toKeep.push({ ...m, pv: Number.isFinite(pv) ? pv : null });
  }

  const registeredIds = new Set(registry.map((m) => String(m.doterraId ?? '').trim()));
  const unregisteredLow = [];
  for (const [id, pv] of pointsMap) {
    if (!registeredIds.has(id) && Number.isFinite(pv) && pv < threshold) {
      unregisteredLow.push({ id, pv });
    }
  }

  return { toRemove, toKeep, missing, unregisteredLow };
}
