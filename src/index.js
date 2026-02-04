'use strict';

const express = require('express');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const TelegramBot = require('node-telegram-bot-api');
const pino = require('pino');
require('dotenv').config();

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const {
  PORT = 3000,
  IMAP_HOST,
  IMAP_PORT = 993,
  IMAP_SECURE = 'true',
  IMAP_USER,
  IMAP_PASSWORD,
  IMAP_MAILBOX = 'INBOX',
  IMAP_POLL_INTERVAL_SEC = 30,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID_SHOSSEINAYA,
  TELEGRAM_CHAT_ID_KRASNOKOKSHAYSKAYA,
  TELEGRAM_CHAT_ID_MEREDIANNAYA,
  TELEGRAM_MESSAGE_PREFIX = 'Новый лид',
  LEAD_FROM_FILTER,
  LEAD_SUBJECT_FILTER
} = process.env;

if (!IMAP_HOST || !IMAP_USER || !IMAP_PASSWORD) {
  logger.warn('IMAP настройки не заданы полностью (IMAP_HOST/IMAP_USER/IMAP_PASSWORD).');
}

if (!TELEGRAM_BOT_TOKEN) {
  logger.warn('TELEGRAM_BOT_TOKEN не задан.');
}

const bot = TELEGRAM_BOT_TOKEN ? new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false }) : null;

const app = express();

app.get('/', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

function normalizeText(value) {
  return (value || '').toString().trim();
}

function detectAddress(summaryText) {
  const text = summaryText.toLowerCase();

  if (text.includes('шоссей')) return 'Шоссейная';
  if (text.includes('краснококш')) return 'Краснококшайская';
  if (text.includes('меред') || text.includes('меридиан')) return 'Мередианная';

  return 'Мередианная';
}

function pickChatId(address) {
  if (address === 'Шоссейная') return TELEGRAM_CHAT_ID_SHOSSEINAYA;
  if (address === 'Краснококшайская') return TELEGRAM_CHAT_ID_KRASNOKOKSHAYSKAYA;
  return TELEGRAM_CHAT_ID_MEREDIANNAYA;
}

function parseLeadFromText(text) {
  const content = text.replace(/\r\n/g, '\n');

  const phone = (content.match(/Телефон:\s*([+\d\s()-]+)/i) || [])[1] || 'Не указан';
  const audio = (content.match(/Запись диалог:\s*(https?:\/\/\S+)/i) || [])[1] || 'Нет';
  const notifyDate = (content.match(/Дата оповещения\s*([^\n]+)/i) || [])[1] || 'Не указана';

  const guest = (content.match(/Имя гостя:\s*([^\n]+)/i) || [])[1] || 'Не указано';
  const address = (content.match(/Адрес:\s*([^\n]+)/i) || [])[1] || 'Не указано';
  const people = (content.match(/Сколько человек:\s*([^\n]+)/i) || [])[1] || 'Не указано';
  const dateTime = (content.match(/Дата и время:\s*([^\n]+)/i) || [])[1] || 'Не указано';
  const hall = (content.match(/Зал:\s*([^\n]+)/i) || [])[1] || 'Не указано';
  const comments = (content.match(/Дополнительные комментарии:\s*([^\n]+)/i) || [])[1] || 'Не указано';

  const summary = [
    `Имя гостя: ${normalizeText(guest)}`,
    `Адрес: ${normalizeText(address)}`,
    `Сколько человек: ${normalizeText(people)}`,
    `Дата и время: ${normalizeText(dateTime)}`,
    `Зал: ${normalizeText(hall)}`,
    `Дополнительные комментарии: ${normalizeText(comments)}`
  ].join('\n');

  return {
    phone: normalizeText(phone),
    audio: normalizeText(audio),
    notifyDate: normalizeText(notifyDate),
    summary,
    address: normalizeText(address),
    rawComments: normalizeText(comments)
  };
}

function buildTelegramMessage(lead, addressResolved) {
  return [
    `${TELEGRAM_MESSAGE_PREFIX}`,
    '',
    `Телефон: ${lead.phone}`,
    `Запись диалог: ${lead.audio}`,
    `Дата оповещения: ${lead.notifyDate}`,
    '',
    'Резюме диалога:',
    lead.summary,
    '',
    `Адрес (определен): ${addressResolved}`
  ].join('\n');
}

async function sendToTelegram(lead) {
  if (!bot) {
    logger.warn('Telegram bot не настроен, сообщение не отправлено.');
    return;
  }

  const combinedAddressSource = `${lead.address} ${lead.rawComments}`.trim().toLowerCase();
  const addressResolved = detectAddress(combinedAddressSource);
  const chatId = pickChatId(addressResolved);

  if (!chatId) {
    logger.error('Chat ID для адреса не задан, сообщение пропущено.');
    return;
  }

  const message = buildTelegramMessage(lead, addressResolved);

  await bot.sendMessage(chatId, message, { disable_web_page_preview: true });
  logger.info({ addressResolved, chatId }, 'Лид отправлен в Telegram');
}

function matchesFilters(envelope) {
  if (LEAD_FROM_FILTER && envelope?.from) {
    const from = envelope.from.map((a) => a.address || '').join(',').toLowerCase();
    if (!from.includes(LEAD_FROM_FILTER.toLowerCase())) return false;
  }

  if (LEAD_SUBJECT_FILTER && envelope?.subject) {
    if (!envelope.subject.toLowerCase().includes(LEAD_SUBJECT_FILTER.toLowerCase())) return false;
  }

  return true;
}

async function processMessage(client, uid) {
  const { source, envelope } = await client.fetchOne(uid, { source: true, envelope: true });

  if (!matchesFilters(envelope)) {
    logger.info({ uid }, 'Письмо не прошло фильтры, пропускаем');
    return;
  }

  const parsed = await simpleParser(source);
  const text = parsed.text || parsed.html || '';

  if (!text) {
    logger.warn({ uid }, 'Письмо без текста');
    return;
  }

  const lead = parseLeadFromText(text);
  await sendToTelegram(lead);
}

async function pollMailbox() {
  if (!IMAP_HOST || !IMAP_USER || !IMAP_PASSWORD) return;

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: Number(IMAP_PORT),
    secure: IMAP_SECURE === 'true',
    auth: {
      user: IMAP_USER,
      pass: IMAP_PASSWORD
    }
  });

  try {
    await client.connect();
    await client.mailboxOpen(IMAP_MAILBOX);

    const lock = await client.getMailboxLock(IMAP_MAILBOX);
    try {
      const searchCriteria = { seen: false };
      const uids = await client.search(searchCriteria);

      for (const uid of uids) {
        try {
          await processMessage(client, uid);
          await client.messageFlagsAdd(uid, ['\\Seen']);
        } catch (err) {
          logger.error({ err, uid }, 'Ошибка обработки письма');
        }
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    logger.error({ err }, 'Ошибка IMAP');
  } finally {
    await client.logout().catch(() => {});
  }
}

let pollingTimer = null;

function startPolling() {
  if (pollingTimer) return;
  const intervalMs = Math.max(Number(IMAP_POLL_INTERVAL_SEC), 10) * 1000;

  pollingTimer = setInterval(pollMailbox, intervalMs);
  pollMailbox();
}

app.listen(PORT, () => {
  logger.info({ PORT }, 'Service started');
  startPolling();
});
