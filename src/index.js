"use strict";

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const pino = require("pino");
require("dotenv").config();

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const {
  PORT = 3000,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID_SHOSSEINAYA,
  TELEGRAM_CHAT_ID_KRASNOKOKSHAYSKAYA,
  TELEGRAM_CHAT_ID_MEREDIANNAYA,
  WEBHOOK_SECRET,
} = process.env;

if (!TELEGRAM_BOT_TOKEN) {
  logger.warn("TELEGRAM_BOT_TOKEN не задан.");
}

const bot = TELEGRAM_BOT_TOKEN
  ? new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false })
  : null;

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

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

function payloadToText(payload) {
  if (payload == null) return "";
  try {
    return JSON.stringify(payload, null, 2);
  } catch (err) {
    return String(payload);
  }
}

function splitMessage(text, maxSize = 3500) {
  const chunks = [];
  let cursor = 0;
  while (cursor < text.length) {
    chunks.push(text.slice(cursor, cursor + maxSize));
    cursor += maxSize;
  }
  return chunks;
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

  const messageChunks = splitMessage(text);
  for (const chunk of messageChunks) {
    await bot.sendMessage(chatId, chunk, { disable_web_page_preview: true });
  }
  logger.info({ addressResolved, chatId }, "Лид отправлен в Telegram");
}

function isAuthorized(req) {
  if (!WEBHOOK_SECRET) return true;
  const headerSecret = req.header("x-webhook-secret");
  const querySecret = req.query?.secret;
  return headerSecret === WEBHOOK_SECRET || querySecret === WEBHOOK_SECRET;
}

app.post("/webhook/lptracker", async (req, res) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ status: "unauthorized" });
    return;
  }

  const payload =
    req.body && Object.keys(req.body).length > 0 ? req.body : req.query;
  const text = payloadToText(payload);

  if (!text || text === "{}") {
    res.status(400).json({ status: "empty payload" });
    return;
  }

  try {
    await sendToTelegram(text);
    res.json({ status: "ok" });
  } catch (err) {
    logger.error({ err }, "Ошибка отправки в Telegram");
    res.status(500).json({ status: "error" });
  }
});

app.listen(PORT, () => {
  logger.info({ PORT }, "Service started");
});
