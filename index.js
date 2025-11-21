const fetch = require("node-fetch");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

// Read environment variables from Railway
const TOKEN = process.env.BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;
const FIREMAIL = "https://firemail.com.br/api";

// Data storage
const DATA_FILE = path.join(__dirname, "data.json");
let data = { users: {}, lastId: 0 };
try { data = JSON.parse(fs.readFileSync(DATA_FILE)); } catch (e) {}

// Save data
function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch (e) { console.error(e); }
}

// Telegram API helper
async function sendAPI(method, payload) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return res.json();
}

// Send message
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

// OTP detection (3-8 digits)
function extractOTP(text) {
  const m = text.match(/\b\d{3,8}\b/);
  return m ? m[0] : null;
}

// Ensure user exists
function ensureUser(chatId) {
  if (!data.users[chatId]) {
    data.users[chatId] = { emails: [], active: null, auto: true, lastSeen: {} };
    saveData();
  }
  return data.users[chatId];
}

// Start polling
async function pollLoop() {
  try {
    const res = await fetch(`${API}/getUpdates?offset=${data.lastId+1}&timeout=20`);
    const j = await res.json();
    if (j.ok && j.result.length) {
      for (const u of j.result) {
        data.lastId = u.update_id;
        const chatId = u.message?.chat?.id;
        if (chatId) await handleMessage(chatId, u.message.text);
      }
      saveData();
    }
  } catch(e) { console.error("poll error", e); }
  setTimeout(pollLoop, 1000);
}

// Handle message
async function handleMessage(chatId, text) {
  const user = ensureUser(chatId);
  if (!text) return;
  text = text.trim();

  if (text === "/start") return sendMessage(chatId, "FireMail bot ready. Use /newrand or /list.");

  if (text === "/newrand" || text === "/new") {
    const email = await createMail();
    if (!email) return sendMessage(chatId, "Failed to create email.");
    const n = email.split("@")[0];
    if (!user.emails.includes(n)) user.emails.push(n);
    user.active = user.active || n;
    saveData();
    return sendMessage(chatId, `✅ Created: <code>${email}</code>`);
  }

  if (text.startsWith("/newname")) {
    const name = text.split(" ")[1];
    if (!name) return sendMessage(chatId, "Usage: /newname customname");
    const clean = name.replace(/[^a-z0-9]/gi, "").substring(0,30);
    const email = await createMail(clean);
    if (!email) return sendMessage(chatId, "Failed to create custom email.");
    const n = email.split("@")[0];
    if (!user.emails.includes(n)) user.emails.push(n);
    user.active = user.active || n;
    saveData();
    return sendMessage(chatId, `✅ Created: <code>${email}</code>`);
  }

  if (text === "/list") {
    if (!user.emails.length) return sendMessage(chatId, "No emails. Use /newrand to create one.");
    return sendMessage(chatId, "Your emails:\n" + user.emails.map(e => `${e}@firemail.com.br`).join("\n"));
  }
}

// Auto-scan inbox
async function autoScan() {
  for (const [chatIdStr, user] of Object.entries(data.users)) {
    if (!user.auto) continue;
    const chatId = parseInt(chatIdStr);
    for (const emailName of user.emails) {
      try {
        const box = await getInbox(emailName);
        if (box.status !== "success") continue;
        const messages = box.data.messages || [];
        if (!messages.length) continue;
        const latest = messages[0];
        if (user.lastSeen?.[emailName] === latest.id) continue;
        user.lastSeen = user.lastSeen || {};
        user.lastSeen[emailName] = latest.id;
        saveData();
        const otp = extractOTP(latest.body || latest.subject || "");
        let out = `📩 New mail for ${emailName}\nFrom: ${latest.from}\nSubject: ${latest.subject}`;
        if (otp) out += `\n🔐 OTP: <code>${otp}</code>`;
        await sendMessage(chatId, out);
      } catch(e) { console.error("scan error", e); }
    }
  }
  setTimeout(autoScan, 4000);
}

console.log("FireMail bot started");
pollLoop();
autoScan();
