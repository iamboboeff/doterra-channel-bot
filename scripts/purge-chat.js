#!/usr/bin/env node
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import QRCode from 'qrcode';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { buildPurgePlan, parseUserIds, purgePlanCsv } from '../purge-policy.js';

loadEnv({ path: resolve('cleanup.env'), override: true, quiet: true });

const DEFAULT_CHAT_ID = '-1001593559029';
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) continue;
    const equal = value.indexOf('=');
    if (equal > 2) {
      args[value.slice(2, equal)] = value.slice(equal + 1);
      continue;
    }
    const key = value.slice(2);
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[key] = argv[++i];
    else args[key] = true;
  }
  return args;
}

function help() {
  console.log(`
Одноразовая безопасная очистка Telegram-чата.

Просмотр (никого не удаляет):
  npm run cleanup:preview
После запуска отсканируй cleanup-plans/telegram-login-qr.png в Telegram → Настройки → Устройства.

Выполнение (только после просмотра):
  npm run cleanup:execute -- --links-revoked --confirm "DELETE <chat_id> <count> <fingerprint>"

Параметры:
  --chat-id <id>       по умолчанию PURGE_CHAT_ID, TIER1_ID или ${DEFAULT_CHAT_ID}
  --execute            разрешить удаление
  --links-revoked      подтвердить, что старые ссылки отозваны
  --confirm <phrase>   точная фраза из просмотра
  --help               эта справка
`);
}

async function resolveDialog(client, expectedChatId) {
  for await (const dialog of client.iterDialogs({ limit: 500 })) {
    const id = String(await client.getPeerId(dialog.entity));
    if (id === expectedChatId) return dialog.entity;
  }
  throw new Error(`Личный Telegram-аккаунт не видит чат ${expectedChatId}.`);
}

async function signInUserByQr(client, apiId, apiHash) {
  const baseDir = resolve(process.env.PURGE_EXPORT_DIR || 'cleanup-plans');
  mkdirSync(baseDir, { recursive: true });
  const qrPath = resolve(baseDir, 'telegram-login-qr.png');
  let announced = false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);
  timeout.unref?.();
  await client.connect();
  try {
    const user = await client.signInUserWithQrCode(
      { apiId, apiHash },
      {
      qrCode: async ({ token }) => {
        // Buffer.from is intentional: some MTProto forks expose a Uint8Array at
        // runtime even though their TypeScript declarations say Buffer. Calling
        // Uint8Array#toString would produce comma-separated bytes and Telegram
        // would report an invalid QR code.
        const encodedToken = Buffer.from(token).toString('base64url');
        if (!/^[A-Za-z0-9_-]+$/.test(encodedToken)) throw new Error('Telegram вернул некорректный QR-токен.');
        const uri = `tg://login?token=${encodedToken}`;
        await QRCode.toFile(qrPath, uri, { width: 520, margin: 2, errorCorrectionLevel: 'M' });
        chmodSync(qrPath, 0o600);
        const ttl = Math.max(0, Number(expires) - Math.floor(Date.now() / 1000));
        if (!announced) {
          console.log(`\nQR для входа готов: ${qrPath}`);
          console.log('Telegram на телефоне → Настройки → Устройства → Подключить устройство.');
          console.log(`QR действует около ${ttl || 30} секунд.`);
          announced = true;
        } else {
          console.log(`QR обновлён (действует около ${ttl || 30} секунд).`);
        }
      },
      password: async () => {
        const password = String(process.env.TELEGRAM_2FA_PASSWORD || '');
        if (!password) throw new Error('Включена Telegram 2FA: временно добавь TELEGRAM_2FA_PASSWORD в .env.');
        return password;
      },
        onError: async (error) => {
          console.error(`QR-вход: ${error.message}`);
          return true;
        },
        abortSignal: controller.signal,
      },
    );
    return user;
  } finally {
    clearTimeout(timeout);
    try { unlinkSync(qrPath); } catch {}
  }
}

async function botApi(token, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!body.ok) {
    const error = new Error(body.description || `${method}: HTTP ${response.status}`);
    error.retryAfter = Number(body.parameters?.retry_after) || 0;
    throw error;
  }
  return body.result;
}

async function verifyCleanupBot(token, chatId) {
  const bot = await botApi(token, 'getMe', {});
  const member = await botApi(token, 'getChatMember', { chat_id: chatId, user_id: bot.id });
  const allowed = member.status === 'creator' || (member.status === 'administrator' && member.can_restrict_members === true);
  if (!allowed) throw new Error('Боту нужно право «Банить участников» в целевом чате.');
  return bot;
}

