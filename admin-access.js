// Разбор идентификатора для /addadmin.
// Без префикса: @name = username, +7999… = телефон, одни цифры = Telegram ID.
// Явные формы `id`, `phone` и `username` снимают неоднозначность.

export function normalizeAdminUsername(value) {
  return String(value ?? '').trim().replace(/^@/, '').toLowerCase();
}

export function normalizeAdminPhone(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  // Приводим привычный российский формат 8XXXXXXXXXX к 7XXXXXXXXXX.
  if (digits.length === 11 && digits.startsWith('8')) digits = '7' + digits.slice(1);
  return digits;
}

export function parseAdminTarget(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: 'Не указан ID, номер телефона или username.' };

  const explicit = raw.match(/^(id|phone|tel|username|user|ник)\s+(.+)$/i);
  const hint = explicit?.[1]?.toLowerCase() || '';
  const value = (explicit?.[2] || raw).trim();

  const wantsId = hint === 'id' || (!hint && /^\d+$/.test(value));
  const wantsPhone = ['phone', 'tel'].includes(hint) || (!hint && (value.startsWith('+') || /[()\s-]/.test(value)));

  if (wantsId) {
    if (!/^\d{5,16}$/.test(value)) return { ok: false, error: 'Telegram ID должен состоять из 5–16 цифр.' };
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, error: 'Некорректный Telegram ID.' };
    return { ok: true, type: 'id', value: id, display: String(id) };
  }

  if (wantsPhone) {
    const phone = normalizeAdminPhone(value);
    if (!/^\d{7,15}$/.test(phone)) return { ok: false, error: 'Телефон должен содержать 7–15 цифр, лучше в формате +79991234567.' };
    return { ok: true, type: 'phone', value: phone, display: '+' + phone };
  }

  const username = normalizeAdminUsername(value);
  if (!/^[a-z0-9_]{5,32}$/.test(username)) {
    return { ok: false, error: 'Username должен содержать 5–32 латинских символа, цифры или подчёркивания.' };
  }
  return { ok: true, type: 'username', value: username, display: '@' + username };
}
