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
  YANDEX_CLIENT_ID,
  YANDEX_CLIENT_SECRET,
  YANDEX_REFRESH_TOKEN,
  YANDEX_OAUTH_TOKEN_URL = "https://oauth.yandex.com/token",
} = process.env;

if (!IMAP_HOST || !IMAP_USER) {
  logger.warn("IMAP настройки не заданы полностью (IMAP_HOST/IMAP_USER).");
}

if (!YANDEX_CLIENT_ID || !YANDEX_CLIENT_SECRET || !YANDEX_REFRESH_TOKEN) {
  logger.warn(
    "OAuth настройки Yandex не заданы полностью (YANDEX_CLIENT_ID/YANDEX_CLIENT_SECRET/YANDEX_REFRESH_TOKEN).",
  );
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

let oauthCache = {
  accessToken: null,
  refreshToken: YANDEX_REFRESH_TOKEN || null,
  expiresAt: 0,
};

async function refreshAccessToken() {
  if (!YANDEX_CLIENT_ID || !YANDEX_CLIENT_SECRET || !oauthCache.refreshToken) {
    throw new Error("OAuth credentials are missing");
  }

  const credentials = Buffer.from(
    `${YANDEX_CLIENT_ID}:${YANDEX_CLIENT_SECRET}`,
  ).toString("base64");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: oauthCache.refreshToken,
  });

  const response = await fetch(YANDEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OAuth refresh failed: ${response.status} ${text}`);
  }

  const data = await response.json();

  oauthCache.accessToken = data.access_token;
  oauthCache.expiresAt = Date.now() + (Number(data.expires_in) || 0) * 1000;

  if (data.refresh_token && data.refresh_token !== oauthCache.refreshToken) {
    oauthCache.refreshToken = data.refresh_token;
    logger.warn(
      "Yandex refresh_token обновился. Обновите переменную YANDEX_REFRESH_TOKEN в Render.",
    );
  }

  return oauthCache.accessToken;
}

async function getAccessToken() {
  const now = Date.now();
  if (oauthCache.accessToken && oauthCache.expiresAt - now > 60_000) {
    return oauthCache.accessToken;
  }
  return refreshAccessToken();
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
  if (!IMAP_HOST || !IMAP_USER) return;

  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    logger.error({ err }, "Не удалось получить OAuth токен для IMAP");
    return;
  }

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: Number(IMAP_PORT),
    secure: IMAP_SECURE === "true",
    auth: {
      user: IMAP_USER,
      accessToken,
      method: "XOAUTH2",
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
