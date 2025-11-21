const fetch = require("node-fetch");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const TOKEN = "YOUR_BOT_TOKEN"; // Replace with your Telegram bot token
const API = `https://api.telegram.org/bot${TOKEN}`;
const FIREMAIL = "https://firemail.com.br/api";

const DATA_FILE = path.join(__dirname, "data.json");
let data = { users: {}, lastId: 0 };
try { data = JSON.parse(fs.readFileSync(DATA_FILE)); } catch (e) {}

function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch (e) { console.error("save error", e); }
}

function sendAPI(method, payload) {
  return fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }).then(r => r.json());
}

async function sendMessage(chatId, text, keyboard = null) {
  const params = { chat_id: chatId, text, parse_mode: "HTML" };
  if (keyboard) params.reply_markup = JSON.stringify(keyboard);
  return sendAPI("sendMessage", params);
}

// FireMail API
async function createMail(name = null) {
  const emailName = name || Math.random().toString(36).substring(2, 12);
  const res = await fetch(`${FIREMAIL}/email/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: emailName })
  });
  const j = await res.json();
  if (j.status === "success") return j.data.email;
  return null;
}

async function getInbox(name) {
  const res = await fetch(`${FIREMAIL}/email/check/${name}`);
  return res.json();
}

async function getMessage(name, id) {
  const res = await fetch(`${FIREMAIL}/email/message/${name}/${id}`);
  return res.json();
}

// HTML -> text (cheerio)
function htmlToText(html) {
  if (!html) return "";
  try {
    const $ = cheerio.load(html);
    return $.root().text().replace(/\s+/g, " ").trim();
  } catch (e) {
    return html;
  }
}

// OTP extraction
function extractOTP(text) {
  if (!text) return null;
  const patterns = [
    /\b(\d{3,8})\b/g,
    /code[:\s]*([0-9]{3,8})/i,
    /verification code[:\s]*([0-9]{3,8})/i
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0];
  }
  return null;
}

function detectService(text) {
  if (!text) return "Unknown";
  const s = text.toLowerCase();
  const mapping = {
    Facebook: ["facebook", "fb", "meta"],
    WhatsApp: ["whatsapp", "wa"],
    Instagram: ["instagram", "insta", "ig"],
    Telegram: ["telegram", "tg"],
    Google: ["google", "gmail"],
    Microsoft: ["microsoft", "outlook", "hotmail"],
    Amazon: ["amazon"],
    Discord: ["discord"]
  };
  for (const [name, keys] of Object.entries(mapping)) {
    for (const k of keys) if (s.includes(k)) return name;
  }
  return "Unknown";
}

// Ensure user
function ensureUser(chatId) {
  if (!data.users[chatId]) {
    data.users[chatId] = { emails: [], active: null, auto: true, lastSeen: {} };
    saveData();
  }
  return data.users[chatId];
}

// Main keyboard
function mainKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "➕ Random Email", callback_data: "create:rand" }, { text: "✏️ Custom Email", callback_data: "create:custom" }],
      [{ text: "📬 My Emails", callback_data: "list:emails" }, { text: "🔁 Toggle Auto", callback_data: "toggle:auto" }],
      [{ text: "ℹ️ Help", callback_data: "help:1" }]
    ]
  };
}

// Polling & commands
async function handleMessage(update) {
  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const user = ensureUser(chatId);

  if (text === "/start") return sendMessage(chatId, "FireMail bot ready", mainKeyboard());
  if (text === "/newrand") {
    const email = await createMail();
    if (!email) return sendMessage(chatId, "Failed to create email.");
    const n = email.split("@")[0];
    if (!user.emails.includes(n)) user.emails.push(n);
    user.active = user.active || n;
    saveData();
    return sendMessage(chatId, `✅ Created: <code>${email}</code>`, mainKeyboard());
  }
  if (text.startsWith("/newname")) {
    const name = text.split(" ")[1];
    if (!name) return sendMessage(chatId, "Usage: /newname customname");
    const clean = name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().substring(0,30);
    if (clean.length < 4) return sendMessage(chatId, "Name too short (min 4).");
    const email = await createMail(clean);
    if (!email) return sendMessage(chatId, "Failed to create email.");
    const n = email.split("@")[0];
    if (!user.emails.includes(n)) user.emails.push(n);
    user.active = user.active || n;
    saveData();
    return sendMessage(chatId, `✅ Created: <code>${email}</code>`, mainKeyboard());
  }
  if (text === "/list") return sendMessage(chatId, JSON.stringify(user.emails, null, 2), mainKeyboard());
}

// Poll loop
async function pollLoop() {
  try {
    const res = await fetch(`${API}/getUpdates?offset=${data.lastId+1}&timeout=20`);
    const j = await res.json();
    if (j.ok && j.result.length) {
      for (const u of j.result) {
        data.lastId = u.update_id;
        if (u.message) await handleMessage(u);
      }
      saveData();
    }
  } catch (e) {
    console.error("poll error", e);
  }
  setTimeout(pollLoop, 1000);
}

console.log("FireMail bot started");
pollLoop();
