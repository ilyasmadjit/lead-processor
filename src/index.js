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

function detectAddress(text) {
  const value = (text || "").toLowerCase();
  if (value.includes("шоссей")) return "Шоссейная";
  if (value.includes("краснококш")) return "Краснококшайская";
  if (value.includes("меред") || value.includes("меридиан")) return "Мередианная";
  return "Мередианная";
}

function pickChatId(address) {
  if (address === "Шоссейная") return TELEGRAM_CHAT_ID_SHOSSEINAYA;
  if (address === "Краснококшайская")
    return TELEGRAM_CHAT_ID_KRASNOKOKSHAYSKAYA;
  return TELEGRAM_CHAT_ID_MEREDIANNAYA;
}

function normalize(value) {
  const v = (value || "").toString().trim();
  return v.length > 0 ? v : "";
}

function parseResume(resumeText) {
  const text = normalize(resumeText);

  const name =
    (text.match(/Имя гостя[:\s]+([^\n]+)/i) || [])[1] || "";
  const people =
    (text.match(/Сколько человек[:\s]+([^\n]+)/i) || [])[1] || "";
  const dateTime =
    (text.match(/Дата и время(?: брони)?[:\s]+([^\n]+)/i) || [])[1] || "";
  const hall =
    (text.match(/Зал[:\s]+([^\n]+)/i) || [])[1] || "";
  const comments =
    (text.match(/Дополнительн(?:ый|ые) комментарии?[:\s]+([^\n]+)/i) || [])[1] ||
    "";

  return {
    name: normalize(name),
    people: normalize(people),
    dateTime: normalize(dateTime),
    hall: normalize(hall),
    comments: normalize(comments),
  };
}

function buildMessage(payload) {
  const phone = normalize(payload.phone);
  const linkCall = normalize(payload.link_call);
  const address = normalize(payload.adress);

  const resume = parseResume(payload.resume);

  return [
    "Поступил входящий звонок",
    "",
    `Телефон: ${phone || "—"}`,
    "",
    `Запись диалога: ${linkCall || "—"}`,
    "",
    "Резюме диалога:",
    "",
    `Имя гостя: ${resume.name || "—"}`,
    `Адрес: ${address || "—"}`,
    `Сколько человек: ${resume.people || "—"}`,
    `Дата и время: ${resume.dateTime || "—"}`,
    `Зал: ${resume.hall || "—"}`,
    `Дополнительный комментарии: ${resume.comments || "—"}`,
  ].join("\n");
}

async function sendToTelegram(message, addressSource) {
  if (!bot) {
    logger.warn("Telegram bot не настроен, сообщение не отправлено.");
    return;
  }

  const addressResolved = detectAddress(addressSource);
  const chatId = pickChatId(addressResolved);

  if (!chatId) {
    logger.error("Chat ID для адреса не задан, сообщение пропущено.");
    return;
  }

  await bot.sendMessage(chatId, message, { disable_web_page_preview: true });
  logger.info({ addressResolved, chatId }, "Лид отправлен в Telegram");
}

function isAuthorized(req, payload) {
  if (!WEBHOOK_SECRET) return true;
  const headerSecret = req.header("x-webhook-secret");
  const querySecret = req.query?.secret;
  const bodySecret = payload?.secret;
  return (
    headerSecret === WEBHOOK_SECRET ||
    querySecret === WEBHOOK_SECRET ||
    bodySecret === WEBHOOK_SECRET
  );
}

app.post("/webhook/lptracker", async (req, res) => {
  const payload =
    req.body && Object.keys(req.body).length > 0 ? req.body : req.query;

  logger.info({ payload }, "Webhook payload");

  if (!isAuthorized(req, payload)) {
    res.status(401).json({ status: "unauthorized" });
    return;
  }

  try {
    const message = buildMessage(payload);
    const addressSource = `${payload.adress || ""} ${payload.resume || ""}`;

    await sendToTelegram(message, addressSource);
    res.json({ status: "ok" });
  } catch (err) {
    logger.error({ err }, "Ошибка отправки в Telegram");
    res.status(500).json({ status: "error" });
  }
});

app.listen(PORT, () => {
  logger.info({ PORT }, "Service started");
});
