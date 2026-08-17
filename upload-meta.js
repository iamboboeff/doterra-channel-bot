import { normalizeTeam, resolveTeam, TEAM_ANGELIKA, TEAM_GUEST } from './billing.js';

// Новое расширение отправляет JSON в подписи Telegram-документа. Старые
// подписи остаются обычной меткой кабинета и безопасно относятся к Анджелике.
export function parseUploadCaption(caption) {
  const raw = String(caption || '').trim();
  if (!raw) return { team: TEAM_ANGELIKA, cabinet: '' };

  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return {
          team: normalizeTeam(parsed.team),
          cabinet: String(parsed.cabinet || '').trim(),
        };
      }
    } catch {}
  }

  const fields = Object.fromEntries(
    raw.split(/[;\n]+/)
      .map((part) => part.split('=').map((value) => value.trim()))
      .filter((pair) => pair.length >= 2 && pair[0])
      .map(([key, ...rest]) => [key.toLowerCase(), rest.join('=')])
  );
  if (fields.team || fields.cabinet) {
    return {
      team: normalizeTeam(fields.team),
      cabinet: String(fields.cabinet || '').trim(),
    };
  }

  const exact = raw.toLowerCase();
  if (exact === 'гость' || exact === 'guest') return { team: TEAM_GUEST, cabinet: raw };
  return { team: TEAM_ANGELIKA, cabinet: raw };
}

// Новые CSV дублируют метки источника в колонках. Это запасной путь на
// случай, если файл скачали и потом переслали вручную без Telegram-подписи.
export function parseUploadCsvMeta(rows) {
  const header = Array.isArray(rows?.[0]) ? rows[0].map((value) => String(value || '').trim().toLowerCase()) : [];
  const teamIdx = header.findIndex((value) => ['команда', 'team'].includes(value));
  const cabinetIdx = header.findIndex((value) => ['кабинет', 'cabinet', 'source'].includes(value));

  let team = null;
  let cabinet = '';
  for (const row of Array.isArray(rows) ? rows.slice(1) : []) {
    const rawTeam = teamIdx >= 0 ? String(row?.[teamIdx] || '').trim() : '';
    if (rawTeam) team = team == null ? normalizeTeam(rawTeam) : resolveTeam(team, rawTeam);
    if (!cabinet && cabinetIdx >= 0) cabinet = String(row?.[cabinetIdx] || '').trim();
  }
  return { team, cabinet };
}

// Структурированная подпись нового расширения имеет приоритет. Если её нет,
// берём команду из CSV. Так старые файлы остаются командой Анджелики.
export function resolveUploadMeta(caption, csvMeta = {}) {
  const raw = String(caption || '').trim();
  const captionMeta = parseUploadCaption(raw);
  let captionHasTeam = false;

  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      captionHasTeam = !!(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.team != null);
    } catch {}
  }
  if (!captionHasTeam) captionHasTeam = /(?:^|[;\n])\s*team\s*=/i.test(raw);
  if (!captionHasTeam) captionHasTeam = /^(анджелика|angelika|гость|guest)$/i.test(raw);

  return {
    team: captionHasTeam ? captionMeta.team : (csvMeta.team || captionMeta.team),
    cabinet: captionMeta.cabinet || String(csvMeta.cabinet || '').trim(),
  };
}
