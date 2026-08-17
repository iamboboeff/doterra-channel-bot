// HTTP-приём данных напрямую из расширения doTERRA (авто-пуш).
// Работает РЯДОМ с обычным long-polling бота: расширение после экспорта шлёт
// `POST /ingest` с телом { month, cabinet, rows:[[id,имя,pv], …] } и секретом.
//
// Безопасно по умолчанию: без секрета (INGEST_SECRET) или без порта сервер не
// поднимается / отклоняет всё. Никого не удаляет — только отдаёт данные боту,
// а тот кладёт их во «входящие» и ждёт подтверждения администратора.
import { createServer } from 'node:http';

const MAX_BODY = 8_000_000; // ~8 МБ — с большим запасом на самый крупный кабинет

// Приводим тело к массиву записей { id, name, pv }. Принимаем и «массив строк»
// [[id,имя,pv], …], и «массив объектов» [{id,name,pv}|{ID,Имя,PV}], и голый массив.
export function normalizeRows(payload) {
  const src = Array.isArray(payload) ? payload : (payload?.rows || payload?.records || payload?.data || []);
  if (!Array.isArray(src)) return [];
  const out = [];
  for (const r of src) {
    if (Array.isArray(r)) out.push({ id: r[0], name: r[1], pv: r[2] });
    else if (r && typeof r === 'object') out.push({ id: r.id ?? r.ID, name: r.name ?? r['Имя'] ?? r.Name, pv: r.pv ?? r.PV ?? r.points });
  }
  return out.filter((r) => String(r.id ?? '').trim() !== '');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > MAX_BODY) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// onPush(rows, meta) → summary | Promise<summary>. Вызывается только после
// успешной авторизации и разбора тела. Всё остальное — транспорт.
export function startIngestServer({ port, secret, onPush, log = console.log } = {}) {
  if (!port) { log('ℹ️  HTTP-приём из расширения выключен (нет PORT/INGEST_PORT).'); return null; }

  const server = createServer(async (req, res) => {
    // CORS — на случай запроса из контекста страницы; из popup расширения не нужен.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, x-ingest-token, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

    const url = new URL(req.url, 'http://local');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok');
    }
    if (req.method !== 'POST' || url.pathname !== '/ingest') { res.writeHead(404); return res.end('not found'); }

    // Авторизация: Bearer-заголовок, либо x-ingest-token, либо ?token=…
    const bearer = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    const tok = bearer || String(req.headers['x-ingest-token'] || '').trim() || url.searchParams.get('token') || '';
    if (!secret || tok !== secret) { res.writeHead(401); return res.end('unauthorized'); }

    let body;
    try { body = await readBody(req); }
    catch (e) { res.writeHead(e.message === 'too large' ? 413 : 400); return res.end(e.message); }

    let payload;
    try { payload = JSON.parse(body || '{}'); }
    catch { res.writeHead(400); return res.end('bad json'); }

    const rows = normalizeRows(payload);
    if (!rows.length) { res.writeHead(400); return res.end('no rows'); }

    try {
      const meta = {
        month: String(payload.month || '').trim(),
        cabinet: String(payload.cabinet || payload.source || '').trim(),
        team: String(payload.team || payload.group || '').trim(),
        mode: String(payload.mode || '').trim(),
        name: String(payload.name || '').trim(),
      };
      const summary = (await onPush?.(rows, meta)) || {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...summary }));
    } catch (e) {
      log('ingest onPush:', e.message);
      res.writeHead(500); res.end('server error');
    }
  });

  server.on('error', (e) => log('ingest server:', e.message));
  server.listen(port, () => log(`✓ HTTP-приём из расширения: порт ${port} (POST /ingest, GET /health)`));
  return server;
}
