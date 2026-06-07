require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const Jimp = require('jimp');
const Database = require('better-sqlite3');
const fs = require('fs');

// ─── CONFIG ───────────────────────────────────────────────
const ADMIN_ID = 7126311531;
const CHANNEL_ID = -1002693570480;
// ──────────────────────────────────────────────────────────

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const db = new Database('tokens.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT,
    ca TEXT,
    price REAL,
    mc REAL,
    name TEXT,
    symbol TEXT,
    timestamp INTEGER
  )
`);

// Pending signals waiting for admin approval
const pendingSignals = {};

// ─── DB HELPERS ───────────────────────────────────────────
function saveSnapshot(chatId, ca, price, mc, name, symbol) {
  try {
    db.prepare(`
      INSERT INTO snapshots (chat_id, ca, price, mc, name, symbol, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(String(chatId), ca, price, mc, name, symbol, Date.now());
  } catch(e) { console.error('DB error:', e); }
}

function getSnapshot(chatId, ca) {
  try {
    return db.prepare(`
      SELECT * FROM snapshots 
      WHERE chat_id = ? AND ca = ?
      ORDER BY timestamp ASC
      LIMIT 1
    `).get(String(chatId), ca);
  } catch(e) { return null; }
}

// ─── FORMATTERS ───────────────────────────────────────────
function fmt(num) {
  if (!num) return 'N/A';
  if (num >= 1e9) return '$' + (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return '$' + (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return '$' + (num / 1e3).toFixed(1) + 'K';
  return '$' + num.toFixed(2);
}

function fmtPrice(p) {
  if (!p) return 'N/A';
  const n = parseFloat(p);
  if (n < 0.000001) return '$' + n.toExponential(2);
  if (n < 0.01) return '$' + n.toFixed(8);
  if (n < 1) return '$' + n.toFixed(4);
  return '$' + n.toLocaleString(undefined, {maximumFractionDigits: 2});
}

function fmtChange(c) {
  if (!c && c !== 0) return 'N/A';
  const arrow = c >= 0 ? '🟢' : '🔴';
  return `${arrow} ${c >= 0 ? '+' : ''}${parseFloat(c).toFixed(2)}%`;
}

// ─── API CALLS ────────────────────────────────────────────
async function getTokenData(ca) {
  const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${ca}`);
  const pairs = res.data.pairs;
  if (!pairs || pairs.length === 0) return null;
  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  return pairs[0];
}

async function getRugcheck(ca) {
  try {
    const res = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${ca}/report`);
    return res.data;
  } catch(e) { return null; }
}

function checkDexPaid(p) {
  try {
    if (p.boosts && p.boosts.active > 0) return '✅ Paid';
    if (p.profile) return '✅ Paid';
    if (p.info && (p.info.header || p.info.openGraph || p.info.description)) return '✅ Paid';
    return '❌ Not Paid';
  } catch(e) { return '❌ Not Paid'; }
}

async function getHolderCount(ca, rugData) {
  if (rugData?.tokenMeta?.holderCount) return rugData.tokenMeta.holderCount.toLocaleString();
  if (rugData?.markets?.length > 0) {
    for (const m of rugData.markets) {
      if (m.holderCount && m.holderCount > 0) return m.holderCount.toLocaleString();
    }
  }
  if (rugData?.holders?.length > 0) return rugData.holders.length.toLocaleString() + '+';
  try {
    const res = await axios.get(
      `https://public-api.birdeye.so/defi/token_overview?address=${ca}`,
      { headers: { 'X-API-KEY': 'public
