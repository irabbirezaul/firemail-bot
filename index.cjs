const fetch = require("node-fetch");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

// --- CONFIG ---
const TOKEN = process.env.BOT_TOKEN;  // Set BOT_TOKEN in Render environment variables
if (!TOKEN) {
  console.error("Error: BOT_TOKEN is not set!");
  process.exit(1);
}
const API = `https://api.telegram.org/bot${TOKEN}`;
const FIREMAIL = "https://firemail.com.br/api";

// --- DATA ---
const DATA_FILE = path.join(__dirname, "data.json");
let data = { users: {}, lastId: 0 };
try { data = JSON.parse(fs.readFileSync(DATA_FILE)); } catch (e) {}

function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch(e) { console.error(e); }
}

// --- TELEGRAM ---
async function sendAPI(method, payload) {
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

async function answerCallback(callbackId) {
  return sendAPI("answerCallbackQuery", { callback_query_id: callbackId });
}

// --- FIREMAIL ---
async function createMail(name=null) {
  const emailName = name || Math.random().toString(36).substring(2,12);
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

// --- HTML & OTP ---
function htmlToText(html) {
  if (!html) return "";
  try { const $ = cheerio.load(html); return $.root().text().replace(/\s+/g, " ").trim(); }
  catch(e) { return html; }
}

function extractOTP(text) {
  if (!text) return null;
  const cleaned = text.replace(/[\u00A0]/g," ");
  const patterns = [/\b(\d{3,8})\b/g,/code[:\s]*([0-9]{3,8})/i,/verification code[:\s]*([0-9]{3,8})/i];
  for(const p of patterns) {
    const m = cleaned.match(p);
    if(m) { for(const mm of m) { const dig = mm.match(/\d{3,8}/); if(dig) return dig[0]; } }
  }
  return null;
}

function detectService(text) {
  if(!text) return "Unknown";
  const s = text.toLowerCase();
  const mapping = { Facebook:["facebook","fb","meta"], WhatsApp:["whatsapp","wa"], Instagram:["instagram","insta","ig"], Telegram:["telegram","tg"], Google:["google","gmail"], Microsoft:["microsoft","outlook","hotmail"], Amazon:["amazon"], Discord:["discord"] };
  for(const [name, keys] of Object.entries(mapping)) for(const k of keys) if(s.includes(k)) return name;
  return "Unknown";
}

// --- USER HELPERS ---
function ensureUser(chatId) {
  if(!data.users[chatId]) { data.users[chatId]={emails:[], active:null, auto:true, lastSeen:{}}; saveData(); }
  return data.users[chatId];
}

function mainKeyboard() {
  return { inline_keyboard:[
    [{text:"➕ Create Random",callback_data:"create:rand"},{text:"✏️ Create Custom",callback_data:"create:custom"}],
    [{text:"📬 My Emails",callback_data:"list:emails"},{text:"🔁 Toggle Auto",callback_data:"toggle:auto"}],
    [{text:"ℹ️ Help",callback_data:"help:1"}]
  ]};
}

// --- POLLING ---
async function handleMessage(update) {
  const msg = update.message; if(!msg) return;
  const chatId = msg.chat.id; const text = (msg.text||"").trim();
  const user = ensureUser(chatId);

  // --- custom email ---
  if(user.waitingCustom) {
    user.waitingCustom=false;
    const name = text.replace(/[^a-zA-Z0-9]/g,"").toLowerCase().substring(0,30);
    if(name.length<4) { saveData(); return sendMessage(chatId,"Invalid name. Use 4-30 letters/numbers.",mainKeyboard()); }
    const email = await createMail(name);
    if(!email) return sendMessage(chatId,"Failed to create custom email.");
    const n = email.split("@")[0]; if(!user.emails.includes(n)) user.emails.push(n); user.active = user.active || n; saveData();
    return sendMessage(chatId,`✅ Created: <code>${email}</code>`,mainKeyboard());
  }

  // --- commands ---
  if(text==="/start") return sendMessage(chatId,"FireMail bot ready",mainKeyboard());
  if(text==="/newrand"||text==="/new") {
    const email = await createMail(); if(!email) return sendMessage(chatId,"Failed to create email.");
    const n=email.split("@")[0]; if(!user.emails.includes(n)) user.emails.push(n); user.active = user.active||n; saveData();
    return sendMessage(chatId,`✅ Created: <code>${email}</code>`,mainKeyboard());
  }
  if(text.startsWith("/newname")||text.startsWith("/newcustom")) {
    const parts = text.split(" "); const name=parts[1];
    if(!name) return sendMessage(chatId,"Usage: /newname customname");
    const clean=name.replace(/[^a-zA-Z0-9]/g,"").toLowerCase().substring(0,30);
    if(clean.length<4) return sendMessage(chatId,"Name too short (min 4).");
    const email = await createMail(clean); if(!email) return sendMessage(chatId,"Failed to create custom email.");
    const n=email.split("@")[0]; if(!user.emails.includes(n)) user.emails.push(n); user.active=user.active||n; saveData();
    return sendMessage(chatId,`✅ Created: <code>${email}</code>`,mainKeyboard());
  }
}

// --- AUTO SCAN ---
async function autoScan() {
  for(const [chatIdStr,user] of Object.entries(data.users)) {
    const chatId=parseInt(chatIdStr); if(!user.auto) continue;
    for(const emailName of user.emails) {
      try{
        const box = await getInbox(emailName); if(box.status!=="success") continue;
        const messages = box.data.messages||[]; if(!messages.length) continue;
        const latest = messages[0]; const lastSeenId=user.lastSeen?.[emailName]||null;
        if(latest.id===lastSeenId) continue;
        user.lastSeen=user.lastSeen||{}; user.lastSeen[emailName]=latest.id; saveData();
        const htmlBody=latest.body||""; const textBody=htmlToText(htmlBody); const combined=`${latest.subject||""} ${latest.from||""} ${textBody}`;
        const otp = extractOTP(combined); const service=detectService(combined);
        let out=`📩 <b>New mail — ${emailName}</b>\nService: <b>${service}</b>\nFrom: ${latest.from}\nSubject: ${latest.subject||"No subject"}`;
        if(otp) out+=`\n\n🔐 <b>OTP:</b> <code>${otp}</code>`; else out+=`\n\n(Body preview)\n${textBody.substring(0,400)}`;
        await sendMessage(chatId,out);
      } catch(e){ console.error("scan error",e); }
    }
  }
  setTimeout(autoScan,4000);
}

// --- POLLING LOOP ---
async function pollLoop() {
  try {
    const res = await fetch(`${API}/getUpdates?offset=${data.lastId+1}&timeout=20`);
    const j = await res.json();
    if(j.ok && j.result.length){
      for(const u of j.result){ data.lastId = u.update_id;
        if(u.callback_query){ /* can add callback handler here */ } 
        else if(u.message){ await handleMessage(u); }
      }
      saveData();
    }
  } catch(e){ console.error("poll error", e); }
  setTimeout(pollLoop, 800);
}

// --- START ---
console.log("FireMail bot started");
pollLoop();
autoScan();
