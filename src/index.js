"use strict";

const express = require("express");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const TelegramBot = require("node-telegram-bot-api");
const pino = require("pino");
require("dotenv").config();

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const {
  PORT = 3000,
  IMAP_HOST,
  IMAP_PORT = 993,
  IMAP_SECURE = "true",
  IMAP_USER,
  IMAP_MAILBOX = "INBOX",
  IMAP_POLL_INTERVAL_SEC = 30,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID_SHOSSEINAYA,
  TELEGRAM_CHAT_ID_KRASNOKOKSHAYSKAYA,
  TELEGRAM_CHAT_ID_MEREDIANNAYA,
  LEAD_FROM_FILTER,
  LEAD_SUBJECT_FILTER,
  IMAP_PASSWORD,
} = process.env;

if (!IMAP_HOST || !IMAP_USER) {
  logger.warn("IMAP настройки не заданы полностью (IMAP_HOST/IMAP_USER).");
}

if (!IMAP_PASSWORD) {
  logger.warn("IMAP пароль приложения не задан (IMAP_PASSWORD).");
}

if (!TELEGRAM_BOT_TOKEN) {
  logger.warn("TELEGRAM_BOT_TOKEN не задан.");
}

const bot = TELEGRAM_BOT_TOKEN
  ? new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false })
  : null;

const app = express();

app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

function detectAddress(summaryText) {
  const text = summaryText.toLowerCase();

  if (text.includes("шоссей")) return "Шоссейная";
  if (text.includes("краснококш")) return "Краснококшайская";
  if (text.includes("меред") || text.includes("меридиан")) return "Мередианная";

  return "Мередианная";
}

function pickChatId(address) {
  if (address === "Шоссейная") return TELEGRAM_CHAT_ID_SHOSSEINAYA;
  if (address === "Краснококшайская")
    return TELEGRAM_CHAT_ID_KRASNOKOKSHAYSKAYA;
  return TELEGRAM_CHAT_ID_MEREDIANNAYA;
}

async function sendToTelegram(text) {
  if (!bot) {
    logger.warn("Telegram bot не настроен, сообщение не отправлено.");
    return;
  }

  const addressResolved = detectAddress(text);
  const chatId = pickChatId(addressResolved);

  if (!chatId) {
    logger.error("Chat ID для адреса не задан, сообщение пропущено.");
    return;
  }

  const message = text;

  await bot.sendMessage(chatId, message, { disable_web_page_preview: true });
  logger.info({ addressResolved, chatId }, "Лид отправлен в Telegram");
}

function matchesFilters(envelope) {
  if (LEAD_FROM_FILTER && envelope?.from) {
    const from = envelope.from
      .map((a) => a.address || "")
      .join(",")
      .toLowerCase();
    if (!from.includes(LEAD_FROM_FILTER.toLowerCase())) return false;
  }

  if (LEAD_SUBJECT_FILTER && envelope?.subject) {
    if (
      !envelope.subject
        .toLowerCase()
        .includes(LEAD_SUBJECT_FILTER.toLowerCase())
    )
      return false;
  }

  return true;
}

async function processMessage(client, uid) {
  const { source, envelope } = await client.fetchOne(uid, {
    source: true,
    envelope: true,
  });

  if (!matchesFilters(envelope)) {
    logger.info({ uid }, "Письмо не прошло фильтры, пропускаем");
    return;
  }

  const parsed = await simpleParser(source);
  const text = parsed.text || parsed.html || "";

  if (!text) {
    logger.warn({ uid }, "Письмо без текста");
    return;
  }

  await sendToTelegram(text);
}

async function pollMailbox() {
  if (!IMAP_HOST || !IMAP_USER || !IMAP_PASSWORD) return;

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: Number(IMAP_PORT),
    secure: IMAP_SECURE === "true",
    auth: {
      user: IMAP_USER,
      pass: IMAP_PASSWORD,
    },
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
          await client.messageFlagsAdd(uid, ["\\Seen"]);
        } catch (err) {
          logger.error({ err, uid }, "Ошибка обработки письма");
        }
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    logger.error({ err }, "Ошибка IMAP");
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
  logger.info({ PORT }, "Service started");
  startPolling();
});