function exportPlan(plan, chatTitle) {
  const baseDir = resolve(process.env.PURGE_EXPORT_DIR || 'cleanup-plans');
  mkdirSync(baseDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `cleanup-${String(plan.chatId).replace(/[^0-9-]/g, '')}-${stamp}`;
  const jsonPath = resolve(baseDir, `${base}.json`);
  const csvPath = resolve(baseDir, `${base}.csv`);
  const safePlan = {
    createdAt: new Date().toISOString(),
    chatId: plan.chatId,
    chatTitle,
    total: plan.total,
    removeCount: plan.remove.length,
    keepCount: plan.keep.length,
    fingerprint: plan.fingerprint,
    confirmation: plan.confirmation,
    keep: plan.keep,
    remove: plan.remove,
  };
  writeFileSync(jsonPath, JSON.stringify(safePlan, null, 2), { mode: 0o600 });
  writeFileSync(csvPath, purgePlanCsv(plan), { mode: 0o600 });
  return { jsonPath, csvPath };
}

function floodWaitSeconds(error) {
  const retryAfter = Number(error?.retryAfter);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter;
  const direct = Number(error?.seconds);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const match = String(error?.errorMessage || error?.message || '').match(/FLOOD_WAIT_?(\d+)/i);
  return match ? Number(match[1]) : 0;
}

async function kickWithFloodWait(botToken, chatId, userId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await botApi(botToken, 'banChatMember', { chat_id: chatId, user_id: userId });
      await pause(500);
      await botApi(botToken, 'unbanChatMember', { chat_id: chatId, user_id: userId, only_if_banned: true });
      return;
    } catch (error) {
      const seconds = floodWaitSeconds(error);
      if (!seconds || seconds > 900 || attempt > 0) throw error;
      console.log(`Telegram попросил паузу ${seconds} сек. Жду и продолжаю…`);
      await pause((seconds + 2) * 1000);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { help(); return; }

  const chatId = String(args['chat-id'] || process.env.PURGE_CHAT_ID || process.env.TIER1_ID || DEFAULT_CHAT_ID).trim();
  if (!/^-100\d+$/.test(chatId)) throw new Error(`Неверный chat_id: ${chatId}`);

  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = String(process.env.TELEGRAM_API_HASH || '').trim();
  const botToken = String(process.env.BOT_TOKEN || '').trim();
  if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
    throw new Error('Добавь TELEGRAM_API_ID и TELEGRAM_API_HASH в .env (из my.telegram.org → API development tools).');
  }
  if (!/^\d{6,}:[\w-]{30,}$/.test(botToken)) throw new Error('Нет корректного BOT_TOKEN в .env.');

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
    floodSleepThreshold: 60,
  });
  let signedInUser = false;
  let stopRequested = false;
  process.once('SIGINT', () => {
    stopRequested = true;
    console.log('\nОстанавливаюсь после текущего участника…');
  });

  try {
    const cleanupBot = await verifyCleanupBot(botToken, chatId);
    const me = await signInUserByQr(client, apiId, apiHash);
    signedInUser = true;
    const chat = await resolveDialog(client, chatId);
    const chatTitle = String(chat?.title || process.env.PURGE_CHAT_TITLE || process.env.TIER1_NAME || chatId);
    const users = await client.getParticipants(chat, {});
    const keepIds = parseUserIds(process.env.PURGE_KEEP_USER_IDS);
    keepIds.add(String(me.id));
    keepIds.add(String(cleanupBot.id));
    const plan = buildPurgePlan(chatId, users, keepIds);

    const paths = exportPlan(plan, chatTitle);
    console.log(`\nЧат: ${chatTitle} (${chatId})`);
    console.log(`Всего получено: ${plan.total}`);
    console.log(`Оставаем (владелец, админы, боты, allowlist): ${plan.keep.length}`);
    console.log(`К удалению: ${plan.remove.length}`);
    console.log(`Резервный JSON: ${paths.jsonPath}`);
    console.log(`Резервный CSV:  ${paths.csvPath}`);

    if (!args.execute) {
      console.log('\n✅ Это был только просмотр. Никто не удалён.');
      console.log('После отзыва старых ссылок команда выполнения:');
      console.log(`npm run cleanup:execute -- --links-revoked --confirm "${plan.confirmation}"`);
      return;
    }

    if (!args['links-revoked']) {
      throw new Error('Очистка отменена: сначала отзови старые пригласительные ссылки и добавь --links-revoked.');
    }
    if (String(args.confirm || '') !== plan.confirmation) {
      throw new Error(`Очистка отменена: список изменился или фраза неверна. Текущая фраза: ${plan.confirmation}`);
    }

    const executionPath = paths.jsonPath.replace(/\.json$/, '-result.json');
    const result = {
      startedAt: new Date().toISOString(),
      chatId,
      chatTitle,
      planned: plan.remove.length,
      removed: [],
      failed: [],
      stopped: false,
    };
    const checkpoint = () => writeFileSync(executionPath, JSON.stringify(result, null, 2), { mode: 0o600 });
    checkpoint();

    for (let index = 0; index < plan.remove.length; index++) {
      if (stopRequested) { result.stopped = true; break; }
      const row = plan.remove[index];
      try {
        await kickWithFloodWait(botToken, chatId, row.id);
        result.removed.push(row.id);
      } catch (error) {
        result.failed.push({ id: row.id, error: String(error?.errorMessage || error?.message || error) });
      }
      if ((index + 1) % 10 === 0 || index + 1 === plan.remove.length) {
        checkpoint();
        console.log(`Готово ${index + 1}/${plan.remove.length} · удалено ${result.removed.length} · ошибок ${result.failed.length}`);
      }
      await pause(250);
    }
    result.finishedAt = new Date().toISOString();
    checkpoint();
    console.log(`\n✅ Очистка завершена. Удалено: ${result.removed.length}; ошибок: ${result.failed.length}.`);
    console.log(`Отчёт: ${executionPath}`);
  } finally {
    if (signedInUser) {
      try { await client.logOut(); }
      catch { await client.disconnect(); }
    } else {
      await client.disconnect();
    }
  }
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`);
  process.exitCode = 1;
});
