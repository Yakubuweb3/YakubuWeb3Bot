require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const Jimp = require('jimp');
const Database = require('better-sqlite3');
const fs = require('fs');

// ── NEW: GramJS (optional — loaded lazily so bot still runs if not installed yet) ──
let TelegramClient, StringSession, NewMessage, GRAMJS_AVAILABLE = false;
try {
  ({ TelegramClient } = require('telegram'));
  ({ StringSession } = require('telegram/sessions'));
  ({ NewMessage } = require('telegram/events'));
  GRAMJS_AVAILABLE = true;
} catch (e) {
  console.log('[GramJS] "telegram" package ba a samu ba — Alpha Group Listener zai kasance OFF. Yi "npm install telegram" idan kana son wannan feature.');
}

// ═══════════════════════════════════════════════════════════
//  YakubuWeb3 Signal Bot — v2
//  + Smart Wallet Tracking (curated + auto-verified)
//  + Telegram Alpha-Group Listener (GramJS)
//  + Crowdsourced Wallet Submission + Auto-Verification
//  + AI Explanation Layer
//  NEW ENV VARS NEEDED — see .env.example
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════
const ADMIN_ID           = 7126311531;
const CHANNEL_ID         = -1002693570480;
const MAX_SIGNALS_PER_DAY = 5;
const SCAN_INTERVAL_MS   = 30 * 60 * 1000;
const MIN_LIQUIDITY      = 3000;
const MIN_AGE_HOURS      = 1;
const MAX_AGE_HOURS      = 12;
const MAX_RUG_SCORE      = 800;
const SCORE_PASS_MIN     = 35;

// ── NEW: Wallet Tracking / AI / GramJS Config ──
const SOLANA_RPC_URL        = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const ANTHROPIC_API_KEY     = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL              = 'claude-haiku-4-5-20251001';
const TG_API_ID             = parseInt(process.env.TG_API_ID || '0');
const TG_API_HASH           = process.env.TG_API_HASH || '';
const TG_SESSION            = process.env.TG_SESSION || '';
const ALPHA_GROUPS          = (process.env.ALPHA_GROUPS || '').split(',').map(s => s.trim()).filter(Boolean); // numeric chat IDs
const CURATED_WALLETS       = (process.env.CURATED_WALLETS || '').split(',').map(s => s.trim()).filter(Boolean);
const WALLET_CHECK_INTERVAL_MS     = 5 * 60 * 1000;
const SUBMISSION_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const PREMIUM_REWARD_DAYS          = 5;
const MIN_WIN_RATE_FOR_VERIFICATION = 50;
const MIN_TOKENS_FOR_VERIFICATION   = 3;
const SOLANA_ADDRESS_REGEX = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const EARLY_TX_LIMIT        = 80;  // max early transactions scanned per /analyze (bounds RPC cost/time)
const SNIPER_WINDOW_SECONDS = 90;  // buys within this many seconds of pool creation count as snipers

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// ═══════════════════════════════════════════════════════════
//  DATABASE
// ═══════════════════════════════════════════════════════════
const db = new Database('tokens.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT, ca TEXT, price REAL, mc REAL,
    name TEXT, symbol TEXT, timestamp INTEGER
  );
  CREATE TABLE IF NOT EXISTS signals_sent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ca TEXT, date TEXT, timestamp INTEGER
  );
  CREATE TABLE IF NOT EXISTS scanned_tokens (
    ca TEXT PRIMARY KEY, last_scanned INTEGER
  );
  CREATE TABLE IF NOT EXISTS paper_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ca TEXT, name TEXT, symbol TEXT,
    entry_price REAL, entry_mc REAL,
    target1 REAL, target2 REAL, stop_loss REAL,
    sol_amount REAL DEFAULT 1,
    status TEXT DEFAULT 'open',
    result TEXT, pnl_pct REAL, pnl_sol REAL,
    opened_at INTEGER, closed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT UNIQUE NOT NULL,
    source TEXT DEFAULT 'manual',
    submitted_by TEXT,
    verification_status TEXT DEFAULT 'pending',
    success_score INTEGER DEFAULT 0,
    win_rate REAL DEFAULT 0,
    total_trades_tracked INTEGER DEFAULT 0,
    last_checked INTEGER,
    last_active_at INTEGER,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS wallet_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT,
    submitted_by TEXT,
    source TEXT DEFAULT 'manual',
    status TEXT DEFAULT 'pending',
    reward_given INTEGER DEFAULT 0,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS premium_users (
    telegram_id TEXT PRIMARY KEY,
    expires_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS alpha_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ca TEXT, wallet_address TEXT, alpha_score INTEGER,
    notified INTEGER DEFAULT 0, created_at INTEGER
  );
`);

const pendingSignals = {};
let isScanning = false;

// ═══════════════════════════════════════════════════════════
//  DATABASE HELPERS
// ═══════════════════════════════════════════════════════════
function getTodaySignalCount() {
  const today = new Date().toISOString().split('T')[0];
  const row = db.prepare('SELECT COUNT(*) as count FROM signals_sent WHERE date = ?').get(today);
  return row ? row.count : 0;
}

function recordSignalSent(ca) {
  const today = new Date().toISOString().split('T')[0];
  db.prepare('INSERT INTO signals_sent (ca, date, timestamp) VALUES (?, ?, ?)').run(ca, today, Date.now());
}

function alreadyScanned(ca) {
  const row = db.prepare('SELECT * FROM scanned_tokens WHERE ca = ?').get(ca);
  if (!row) return false;
  return (Date.now() - row.last_scanned) < 6 * 60 * 60 * 1000;
}

function markScanned(ca) {
  db.prepare('INSERT OR REPLACE INTO scanned_tokens (ca, last_scanned) VALUES (?, ?)').run(ca, Date.now());
}

function saveSnapshot(chatId, ca, price, mc, name, symbol) {
  try {
    db.prepare('INSERT INTO snapshots (chat_id, ca, price, mc, name, symbol, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)').run(String(chatId), ca, price, mc, name, symbol, Date.now());
  } catch(e) {}
}

function getSnapshot(chatId, ca) {
  try {
    return db.prepare('SELECT * FROM snapshots WHERE chat_id = ? AND ca = ? ORDER BY timestamp ASC LIMIT 1').get(String(chatId), ca);
  } catch(e) { return null; }
}

function openPaperTrade(ca, name, symbol, entryPrice, entryMc, target1, target2, stopLoss) {
  try {
    db.prepare('INSERT INTO paper_trades (ca, name, symbol, entry_price, entry_mc, target1, target2, stop_loss, sol_amount, status, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)').run(ca, name, symbol, entryPrice, entryMc, target1, target2, stopLoss, 'open', Date.now());
  } catch(e) { console.error('Paper trade error:', e); }
}

function getOpenTrades() {
  try { return db.prepare('SELECT * FROM paper_trades WHERE status = ?').all('open'); }
  catch(e) { return []; }
}

function closePaperTrade(id, result, pnlPct, pnlSol) {
  try {
    db.prepare('UPDATE paper_trades SET status = ?, result = ?, pnl_pct = ?, pnl_sol = ?, closed_at = ? WHERE id = ?').run('closed', result, pnlPct, pnlSol, Date.now(), id);
  } catch(e) {}
}

function getWeeklyStats() {
  try {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const trades = db.prepare('SELECT * FROM paper_trades WHERE closed_at > ? AND status = ?').all(weekAgo, 'closed');
    if (trades.length === 0) return null;
    const wins = trades.filter(t => t.result === 'T1' || t.result === 'T2' || t.result === 'T1_partial').length;
    const totalPnlSol = trades.reduce((a, b) => a + (b.pnl_sol || 0), 0);
    const winRate = ((wins / trades.length) * 100).toFixed(0);
    const bestTrade = [...trades].sort((a, b) => (b.pnl_pct || 0) - (a.pnl_pct || 0))[0];
    return { total: trades.length, wins, winRate, totalPnlSol: totalPnlSol.toFixed(3), bestTrade };
  } catch(e) { return null; }
}

// ── NEW: WALLET TRACKING DB HELPERS ─────────────────────────
function addWalletSubmission(address, source, submittedBy) {
  try {
    const exists = db.prepare('SELECT id FROM wallets WHERE address = ?').get(address);
    if (exists) return;
    const dup = db.prepare("SELECT id FROM wallet_submissions WHERE wallet_address = ? AND status = 'pending'").get(address);
    if (dup) return;
    db.prepare('INSERT INTO wallet_submissions (wallet_address, submitted_by, source, created_at) VALUES (?, ?, ?, ?)').run(address, submittedBy || 'unknown', source, Date.now());
    console.log('[Wallet] New submission queued: ' + address.slice(0, 6) + '... via ' + source);
  } catch(e) { console.error('addWalletSubmission error:', e.message); }
}

function getPendingSubmissions(limit) {
  return db.prepare('SELECT * FROM wallet_submissions WHERE status = ? ORDER BY created_at ASC LIMIT ?').all('pending', limit || 10);
}

function markSubmission(id, status) {
  db.prepare('UPDATE wallet_submissions SET status = ? WHERE id = ?').run(status, id);
}

function addVerifiedWallet(address, source, submittedBy, winRate, successScore, totalTrades) {
  db.prepare(`INSERT INTO wallets (address, source, submitted_by, verification_status, win_rate, success_score, total_trades_tracked, last_checked, last_active_at, created_at)
              VALUES (?, ?, ?, 'verified', ?, ?, ?, ?, ?, ?)
              ON CONFLICT(address) DO UPDATE SET verification_status='verified', win_rate=excluded.win_rate, success_score=excluded.success_score, total_trades_tracked=excluded.total_trades_tracked, last_checked=excluded.last_checked`)
    .run(address, source, submittedBy || null, winRate, successScore, totalTrades, Date.now(), Date.now(), Date.now());
}

function getVerifiedWallets() {
  return db.prepare("SELECT * FROM wallets WHERE verification_status = 'verified'").all();
}

function grantPremium(telegramId, days) {
  const existing = db.prepare('SELECT * FROM premium_users WHERE telegram_id = ?').get(String(telegramId));
  const base = existing && existing.expires_at > Date.now() ? existing.expires_at : Date.now();
  const newExpiry = base + days * 24 * 60 * 60 * 1000;
  db.prepare(`INSERT INTO premium_users (telegram_id, expires_at) VALUES (?, ?)
              ON CONFLICT(telegram_id) DO UPDATE SET expires_at = excluded.expires_at`).run(String(telegramId), newExpiry);
  return newExpiry;
}

function isPremium(telegramId) {
  const row = db.prepare('SELECT * FROM premium_users WHERE telegram_id = ?').get(String(telegramId));
  return !!(row && row.expires_at > Date.now());
}

function logAlphaSignal(ca, walletAddress, alphaScore) {
  db.prepare('INSERT INTO alpha_signals (ca, wallet_address, alpha_score, created_at) VALUES (?, ?, ?, ?)').run(ca, walletAddress, alphaScore, Date.now());
}

// ═══════════════════════════════════════════════════════════
//  FORMATTERS
// ═══════════════════════════════════════════════════════════
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
  return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtChange(c) {
  if (!c && c !== 0) return 'N/A';
  const icon = c >= 0 ? 'UP' : 'DOWN';
  return icon + ' ' + (c >= 0 ? '+' : '') + parseFloat(c).toFixed(2) + '%';
}

function fmtChangeEmoji(c) {
  if (!c && c !== 0) return 'N/A';
  const icon = c >= 0 ? '🟢' : '🔴';
  return icon + ' ' + (c >= 0 ? '+' : '') + parseFloat(c).toFixed(2) + '%';
}

function getRugEmoji(score) {
  if (score === 'N/A') return '⚪ UNKNOWN';
  const s = Number(score);
  if (s >= 800) return '🔴 HIGH RISK';
  if (s >= 500) return '🟡 MODERATE RISK';
  return '🟢 SAFE';
}

// ═══════════════════════════════════════════════════════════
//  API HELPERS
// ═══════════════════════════════════════════════════════════
async function getTokenData(ca) {
  const res = await axios.get('https://api.dexscreener.com/latest/dex/tokens/' + ca);
  const pairs = res.data.pairs;
  if (!pairs || pairs.length === 0) return null;
  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  return pairs[0];
}

async function getRugcheck(ca) {
  try {
    const res = await axios.get('https://api.rugcheck.xyz/v1/tokens/' + ca + '/report');
    return res.data;
  } catch(e) { return null; }
}

function checkDexPaid(p) {
  try {
    if (p.boosts && p.boosts.active > 0) return true;
    if (p.profile) return true;
    if (p.info && (p.info.header || p.info.openGraph || p.info.description)) return true;
    return false;
  } catch(e) { return false; }
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
    const res = await axios.get('https://public-api.birdeye.so/defi/token_overview?address=' + ca, {
      headers: { 'X-API-KEY': 'public', 'x-chain': 'solana' }, timeout: 5000
    });
    if (res.data?.data?.holder > 0) return res.data.data.holder.toLocaleString();
  } catch(e) {}
  if (rugData?.topHolders?.length) return rugData.topHolders.length + '+';
  return 'N/A';
}

async function fetchCandidateTokens() {
  const results = [];
  try {
    const res = await axios.get('https://api.dexscreener.com/token-boosts/top/v1', { timeout: 10000 });
    (res.data || []).filter(t => t.chainId === 'solana').forEach(t => { if (t.tokenAddress) results.push(t.tokenAddress); });
  } catch(e) { console.error('[fetchCandidateTokens] token-boosts error:', e.response?.status || e.message); }
  try {
    const res = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 10000 });
    (res.data || []).filter(t => t.chainId === 'solana').forEach(t => { if (t.tokenAddress) results.push(t.tokenAddress); });
  } catch(e) { console.error('[fetchCandidateTokens] token-profiles error:', e.response?.status || e.message); }
  const unique = [...new Set(results)];
  console.log('[fetchCandidateTokens] fetched ' + unique.length + ' candidate token(s)');
  return unique;
}

// ── NEW: SOLANA RPC HELPERS (Wallet Tracking) ───────────────
async function rpcCall(method, params) {
  try {
    const res = await axios.post(SOLANA_RPC_URL, { jsonrpc: '2.0', id: 1, method, params }, { timeout: 12000 });
    if (res.data?.error) { return null; }
    return res.data?.result || null;
  } catch(e) { return null; }
}

async function getWalletRecentSignatures(address, limit) {
  return await rpcCall('getSignaturesForAddress', [address, { limit: limit || 25 }]);
}

async function getParsedTransaction(signature) {
  return await rpcCall('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
}

// Heuristic: scan recent signatures for SPL token balance increases owned by `address` (i.e. buys)
async function getWalletRecentTokenBuys(address, txLimit) {
  const sigs = await getWalletRecentSignatures(address, txLimit || 25);
  if (!sigs || sigs.length === 0) return [];
  const mints = new Set();
  for (const s of sigs.slice(0, txLimit || 25)) {
    const tx = await getParsedTransaction(s.signature);
    if (!tx) { await new Promise(r => setTimeout(r, 250)); continue; }
    const post = tx.meta?.postTokenBalances || [];
    const pre  = tx.meta?.preTokenBalances || [];
    for (const pb of post) {
      const preMatch = pre.find(p => p.accountIndex === pb.accountIndex);
      const preAmt = preMatch ? Number(preMatch.uiTokenAmount?.uiAmount || 0) : 0;
      const postAmt = Number(pb.uiTokenAmount?.uiAmount || 0);
      if (postAmt > preAmt && pb.owner === address && pb.mint !== 'So11111111111111111111111111111111111111112') {
        mints.add(pb.mint);
      }
    }
    await new Promise(r => setTimeout(r, 300)); // safe pacing for free public RPC
  }
  return [...mints];
}

// ── NEW: REAL ON-CHAIN BUNDLE & SNIPER DETECTION (manual /analyze only) ──
// Scans the earliest transactions on the liquidity pool address since pool
// creation. A single transaction touching 2+ distinct buyer wallets = bundle.
// A solo buy within SNIPER_WINDOW_SECONDS of pool creation = sniper.
async function getEarlySignaturesSince(address, sinceMs) {
  let all = [];
  let before;
  const MAX_PAGES = 5;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = before ? [address, { limit: 1000, before }] : [address, { limit: 1000 }];
    const batch = await rpcCall('getSignaturesForAddress', params);
    if (!batch || batch.length === 0) break;
    all.push(...batch);
    const oldest = batch[batch.length - 1];
    before = oldest.signature;
    const oldestMs = (oldest.blockTime || 0) * 1000;
    if (oldestMs > 0 && oldestMs <= sinceMs) break;
    await new Promise(r => setTimeout(r, 300));
  }
  return all.filter(s => s.blockTime).sort((a, b) => a.blockTime - b.blockTime);
}

async function sumCurrentHoldingsPct(wallets, tokenMint, totalSupply) {
  let sum = 0;
  for (const w of wallets) {
    try {
      const res = await rpcCall('getTokenAccountsByOwner', [w, { mint: tokenMint }, { encoding: 'jsonParsed' }]);
      if (res?.value) {
        for (const acc of res.value) {
          sum += Number(acc.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
        }
      }
    } catch(e) {}
    await new Promise(r => setTimeout(r, 250));
  }
  return totalSupply > 0 ? Math.min(100, (sum / totalSupply) * 100) : 0;
}

async function detectBundlesAndSnipers(pairAddress, tokenMint, pairCreatedAtMs) {
  try {
    const allEarly = await getEarlySignaturesSince(pairAddress, pairCreatedAtMs);
    if (!allEarly || allEarly.length === 0) return { available: false, reason: 'No transaction history found' };
    const window = allEarly.slice(0, EARLY_TX_LIMIT);

    const slotBuyers = {}; // slot -> Set of buyer wallets (catches multi-tx Jito bundles, the common real pattern)
    const txRecords = []; // { slot, buyers, blockTime } per scanned tx

    for (const sig of window) {
      const tx = await getParsedTransaction(sig.signature);
      if (!tx) { await new Promise(r => setTimeout(r, 250)); continue; }
      const slot = tx.slot;
      const pre = tx.meta?.preTokenBalances || [];
      const post = tx.meta?.postTokenBalances || [];
      const buyers = [];
      for (const pb of post) {
        if (pb.mint !== tokenMint) continue;
        const preMatch = pre.find(p => p.accountIndex === pb.accountIndex);
        const preAmt = preMatch ? Number(preMatch.uiTokenAmount?.uiAmount || 0) : 0;
        const postAmt = Number(pb.uiTokenAmount?.uiAmount || 0);
        if (postAmt > preAmt && pb.owner && pb.owner !== pairAddress) buyers.push(pb.owner);
      }
      const distinctBuyers = [...new Set(buyers)];
      if (distinctBuyers.length > 0) {
        if (!slotBuyers[slot]) slotBuyers[slot] = new Set();
        distinctBuyers.forEach(w => slotBuyers[slot].add(w));
        txRecords.push({ slot, buyers: distinctBuyers, blockTime: sig.blockTime });
      }
      await new Promise(r => setTimeout(r, 300));
    }

    // A bundle = 2+ distinct wallets buying in the SAME SLOT — whether that's one
    // transaction with multiple buyers, or several transactions landing together
    // (the standard Jito-bundle pattern used for coordinated launch sniping).
    const bundledWallets = new Set();
    let bundleSlotCount = 0;
    for (const slot in slotBuyers) {
      if (slotBuyers[slot].size >= 2) {
        bundleSlotCount++;
        slotBuyers[slot].forEach(w => bundledWallets.add(w));
      }
    }

    const sniperWallets = new Set();
    for (const rec of txRecords) {
      if (rec.buyers.length !== 1) continue;
      const w = rec.buyers[0];
      if (bundledWallets.has(w)) continue;
      const secsAfterLaunch = ((rec.blockTime * 1000) - pairCreatedAtMs) / 1000;
      if (secsAfterLaunch >= 0 && secsAfterLaunch <= SNIPER_WINDOW_SECONDS) sniperWallets.add(w);
    }

    const supplyInfo = await rpcCall('getTokenSupply', [tokenMint]);
    const totalSupply = supplyInfo?.value?.uiAmount || 0;

    const bundleCurrentPct = totalSupply > 0 ? await sumCurrentHoldingsPct([...bundledWallets], tokenMint, totalSupply) : 0;
    const sniperCurrentPct = totalSupply > 0 ? await sumCurrentHoldingsPct([...sniperWallets], tokenMint, totalSupply) : 0;

    return {
      available: true,
      bundleCount: bundledWallets.size,
      bundleTxCount: bundleSlotCount,
      bundleCurrentPct,
      sniperCount: sniperWallets.size,
      sniperCurrentPct,
      txScanned: window.length
    };
  } catch(e) {
    console.error('detectBundlesAndSnipers error:', e.message);
    return { available: false, reason: e.message };
  }
}

// ═══════════════════════════════════════════════════════════
//  ROAD MAP 2 — DEX ANALYSIS ENGINE
// ═══════════════════════════════════════════════════════════

// ── 1. VOLUME MOMENTUM SCORING ──────────────────────────────
function scoreVolumeMomentum(p) {
  let score = 0;
  const notes = [];

  const v5m  = parseFloat(p.volume?.m5  || 0);
  const v1h  = parseFloat(p.volume?.h1  || 0);
  const v6h  = parseFloat(p.volume?.h6  || 0);
  const v24h = parseFloat(p.volume?.h24 || 0);

  const ch5m  = parseFloat(p.priceChange?.m5  || 0);
  const ch1h  = parseFloat(p.priceChange?.h1  || 0);
  const ch6h  = parseFloat(p.priceChange?.h6  || 0);
  const ch24h = parseFloat(p.priceChange?.h24 || 0);

  const buys   = p.txns?.h1?.buys   || 0;
  const sells  = p.txns?.h1?.sells  || 0;
  const buys24 = p.txns?.h24?.buys  || 0;
  const sells24 = p.txns?.h24?.sells || 0;

  if (v6h > 0) {
    const v1hShare = (v1h / v6h) * 100;
    if (v1hShare > 40)      { score += 20; notes.push('🔥 Volume spike last 1h (' + v1hShare.toFixed(0) + '% of 6h vol)'); }
    else if (v1hShare > 25) { score += 12; notes.push('📈 Rising volume (' + v1hShare.toFixed(0) + '% of 6h vol)'); }
    else if (v1hShare > 15) { score += 6;  notes.push('📊 Moderate volume'); }
  }

  if (v1h > 0 && v5m > 0) {
    const v5mRate = v5m / (v1h / 12);
    if (v5mRate > 3)        { score += 15; notes.push('⚡ 5m volume 3x above average'); }
    else if (v5mRate > 1.5) { score += 8;  notes.push('📈 5m volume above average'); }
  }

  if (buys + sells > 0) {
    const buyPct = (buys / (buys + sells)) * 100;
    if (buyPct > 70)      { score += 15; notes.push('🟢 Strong buy pressure (' + buyPct.toFixed(0) + '% buys 1h)'); }
    else if (buyPct > 55) { score += 8;  notes.push('🟡 Moderate buy pressure (' + buyPct.toFixed(0) + '% buys 1h)'); }
    else if (buyPct < 40) { score -= 10; notes.push('🔴 Sell pressure dominant (' + buyPct.toFixed(0) + '% buys 1h)'); }
  }

  if (buys24 + sells24 > 0) {
    const buyPct24 = (buys24 / (buys24 + sells24)) * 100;
    if (buyPct24 > 65)      { score += 10; notes.push('✅ Healthy buy/sell ratio 24h'); }
    else if (buyPct24 < 35) { score -= 8;  notes.push('⚠️ More sells than buys 24h'); }
  }

  if (ch5m > 5 && ch1h > 10)    { score += 10; notes.push('🚀 Price momentum strong (5m + 1h both up)'); }
  if (ch5m < -5 && ch1h < -5)   { score -= 15; notes.push('📉 Negative momentum (dumping)'); }
  if (ch24h > 50 && ch1h < -10) { score -= 10; notes.push('⚠️ Possible dead cat bounce'); }

  return { score: Math.max(0, Math.min(score, 100)), notes };
}

// ── 2. WHALE DETECTION ──────────────────────────────────────
function scoreWhaleDetection(p, rug) {
  let score = 0;
  const notes = [];
  const whales = [];

  if (!rug) return { score: 0, notes: ['⚪ No rug data for whale analysis'], whales };

  const liq = p.liquidity?.usd || 0;
  const mc  = p.fdv || 0;

  const holdersData = rug?.topHolders || rug?.holders || [];
  if (Array.isArray(holdersData) && holdersData.length > 0) {
    const filtered = holdersData
      .map(h => ({ address: h.address || '', pct: Number(h.pct || h.percentage || h.share || 0) }))
      .filter(h => h.address && h.pct > 0 && h.pct < 50)
      .sort((a, b) => b.pct - a.pct);

    const top1pct  = filtered[0]?.pct || 0;
    const top10pct = filtered.slice(0, 10).reduce((a, b) => a + b.pct, 0);

    if (top1pct > 10)      { score -= 20; notes.push('🐋 DANGER: Top holder owns ' + top1pct.toFixed(1) + '% — dump risk'); }
    else if (top1pct > 5)  { score -= 8;  notes.push('⚠️ Top holder owns ' + top1pct.toFixed(1) + '%'); }
    else if (top1pct < 3)  { score += 10; notes.push('✅ Top holder only ' + top1pct.toFixed(1) + '% — distributed'); }

    if (top10pct < 15)      { score += 15; notes.push('✅ Excellent distribution — top 10 hold ' + top10pct.toFixed(1) + '%'); }
    else if (top10pct < 20) { score += 8;  notes.push('🟡 Good distribution — top 10 hold ' + top10pct.toFixed(1) + '%'); }
    else if (top10pct > 30) { score -= 10; notes.push('🔴 Concentrated — top 10 hold ' + top10pct.toFixed(1) + '%'); }

    filtered.slice(0, 5).forEach((h, i) => {
      if (h.pct > 1) whales.push({ rank: i + 1, address: h.address.slice(0, 6) + '...' + h.address.slice(-4), pct: h.pct.toFixed(2) });
    });
  }

  if (rug.insiderNetworks?.length > 0) {
    const boughtPct = rug.insiderNetworks.reduce((a, b) => a + (b.holdingPercent || 0), 0);
    const nowPct    = rug.insiderNetworks.reduce((a, b) => a + (b.currentHoldingPercent || 0), 0);
    if (boughtPct > 30)      { score -= 25; notes.push('🔴 DANGER: Bundles bought ' + boughtPct.toFixed(1) + '%, still hold ' + nowPct.toFixed(1) + '%'); }
    else if (boughtPct > 15) { score -= 12; notes.push('⚠️ Bundles: ' + boughtPct.toFixed(1) + '% bought, ' + nowPct.toFixed(1) + '% remaining'); }
    else                      { score += 5;  notes.push('✅ Low bundle activity (' + boughtPct.toFixed(1) + '%)'); }
  } else {
    score += 10;
    notes.push('✅ No bundles detected');
  }

  if (rug.snipers?.length > 0) {
    const sniperPct = rug.snipers.reduce((a, b) => a + (b.holdingPercent || 0), 0);
    const nowPct    = rug.snipers.reduce((a, b) => a + (b.currentHoldingPercent || 0), 0);
    if (sniperPct > 10) { score -= 15; notes.push('🎯 Snipers: ' + rug.snipers.length + ' wallets, ' + sniperPct.toFixed(1) + '% bought, ' + nowPct.toFixed(1) + '% holding'); }
    else                { score += 5;  notes.push('✅ Low sniper activity (' + rug.snipers.length + ' wallets)'); }
  } else {
    score += 5;
    notes.push('✅ No snipers detected');
  }

  if (mc > 0 && liq > 0) {
    const liqRatio = (liq / mc) * 100;
    if (liqRatio > 15)     { score += 10; notes.push('✅ Strong liquidity ratio (' + liqRatio.toFixed(1) + '% of MC)'); }
    else if (liqRatio > 8) { score += 5;  notes.push('🟡 Moderate liquidity (' + liqRatio.toFixed(1) + '% of MC)'); }
    else                   { score -= 5;  notes.push('⚠️ Low liquidity ratio (' + liqRatio.toFixed(1) + '% of MC)'); }
  }

  return { score: Math.max(0, Math.min(score, 100)), notes, whales };
}

// ── 3. SMART MONEY TRACKING ─────────────────────────────────
function scoreSmartMoney(p, rug) {
  let score = 0;
  const notes = [];

  if (!rug) return { score: 0, notes: ['⚪ No data for smart money analysis'] };

  const v1h  = p.volume?.h1 || 0;
  const buys = p.txns?.h1?.buys || 0;

  if (buys > 0 && v1h > 0) {
    const avgBuySize = v1h / buys;
    if (avgBuySize > 1000)     { score += 20; notes.push('💰 Avg buy size $' + avgBuySize.toFixed(0) + ' — large wallets buying'); }
    else if (avgBuySize > 500) { score += 12; notes.push('💵 Avg buy size $' + avgBuySize.toFixed(0) + ' — decent wallet sizes'); }
    else if (avgBuySize > 200) { score += 6;  notes.push('🟡 Avg buy size $' + avgBuySize.toFixed(0) + ' — small/retail buys'); }
    else                        { notes.push('⚠️ Very small avg buy $' + avgBuySize.toFixed(0) + ' — mostly bots/small wallets'); }
  }

  if (rug.creator) {
    const devHolder = (rug?.topHolders || []).find(h => h.address === rug.creator);
    const devPct = devHolder ? Number(devHolder.pct || 0) : 0;
    const devBal = rug.creatorBalance ? rug.creatorBalance / 1e9 : 0;

    if (devPct === 0)     { score += 15; notes.push('✅ Dev sold/burned tokens — not holding'); }
    else if (devPct < 2)  { score += 8;  notes.push('✅ Dev holds only ' + devPct.toFixed(1) + '% — low risk'); }
    else if (devPct > 5)  { score -= 15; notes.push('🔴 Dev holds ' + devPct.toFixed(1) + '% — dump risk!'); }
    else                   { score += 2;  notes.push('🟡 Dev holds ' + devPct.toFixed(1) + '%'); }

    if (devBal < 1)       { score += 5;  notes.push('✅ Dev wallet low SOL balance'); }
    else if (devBal > 10) { score -= 5;  notes.push('⚠️ Dev wallet has ' + devBal.toFixed(1) + ' SOL'); }
  }

  if (rug.score !== undefined) {
    const rs = Number(rug.score);
    if (rs < 200)      { score += 20; notes.push('🟢 Very safe rug score: ' + rs); }
    else if (rs < 400) { score += 12; notes.push('🟡 Acceptable rug score: ' + rs); }
    else if (rs < 600) { score += 4;  notes.push('🟠 Moderate rug score: ' + rs); }
    else               { score -= 15; notes.push('🔴 High rug score: ' + rs + ' — risky!'); }
  }

  const hasSocials = (p.info?.socials?.length > 0) || (p.info?.websites?.length > 0);
  if (hasSocials) { score += 8; notes.push('✅ Has social links / website'); }
  else            { score -= 5; notes.push('⚠️ No socials — anonymous project'); }

  if (p.boosts?.active > 0 || p.profile || p.info?.header) {
    score += 7;
    notes.push('✅ Dex paid — team spending on marketing');
  }

  if (rug.markets?.length > 0) {
    const locked = rug.markets.some(m => m.lp?.lpLockedPct > 50);
    if (locked) { score += 15; notes.push('🔒 Liquidity locked — strong signal'); }
    else        { score -= 5;  notes.push('⚠️ Liquidity not locked'); }
  }

  return { score: Math.max(0, Math.min(score, 100)), notes };
}

// ── 4. MASTER SCORE ─────────────────────────────────────────
function calcTokenStrength(p, rug) {
  const momentum = scoreVolumeMomentum(p);
  const whale    = scoreWhaleDetection(p, rug);
  const smart    = scoreSmartMoney(p, rug);

  const finalScore = Math.round(
    (momentum.score * 0.35) +
    (whale.score    * 0.35) +
    (smart.score    * 0.30)
  );

  let grade, gradeEmoji;
  if (finalScore >= 80)      { grade = 'S'; gradeEmoji = '🏆'; }
  else if (finalScore >= 65) { grade = 'A'; gradeEmoji = '🔥'; }
  else if (finalScore >= 50) { grade = 'B'; gradeEmoji = '✅'; }
  else if (finalScore >= 35) { grade = 'C'; gradeEmoji = '🟡'; }
  else                        { grade = 'D'; gradeEmoji = '🔴'; }

  return { finalScore, grade, gradeEmoji, passes: finalScore >= SCORE_PASS_MIN, momentum, whale, smart };
}

// ── 5. FORMAT ANALYSIS REPORT ───────────────────────────────
function formatAnalysisReport(analysis) {
  const { finalScore, grade, gradeEmoji, momentum, whale, smart } = analysis;
  let report = '\n━━━━━━━━━━━━━━━━━━━\n';
  report += '🧠 *DEX ANALYSIS ENGINE*\n';
  report += '━━━━━━━━━━━━━━━━━━━\n\n';
  report += gradeEmoji + ' *Strength Score: ' + finalScore + '/100 — Grade ' + grade + '*\n\n';

  report += '📊 *Volume Momentum* (' + momentum.score + ' pts)\n';
  momentum.notes.slice(0, 3).forEach(n => { report += '  ' + n + '\n'; });

  report += '\n🐋 *Whale Analysis* (' + whale.score + ' pts)\n';
  whale.notes.slice(0, 3).forEach(n => { report += '  ' + n + '\n'; });
  if (whale.whales?.length > 0) {
    report += '  Top holders:\n';
    whale.whales.slice(0, 3).forEach(w => { report += '  #' + w.rank + ' ' + w.address + ' — ' + w.pct + '%\n'; });
  }

  report += '\n💰 *Smart Money* (' + smart.score + ' pts)\n';
  smart.notes.slice(0, 3).forEach(n => { report += '  ' + n + '\n'; });

  report += '\n━━━━━━━━━━━━━━━━━━━\n';
  report += analysis.passes
    ? '✅ *PASSES — signal approved for review*\n'
    : '❌ *FAILS — score too low (' + finalScore + '/' + SCORE_PASS_MIN + ' needed)*\n';

  return report;
}

// ── NEW: AI EXPLANATION LAYER ────────────────────────────────
async function getAIExplanation(p, analysis) {
  if (!ANTHROPIC_API_KEY) return null;
  try {
    const prompt = 'Token: ' + p.baseToken.name + ' (' + p.baseToken.symbol + '). DEX strength score: ' +
      analysis.finalScore + '/100, grade ' + analysis.grade + '. MC: $' + Math.round(p.fdv || 0) +
      ', Liquidity: $' + Math.round(p.liquidity?.usd || 0) + ', 24h change: ' + (p.priceChange?.h24 || 0) +
      '%. Write a 1-2 sentence plain-language take in English on whether this token looks promising or risky right now, and why. Be direct and concrete — do not add a "not financial advice" disclaimer.';
    const res = await axios.post('https://api.anthropic.com/v1/messages', {
      model: AI_MODEL,
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      timeout: 15000
    });
    const text = res.data?.content?.find(c => c.type === 'text')?.text;
    return text ? text.trim() : null;
  } catch(e) { console.error('AI explanation error:', e.message); return null; }
}

// ── NEW: WALLET VERIFICATION ENGINE ──────────────────────────
async function verifyWallet(address) {
  try {
    const mints = await getWalletRecentTokenBuys(address, 20);
    if (mints.length < MIN_TOKENS_FOR_VERIFICATION) {
      return { verified: false, reason: 'Not enough trade history (' + mints.length + ' tokens found)' };
    }
    let upCount = 0, checked = 0;
    for (const mint of mints.slice(0, 15)) {
      const p = await getTokenData(mint);
      if (!p) continue;
      checked++;
      const ch24 = parseFloat(p.priceChange?.h24 || 0);
      const ch6h = parseFloat(p.priceChange?.h6 || 0);
      if (ch24 > 20 || ch6h > 15) upCount++;
      await new Promise(r => setTimeout(r, 500));
    }
    if (checked === 0) return { verified: false, reason: 'Could not fetch token data for verification' };
    const winRate = (upCount / checked) * 100;
    const successScore = Math.round(winRate);
    const verified = winRate >= MIN_WIN_RATE_FOR_VERIFICATION;
    return {
      verified, winRate, successScore, totalTrades: checked,
      reason: verified ? 'Passed verification' : ('Win rate too low: ' + winRate.toFixed(0) + '%')
    };
  } catch(e) {
    return { verified: false, reason: 'Verification error: ' + e.message };
  }
}

async function processWalletSubmissions() {
  const pending = getPendingSubmissions(5);
  for (const sub of pending) {
    const result = await verifyWallet(sub.wallet_address);
    if (result.verified) {
      addVerifiedWallet(sub.wallet_address, sub.source, sub.submitted_by, result.winRate, result.successScore, result.totalTrades);
      markSubmission(sub.id, 'verified');
      if (sub.source === 'crowdsourced' && sub.submitted_by && sub.submitted_by !== 'unknown') {
        const expiry = grantPremium(sub.submitted_by, PREMIUM_REWARD_DAYS);
        try {
          await bot.sendMessage(sub.submitted_by,
            '🎉 Your submitted wallet (`' + sub.wallet_address.slice(0, 6) + '...' + sub.wallet_address.slice(-4) + '`) has been verified!\n\n' +
            '🎁 You\'ve been granted ' + PREMIUM_REWARD_DAYS + ' days of free VIP Premium. Thank you!',
            { parse_mode: 'Markdown' });
        } catch(e) {}
      }
      try {
        await bot.sendMessage(ADMIN_ID,
          '✅ *Wallet Verified*\n`' + sub.wallet_address + '`\nWin rate: ' + result.winRate.toFixed(0) + '% (' + result.totalTrades + ' trades)\nSource: ' + sub.source,
          { parse_mode: 'Markdown' });
      } catch(e) {}
    } else {
      markSubmission(sub.id, 'rejected');
      console.log('[Wallet] Rejected: ' + sub.wallet_address.slice(0, 8) + '... — ' + result.reason);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

// ── NEW: SMART WALLET MONITORING ─────────────────────────────
const lastSeenWalletTx = {};

async function monitorSmartWallets() {
  const verified = getVerifiedWallets().map(w => w.address);
  const all = [...new Set([...CURATED_WALLETS, ...verified])];
  if (all.length === 0) return;
  for (const address of all) {
    try {
      const sigs = await getWalletRecentSignatures(address, 5);
      if (!sigs || sigs.length === 0) continue;
      const newest = sigs[0].signature;
      if (lastSeenWalletTx[address] === newest) continue;
      const isFirstRun = !lastSeenWalletTx[address];
      lastSeenWalletTx[address] = newest;
      if (isFirstRun) continue; // establish baseline only, don't alert on first check

      const tx = await getParsedTransaction(newest);
      if (!tx) continue;
      const post = tx.meta?.postTokenBalances || [];
      const pre  = tx.meta?.preTokenBalances || [];
      for (const pb of post) {
        const preMatch = pre.find(p => p.accountIndex === pb.accountIndex);
        const preAmt = preMatch ? Number(preMatch.uiTokenAmount?.uiAmount || 0) : 0;
        const postAmt = Number(pb.uiTokenAmount?.uiAmount || 0);
        if (postAmt > preAmt && pb.owner === address && pb.mint !== 'So11111111111111111111111111111111111111112') {
          await handleSmartWalletBuy(address, pb.mint);
        }
      }
      await new Promise(r => setTimeout(r, 800));
    } catch(e) { console.error('monitorSmartWallets error:', e.message); }
  }
}

async function handleSmartWalletBuy(walletAddress, ca) {
  try {
    const p = await getTokenData(ca);
    if (!p || p.chainId !== 'solana') return;
    const rug = await getRugcheck(ca);
    const analysis = calcTokenStrength(p, rug);
    const alphaScore = Math.max(0, Math.min(100, Math.round((analysis.finalScore * 0.7) + 30)));
    logAlphaSignal(ca, walletAddress, alphaScore);
    const shortWallet = walletAddress.slice(0, 4) + '...' + walletAddress.slice(-4);
    const explanation = await getAIExplanation(p, analysis);
    await bot.sendMessage(ADMIN_ID,
      '🐳 *SMART WALLET ALERT*\n' +
      'Wallet `' + shortWallet + '` just bought:\n\n' +
      '🪙 *' + p.baseToken.name + '* (' + p.baseToken.symbol + ')\n' +
      '💊 MC: ' + fmt(p.fdv) + ' | 💧 Liq: ' + fmt(p.liquidity?.usd) + '\n' +
      analysis.gradeEmoji + ' DEX Score: ' + analysis.finalScore + '/100\n' +
      '⭐ Alpha Score: ' + alphaScore + '/100\n\n' +
      (explanation ? '🤖 *AI Take:* ' + explanation + '\n\n' : '') +
      '📋 `' + ca + '`',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '👁️ Review as Signal', callback_data: 'signal_' + ca }]] } }
    );
  } catch(e) { console.error('handleSmartWalletBuy error:', e.message); }
}

// ── NEW: TELEGRAM ALPHA-GROUP LISTENER (GramJS) ──────────────
let gramClient = null;

async function initGramListener() {
  if (!GRAMJS_AVAILABLE) return;
  if (!TG_API_ID || !TG_API_HASH || !TG_SESSION) {
    console.log('[GramJS] TG_API_ID/TG_API_HASH/TG_SESSION ba a saita su a .env ba — listener OFF. Duba .env.example.');
    return;
  }
  try {
    gramClient = new TelegramClient(new StringSession(TG_SESSION), TG_API_ID, TG_API_HASH, { connectionRetries: 5 });
    await gramClient.connect();
    gramClient.addEventHandler(handleAlphaGroupMessage, new NewMessage({}));
    console.log('[GramJS] Connected. Watching groups: ' + (ALPHA_GROUPS.length ? ALPHA_GROUPS.join(', ') : '(duba console domin gano chat IDs)'));
  } catch(e) {
    console.error('[GramJS] init error:', e.message);
  }
}

async function handleAlphaGroupMessage(event) {
  try {
    const message = event.message;
    if (!message || !message.message) return;
    const chatId = event.chatId ? event.chatId.toString() : '';

    if (ALPHA_GROUPS.length === 0) {
      // Onboarding aid: log chat IDs seen so you can fill ALPHA_GROUPS in .env
      console.log('[GramJS discover] chatId=' + chatId + ' text="' + message.message.slice(0, 40) + '"');
    }
    if (ALPHA_GROUPS.length > 0 && !ALPHA_GROUPS.includes(chatId)) return;

    const matches = message.message.match(SOLANA_ADDRESS_REGEX);
    if (!matches) return;
    for (const addr of matches) {
      addWalletSubmission(addr, 'telegram_listener', chatId || 'unknown_group');
    }
  } catch(e) { console.error('Alpha group message error:', e.message); }
}

// ═══════════════════════════════════════════════════════════
//  SCAN & ANALYSIS
// ═══════════════════════════════════════════════════════════
async function analyzeForSignal(ca) {
  try {
    const p = await getTokenData(ca);
    if (!p || p.chainId !== 'solana') return null;
    if (!p.pairCreatedAt) return null;

    const ageHours = (Date.now() - p.pairCreatedAt) / (1000 * 60 * 60);
    if (ageHours < MIN_AGE_HOURS || ageHours > MAX_AGE_HOURS) return null;

    const liq = p.liquidity?.usd || 0;
    if (liq < MIN_LIQUIDITY) return null;

    const mc = p.fdv || 0;
    if (mc < 20000 || mc > 500000) return null;

    const ch24  = parseFloat(p.priceChange?.h24 || 0);
    const ch5m  = parseFloat(p.priceChange?.m5  || 0);
    const ch15m = parseFloat(p.priceChange?.m15 || 0);
    if (ch24 < 5) return null;
    if (ch5m <= -10 && ch15m <= -10) return null;
    if ((p.volume?.h24 || 0) < 500) return null;

    const rug = await getRugcheck(ca);
    if (rug && rug.score && rug.score > MAX_RUG_SCORE) return null;

    if (rug) {
      const holdersData = rug?.topHolders || rug?.holders || [];
      if (Array.isArray(holdersData) && holdersData.length > 0) {
        const list = holdersData.map(h => Number(h.pct || h.percentage || h.share || 0)).filter(p => p > 0 && p < 50).sort((a, b) => b - a);
        if (list.length > 0) {
          const top10pct = list.slice(0, 10).reduce((a, b) => a + b, 0);
          if (top10pct > 20) return null;
        }
      }
      if (rug.insiderNetworks && rug.insiderNetworks.length > 10) return null;
      if (rug.snipers && rug.snipers.length > 10) return null;
    }

    const analysis = calcTokenStrength(p, rug);
    if (!analysis.passes) {
      console.log('FAIL ' + ca.slice(0, 8) + '... score: ' + analysis.finalScore + '/' + SCORE_PASS_MIN);
      return null;
    }

    console.log('PASS ' + ca.slice(0, 8) + '... score: ' + analysis.finalScore + '/100 Grade ' + analysis.grade);
    return { p, rug, analysis };

  } catch(e) { return null; }
}

async function runScan(triggeredBy) {
  if (isScanning) {
    if (triggeredBy) bot.sendMessage(ADMIN_ID, 'Scan is already running! Please wait...');
    return;
  }
  const todayCount = getTodaySignalCount();
  if (todayCount >= MAX_SIGNALS_PER_DAY) {
    if (triggeredBy) bot.sendMessage(ADMIN_ID, 'Max signals reached today (' + MAX_SIGNALS_PER_DAY + '/' + MAX_SIGNALS_PER_DAY + '). Try tomorrow!');
    return;
  }
  isScanning = true;
  console.log('Scanning... (' + todayCount + '/' + MAX_SIGNALS_PER_DAY + ')');
  try {
    const allCAs = await fetchCandidateTokens();
    let found = 0;
    let analyzedCount = 0;
    for (const ca of allCAs) {
      if (getTodaySignalCount() >= MAX_SIGNALS_PER_DAY) break;
      if (alreadyScanned(ca)) continue;
      markScanned(ca);
      analyzedCount++;
      const result = await analyzeForSignal(ca);
      if (result) {
        found++;
        await sendSignalForReview(ca, result.p, result.rug, true, result.analysis);
        await new Promise(r => setTimeout(r, 5000));
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log('[runScan] candidates=' + allCAs.length + ' analyzed=' + analyzedCount + ' passed=' + found);
    if (triggeredBy) {
      if (found === 0) bot.sendMessage(ADMIN_ID, 'Scan complete — no qualifying tokens found. Next auto-scan in 30 mins.');
      else bot.sendMessage(ADMIN_ID, 'Scan complete — found ' + found + ' token(s)! Check previews above.');
    }
  } catch(e) {
    console.error('Scan error:', e.message);
    if (triggeredBy) bot.sendMessage(ADMIN_ID, 'Scan error: ' + e.message);
  } finally {
    isScanning = false;
  }
}

// ═══════════════════════════════════════════════════════════
//  TRADE MONITORING — Road Map 2 enhanced progress posts
// ═══════════════════════════════════════════════════════════
async function checkOpenTrades() {
  const trades = getOpenTrades();
  if (trades.length === 0) return;
  for (const trade of trades) {
    try {
      const p = await getTokenData(trade.ca);
      if (!p) continue;
      const currentPrice = parseFloat(p.priceUsd) || 0;
      if (currentPrice === 0) continue;
      const pnlPct = ((currentPrice - trade.entry_price) / trade.entry_price) * 100;
      const pnlSol = (pnlPct / 100) * trade.sol_amount;
      const toT1 = ((trade.target1 - currentPrice) / trade.target1 * 100).toFixed(1);
      const toT2 = ((trade.target2 - currentPrice) / trade.target2 * 100).toFixed(1);

      if (currentPrice <= trade.stop_loss) {
        closePaperTrade(trade.id, 'SL', pnlPct, pnlSol);
        await bot.sendMessage(CHANNEL_ID,
          '🔴 *STOP LOSS HIT*\n' +
          '━━━━━━━━━━━━━━━━━━━\n' +
          '🪙 *' + trade.name + '* (' + trade.symbol + ')\n\n' +
          '📥 Entry: ' + fmtPrice(trade.entry_price) + '\n' +
          '📤 Exit: ' + fmtPrice(currentPrice) + '\n' +
          '📉 PNL: ' + pnlPct.toFixed(1) + '% (' + pnlSol.toFixed(3) + ' SOL)\n\n' +
          '_Signal by @YakubuWeb3_',
          { parse_mode: 'Markdown' }
        );
        continue;
      }

      if (currentPrice >= trade.target2) {
        closePaperTrade(trade.id, 'T2', pnlPct, pnlSol);
        await bot.sendMessage(CHANNEL_ID,
          '🏆 *TARGET 2 HIT! +100%* 🏆\n' +
          '━━━━━━━━━━━━━━━━━━━\n' +
          '🪙 *' + trade.name + '* (' + trade.symbol + ')\n\n' +
          '📥 Entry: ' + fmtPrice(trade.entry_price) + '\n' +
          '📤 Exit: ' + fmtPrice(currentPrice) + '\n' +
          '✅ PNL: +' + pnlPct.toFixed(1) + '% (+' + pnlSol.toFixed(3) + ' SOL)\n' +
          '📊 Multiplier: ' + (currentPrice / trade.entry_price).toFixed(2) + 'x\n\n' +
          '_Signal by @YakubuWeb3_',
          { parse_mode: 'Markdown' }
        );
        continue;
      }

      if (currentPrice >= trade.target1 && trade.result !== 'T1_partial') {
        db.prepare('UPDATE paper_trades SET result = ? WHERE id = ?').run('T1_partial', trade.id);
        await bot.sendMessage(CHANNEL_ID,
          '🎯 *TARGET 1 HIT! +50%*\n' +
          '━━━━━━━━━━━━━━━━━━━\n' +
          '🪙 *' + trade.name + '* (' + trade.symbol + ')\n\n' +
          '📥 Entry: ' + fmtPrice(trade.entry_price) + '\n' +
          '📍 Now: ' + fmtPrice(currentPrice) + '\n' +
          '✅ PNL: +' + pnlPct.toFixed(1) + '% (+' + pnlSol.toFixed(3) + ' SOL)\n\n' +
          '👀 Watching for T2 (+100%)...\n' +
          '🛑 Stop Loss: ' + fmtPrice(trade.stop_loss) + '\n\n' +
          '_Signal by @YakubuWeb3_',
          { parse_mode: 'Markdown' }
        );
        continue;
      }

      if (pnlPct <= -15 && trade.result !== 'sl_warning' && trade.result !== 'T1_partial') {
        db.prepare('UPDATE paper_trades SET result = ? WHERE id = ?').run('sl_warning', trade.id);
        await bot.sendMessage(CHANNEL_ID,
          '⚠️ *STOP LOSS WARNING*\n' +
          '━━━━━━━━━━━━━━━━━━━\n' +
          '🪙 *' + trade.name + '* (' + trade.symbol + ')\n\n' +
          '📥 Entry: ' + fmtPrice(trade.entry_price) + '\n' +
          '📍 Now: ' + fmtPrice(currentPrice) + '\n' +
          '📉 PNL: ' + pnlPct.toFixed(1) + '% (' + pnlSol.toFixed(3) + ' SOL)\n\n' +
          '🛑 Stop Loss approaching: ' + fmtPrice(trade.stop_loss) + '\n' +
          '⚡ Consider cutting losses!\n\n' +
          '_Signal by @YakubuWeb3_',
          { parse_mode: 'Markdown' }
        );
        continue;
      }

      if (pnlPct >= 30 && trade.result !== 'T1_partial' && trade.result !== 'progress_30') {
        db.prepare('UPDATE paper_trades SET result = ? WHERE id = ?').run('progress_30', trade.id);
        await bot.sendMessage(CHANNEL_ID,
          '📈 *UPDATE — ' + trade.name + ' (' + trade.symbol + ')*\n' +
          '━━━━━━━━━━━━━━━━━━━\n\n' +
          '✅ Up +' + pnlPct.toFixed(1) + '% (+' + pnlSol.toFixed(3) + ' SOL)\n\n' +
          '🎯 *T1 (+50%):* ' + toT1 + '% remaining\n' +
          '🏆 *T2 (+100%):* ' + toT2 + '% remaining\n' +
          '🛑 *Stop Loss:* ' + fmtPrice(trade.stop_loss) + '\n\n' +
          '_Signal by @YakubuWeb3_',
          { parse_mode: 'Markdown' }
        );
        continue;
      }

      if (pnlPct >= 20 && trade.result !== 'T1_partial' && trade.result !== 'progress_30' && trade.result !== 'progress_20') {
        db.prepare('UPDATE paper_trades SET result = ? WHERE id = ?').run('progress_20', trade.id);
        await bot.sendMessage(CHANNEL_ID,
          '📈 *UPDATE — ' + trade.name + ' (' + trade.symbol + ')*\n' +
          '━━━━━━━━━━━━━━━━━━━\n\n' +
          '✅ Up +' + pnlPct.toFixed(1) + '% (+' + pnlSol.toFixed(3) + ' SOL)\n\n' +
          '🎯 *T1 (+50%):* ' + toT1 + '% remaining\n' +
          '🏆 *T2 (+100%):* ' + toT2 + '% remaining\n' +
          '🛑 *Stop Loss:* ' + fmtPrice(trade.stop_loss) + '\n\n' +
          '_Signal by @YakubuWeb3_',
          { parse_mode: 'Markdown' }
        );
        continue;
      }

      await new Promise(r => setTimeout(r, 1000));
    } catch(e) { console.error('Trade check error:', e.message); }
  }
}

// ═══════════════════════════════════════════════════════════
//  WEEKLY REPORT
// ═══════════════════════════════════════════════════════════
async function sendWeeklyReport() {
  const stats = getWeeklyStats();
  if (!stats) return;
  const msg =
    '*WEEKLY SIGNAL REPORT*\n' +
    '-------------------\n\n' +
    'Last 7 days:\n' +
    'Total Signals: ' + stats.total + '\n' +
    'Wins: ' + stats.wins + '/' + stats.total + '\n' +
    'Win Rate: ' + stats.winRate + '%\n' +
    'Total PNL: ' + (parseFloat(stats.totalPnlSol) > 0 ? '+' : '') + stats.totalPnlSol + ' SOL\n' +
    (stats.bestTrade ? 'Best Trade: ' + stats.bestTrade.symbol + ' +' + (stats.bestTrade.pnl_pct || 0).toFixed(1) + '%\n' : '') +
    '\n_Signal by @YakubuWeb3_';
  await bot.sendMessage(CHANNEL_ID, msg, { parse_mode: 'Markdown' });
}

function scheduleWeeklyReport() {
  setInterval(() => {
    const now = new Date();
    if (now.getDay() === 0 && now.getHours() === 8 && now.getMinutes() < 30) sendWeeklyReport();
  }, 30 * 60 * 1000);
}

// ═══════════════════════════════════════════════════════════
//  MESSAGE FORMATTERS
// ═══════════════════════════════════════════════════════════
async function formatMsg(p, ca, chatId) {
  const name   = p.baseToken.name;
  const symbol = p.baseToken.symbol;
  const price  = parseFloat(p.priceUsd) || 0;
  const mc     = p.fdv || 0;
  saveSnapshot(chatId, ca, price, mc, name, symbol);
  const vol24 = fmt(p.volume?.h24);
  const vol6  = fmt(p.volume?.h6);
  const vol1  = fmt(p.volume?.h1);
  const ch24  = fmtChangeEmoji(p.priceChange?.h24);
  const ch6   = fmtChangeEmoji(p.priceChange?.h6);
  const ch1   = fmtChangeEmoji(p.priceChange?.h1);
  const created  = p.pairCreatedAt ? Math.floor((Date.now() - p.pairCreatedAt) / 86400000) + 'd ago' : 'N/A';
  const chain    = (p.chainId || '').toUpperCase();
  const dex      = p.dexId || 'N/A';
  const buys     = p.txns?.h24?.buys  || 0;
  const sells    = p.txns?.h24?.sells || 0;
  const dexPaid  = checkDexPaid(p) ? 'Paid' : 'Not Paid';
  let socials = '';
  if (p.info?.websites?.length > 0) socials += '[Web](' + p.info.websites[0].url + ') ';
  if (p.info?.socials?.length > 0) p.info.socials.forEach(s => {
    if (s.type === 'twitter') socials += '[X](' + s.url + ') ';
    if (s.type === 'telegram') socials += '[TG](' + s.url + ') ';
  });
  if (!socials) socials = 'No socials';
  const rug = await getRugcheck(ca);
  let riskScore = 'N/A', riskLevel = 'N/A', bundleInfo = 'No bundles', sniperInfo = 'No snipers';
  let athMc = 'N/A', risks = 'Clean', devInfo = 'N/A', holdersCount = 'N/A', top10 = 'N/A', top20 = 'N/A';
  if (rug) {
    riskScore = rug.score || 0;
    riskLevel = getRugEmoji(riskScore);
    if (rug.markets?.length > 0) { const maxMc = Math.max(...rug.markets.map(m => m.marketCap || 0)); if (maxMc > 0) athMc = fmt(maxMc); }
    holdersCount = await getHolderCount(ca, rug);
    const holdersData = rug?.topHolders || rug?.holders || rug?.data?.holders || [];
    if (Array.isArray(holdersData) && holdersData.length > 0) {
      const list = holdersData.map(h => ({ address: h.address || '', pct: Number(h.pct || h.percentage || h.share || 0) })).filter(h => h.address && h.pct > 0 && h.pct < 50).sort((a, b) => b.pct - a.pct);
      if (list.length > 0) {
        top10 = Math.min(list.slice(0, 10).reduce((a, b) => a + b.pct, 0), 100).toFixed(1) + '%';
        top20 = Math.min(list.slice(0, 20).reduce((a, b) => a + b.pct, 0), 100).toFixed(1) + '%';
      }
    }
    if (rug.creator) { const devBal = rug.creatorBalance ? (rug.creatorBalance / 1e9).toFixed(1) + ' SOL' : '0 SOL'; const devH = (rug?.topHolders || []).find(h => h.address === rug.creator); devInfo = devBal + ' ' + (devH ? devH.pct?.toFixed(1) + '%' : '0%'); }
    if (rug.insiderNetworks?.length > 0) { const count = rug.insiderNetworks.length; const bPct = rug.insiderNetworks.reduce((a, b) => a + (b.holdingPercent || 0), 0); const nPct = rug.insiderNetworks.reduce((a, b) => a + (b.currentHoldingPercent || 0), 0); bundleInfo = count + ' bundles ' + bPct.toFixed(1) + '% bought ' + nPct.toFixed(1) + '% now' + (bPct > 20 ? ' WARNING' : ''); }
    if (rug.snipers?.length > 0) { const count = rug.snipers.length; const bPct = rug.snipers.reduce((a, b) => a + (b.holdingPercent || 0), 0); const nPct = rug.snipers.reduce((a, b) => a + (b.currentHoldingPercent || 0), 0); sniperInfo = count + ' snipers ' + bPct.toFixed(1) + '% bought ' + nPct.toFixed(1) + '% now'; }
    if (rug.risks?.length > 0) { risks = ''; rug.risks.slice(0, 3).forEach(r => { const icon = r.level === 'danger' ? '🔴' : r.level === 'warn' ? '⚠️' : '📝'; risks += icon + ' ' + r.name + '\n'; }); }
  }

  return '🔍 *' + name + '* (' + symbol + ')\n🔗 ' + chain + ' | 🏦 ' + dex + ' | ⏰ ' + created + '\n\n💰 *Price:* ' + fmtPrice(price) + '\n💊 *MC:* ' + fmt(mc) + ' | 💧 *Liq:* ' + fmt(p.liquidity?.usd) + '\n🏆 *ATH MC:* ' + athMc + '\n\n📈 *Volume:*\n├ 24h: ' + vol24 + '\n├ 6h: ' + vol6 + '\n└ 1h: ' + vol1 + '\n\n📉 *Change:*\n├ 24h: ' + ch24 + '\n├ 6h: ' + ch6 + '\n└ 1h: ' + ch1 + '\n\n🛒 *Buys:* ' + buys + ' | 🔴 *Sells:* ' + sells + '\n⚡ *Dex:* ' + dexPaid + '\n🔗 *Socials:* ' + socials + '\n\n👥 *Holders:* ' + holdersCount + '\n├ Top 10: ' + top10 + '\n└ Top 20: ' + top20 + '\n🔧 *Dev:* ' + devInfo + '\n\n📦 *Bundles:* ' + bundleInfo + '\n🎯 *Snipers:* ' + sniperInfo + '\n\n🛡️ *Risk Score:* ' + riskScore + ' — ' + riskLevel + '\n⚠️ *Flags:*\n' + risks + '\n📋 `' + ca + '`\n_💰 /pnl ' + ca + '_';
}

function formatSignalPost(p, ca, rug, entryPrice, target1, target2, stopLoss) {
  const name     = p.baseToken.name;
  const symbol   = p.baseToken.symbol;
  const mc       = p.fdv || 0;
  const liq      = p.liquidity?.usd || 0;
  const ageHours = p.pairCreatedAt ? ((Date.now() - p.pairCreatedAt) / (1000 * 60 * 60)).toFixed(1) : 'N/A';
  const ch5m     = fmtChangeEmoji(p.priceChange?.m5);
  const ch1      = fmtChangeEmoji(p.priceChange?.h1);
  const ch24     = fmtChangeEmoji(p.priceChange?.h24);
  const buys     = p.txns?.h24?.buys  || 0;
  const sells    = p.txns?.h24?.sells || 0;
  const chain    = (p.chainId || '').toUpperCase();
  let riskScore = 'N/A', rugBadge = '⚪ UNKNOWN';
  if (rug) { riskScore = rug.score || 0; rugBadge = getRugEmoji(riskScore); }
  let socials = '';
  if (p.info?.websites?.length > 0) socials += '[Web](' + p.info.websites[0].url + ') ';
  if (p.info?.socials?.length > 0) p.info.socials.forEach(s => { if (s.type === 'twitter') socials += '[X](' + s.url + ') '; if (s.type === 'telegram') socials += '[TG](' + s.url + ') '; });
  if (!socials) socials = 'No socials';
  return '📡 *SIGNAL ALERT* — @YakubuWeb3\n━━━━━━━━━━━━━━━━━━━\n🪙 *' + name + '* (' + symbol + ') | ' + chain + '\n⏰ Age: ' + ageHours + 'h | 🏦 Pumpswap\n\n💰 *Entry:* ' + fmtPrice(entryPrice) + '\n💊 *MC:* ' + fmt(mc) + ' | 💧 *Liq:* ' + fmt(liq) + '\n\n🎯 *Targets:*\n├ T1: ' + fmtPrice(target1) + ' *(+50%)*\n└ T2: ' + fmtPrice(target2) + ' *(+100%)*\n🛑 *Stop Loss:* ' + fmtPrice(stopLoss) + ' *(-20%)*\n\n📊 *Price Action:*\n├ 5m: ' + ch5m + '\n├ 1h: ' + ch1 + '\n└ 24h: ' + ch24 + '\n\n📈 *Vol 24h:* ' + fmt(p.volume?.h24) + '\n🛒 *Buys:* ' + buys + ' | 🔴 *Sells:* ' + sells + '\n\n🛡️ *Rug Score:* ' + riskScore + ' — ' + rugBadge + '\n🔗 *Socials:* ' + socials + '\n\n📋 CA: `' + ca + '`\n[Chart](https://dexscreener.com/solana/' + ca + ') | [Analyze](https://t.me/YakubuWeb3Bot?start=' + ca + ')\n━━━━━━━━━━━━━━━━━━━\n_DYOR — Not financial advice_\n_Signal by @YakubuWeb3_';
}

// ═══════════════════════════════════════════════════════════
//  SIGNAL REVIEW & POSTING
// ═══════════════════════════════════════════════════════════
async function sendSignalForReview(ca, existingP, existingRug, isAutoScan, existingAnalysis) {
  try {
    const p = existingP || await getTokenData(ca);
    if (!p) { if (!isAutoScan) bot.sendMessage(ADMIN_ID, 'Token not found!'); return; }
    const rug = existingRug || await getRugcheck(ca);
    const analysis = existingAnalysis || calcTokenStrength(p, rug);
    const entryPrice = parseFloat(p.priceUsd) || 0;
    const target1    = entryPrice * 1.5;
    const target2    = entryPrice * 2;
    const stopLoss   = entryPrice * 0.8;
    const signalText     = formatSignalPost(p, ca, rug, entryPrice, target1, target2, stopLoss);
    const analysisReport = formatAnalysisReport(analysis);
    const aiExplanation  = await getAIExplanation(p, analysis); // NEW
    const ageHours = p.pairCreatedAt ? ((Date.now() - p.pairCreatedAt) / (1000 * 60 * 60)).toFixed(1) : 'N/A';
    pendingSignals[ca] = { p, rug, analysis, signalText, entryPrice, target1, target2, stopLoss };
    const badge        = isAutoScan ? '🤖 AUTO SCAN' : '👤 MANUAL';
    const scoreDisplay = '\n' + analysis.gradeEmoji + ' Score: ' + analysis.finalScore + '/100 — Grade ' + analysis.grade;
    const aiBlock = aiExplanation ? ('\n🤖 *AI Take:* ' + aiExplanation + '\n') : '';
    await bot.sendMessage(ADMIN_ID,
      (isAutoScan ? '🔔' : '👁️') + ' *SIGNAL PREVIEW* — ' + badge + '\n' +
      '📊 Today: ' + getTodaySignalCount() + '/' + MAX_SIGNALS_PER_DAY + '\n' +
      '⏰ Age: ' + ageHours + 'h' + scoreDisplay + aiBlock + '\n\n' +
      signalText + '\n' + analysisReport,
      { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: '✅ APPROVE — Post to Channel', callback_data: 'approve_' + ca }, { text: '❌ REJECT', callback_data: 'reject_' + ca }]] } }
    );
  } catch(e) {
    console.error('Signal review error:', e.message);
    if (!isAutoScan) bot.sendMessage(ADMIN_ID, 'Error preparing signal!');
  }
}

async function postSignalToChannel(ca, msgId) {
  const pending = pendingSignals[ca];
  if (!pending) return bot.sendMessage(ADMIN_ID, 'Signal expired! Re-analyze the token.');
  if (getTodaySignalCount() >= MAX_SIGNALS_PER_DAY) return bot.sendMessage(ADMIN_ID, 'Max signals reached today!');
  try {
    await bot.sendMessage(CHANNEL_ID, pending.signalText, {
      parse_mode: 'Markdown', disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: 'Chart', url: 'https://dexscreener.com/solana/' + ca }, { text: 'Analyze', url: 'https://t.me/YakubuWeb3Bot?start=' + ca }]] }
    });
    recordSignalSent(ca);
    saveSnapshot(CHANNEL_ID, ca, pending.entryPrice, pending.p.fdv || 0, pending.p.baseToken.name, pending.p.baseToken.symbol);
    openPaperTrade(ca, pending.p.baseToken.name, pending.p.baseToken.symbol, pending.entryPrice, pending.p.fdv || 0, pending.target1, pending.target2, pending.stopLoss);
    delete pendingSignals[ca];
    const newCount = getTodaySignalCount();
    await bot.editMessageText('Signal posted to channel!\nToday: ' + newCount + '/' + MAX_SIGNALS_PER_DAY + '\n\n' + pending.signalText, { chat_id: ADMIN_ID, message_id: msgId, parse_mode: 'Markdown', disable_web_page_preview: true });
    bot.sendMessage(ADMIN_ID, 'Signal posted! (' + newCount + '/' + MAX_SIGNALS_PER_DAY + ' today)');
  } catch(e) { bot.sendMessage(ADMIN_ID, 'Failed to post! Check bot is admin in channel.'); console.error(e); }
}

// ═══════════════════════════════════════════════════════════
//  ANALYSIS & PNL
// ═══════════════════════════════════════════════════════════
async function sendAnalysis(chatId, ca, username) {
  const loadMsg = await bot.sendMessage(chatId, 'Analyzing token...');
  try {
    const p = await getTokenData(ca);
    if (!p) { await bot.deleteMessage(chatId, loadMsg.message_id); return bot.sendMessage(chatId, 'Token not found!'); }
    const text = await formatMsg(p, ca, chatId);
    await bot.deleteMessage(chatId, loadMsg.message_id);
    const isAdmin = String(chatId) === String(ADMIN_ID);
    const keyboard = isAdmin
      ? [[{ text: 'Refresh', callback_data: 'refresh_' + ca }, { text: 'Delete', callback_data: 'delete' }, { text: 'Chart', url: 'https://dexscreener.com/solana/' + ca }],[{ text: 'PNL Card', callback_data: 'pnl_' + ca }, { text: 'Send as Signal', callback_data: 'signal_' + ca }],[{ text: '🔬 Deep Bundle Scan', callback_data: 'deepscan_' + ca }]]
      : [[{ text: 'Refresh', callback_data: 'refresh_' + ca }, { text: 'Delete', callback_data: 'delete' }, { text: 'Chart', url: 'https://dexscreener.com/solana/' + ca }],[{ text: 'PNL Card', callback_data: 'pnl_' + ca }],[{ text: '🔬 Deep Bundle Scan', callback_data: 'deepscan_' + ca }]];
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard } });
  } catch(e) {
    try { await bot.deleteMessage(chatId, loadMsg.message_id); } catch(err) {}
    bot.sendMessage(chatId, 'Error! Try again.');
    console.error(e);
  }
}

async function generatePnlImage(data) {
  const { name, symbol, entryMc, currentMc, entryPrice, currentPrice, pnlPct, multiplier, isProfit, username, entryTime } = data;
  const W = 800, H = 450;
  const img = new Jimp(W, H, isProfit ? 0x0a2a1aff : 0x2a0a0aff);
  const borderColor = isProfit ? 0x00ff88ff : 0xff4444ff;
  for (let x = 0; x < W; x++) { for (let t = 0; t < 4; t++) { img.setPixelColor(borderColor, x, t); img.setPixelColor(borderColor, x, H - 1 - t); } }
  for (let y = 0; y < H; y++) { for (let t = 0; t < 4; t++) { img.setPixelColor(borderColor, t, y); img.setPixelColor(borderColor, W - 1 - t, y); } }
  const font64 = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
  const font32 = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
  const font16 = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
  img.print(font32, 40, 35,  name + ' (' + symbol + ')');
  img.print(font64, 40, 90,  (isProfit ? '+' : '') + pnlPct.toFixed(1) + '%');
  img.print(font32, 40, 175, multiplier.toFixed(2) + 'x');
  img.print(font16, 40, 240, 'Entry MC:      ' + fmt(entryMc));
  img.print(font16, 40, 265, 'Current MC:    ' + fmt(currentMc));
  img.print(font16, 40, 295, 'Entry Price:   ' + fmtPrice(entryPrice));
  img.print(font16, 40, 320, 'Current Price: ' + fmtPrice(currentPrice));
  const timeAgo = Math.floor((Date.now() - entryTime) / 60000);
  img.print(font16, 40, 360, 'Called: ' + (timeAgo < 60 ? timeAgo + 'm ago' : Math.floor(timeAgo / 60) + 'h ' + (timeAgo % 60) + 'm ago'));
  img.print(font16, 40, 390, '@' + (username || 'Anonymous'));
  img.print(font16, W - 220, H - 25, '@YakubuWeb3Bot');
  const filePath = '/tmp/pnl_' + Date.now() + '.png';
  await img.writeAsync(filePath);
  return filePath;
}

async function sendPnl(chatId, ca, username) {
  const snap = getSnapshot(chatId, ca);
  if (!snap) return bot.sendMessage(chatId, 'No entry found! Send the CA first.');
  const loadMsg = await bot.sendMessage(chatId, 'Generating PNL card...');
  try {
    const p = await getTokenData(ca);
    if (!p) { await bot.deleteMessage(chatId, loadMsg.message_id); return bot.sendMessage(chatId, 'Token not found!'); }
    const currentPrice = parseFloat(p.priceUsd) || 0;
    const currentMc    = p.fdv || 0;
    const pnlPct       = ((currentPrice - snap.price) / snap.price) * 100;
    const multiplier   = currentPrice / snap.price;
    const isProfit     = pnlPct >= 0;
    const imgPath = await generatePnlImage({ name: snap.name, symbol: snap.symbol, entryMc: snap.mc, currentMc, entryPrice: snap.price, currentPrice, pnlPct, multiplier, isProfit, username: username || 'Anonymous', entryTime: snap.timestamp });
    await bot.deleteMessage(chatId, loadMsg.message_id);
    await bot.sendPhoto(chatId, imgPath, { caption: 'PNL — ' + snap.name + ' (' + snap.symbol + ')\n\nEntry MC: ' + fmt(snap.mc) + '\nCurrent MC: ' + fmt(currentMc) + '\n' + (isProfit ? '🟢' : '🔴') + ' PNL: ' + (isProfit ? '+' : '') + pnlPct.toFixed(1) + '%\nMultiplier: ' + multiplier.toFixed(2) + 'x\n\nPowered by @YakubuWeb3Bot', parse_mode: 'Markdown' });
    fs.unlinkSync(imgPath);
  } catch(e) {
    try { await bot.deleteMessage(chatId, loadMsg.message_id); } catch(err) {}
    bot.sendMessage(chatId, 'Error generating PNL!');
    console.error(e);
  }
}

// ═══════════════════════════════════════════════════════════
//  BOT COMMANDS
// ═══════════════════════════════════════════════════════════
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, '🚀 *YakubuWeb3 Signal Bot*\n\nSend any *Solana CA* to analyze!\n\n📡 Auto-scans every 30 mins\n🎯 3-5 quality signals per day\n🐋 /submitwallet <address> — submit a Smart Wallet, earn free VIP\n\n/pnl <CA> — PNL Card\n/price <symbol> — Price\n/status — Bot status\n/help — Commands\n\n_Powered by @YakubuWeb3_', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Analyze Token', callback_data: 'prompt_analyze' }, { text: 'Price Check', callback_data: 'prompt_price' }]] } });
});

bot.onText(/\/help/, (msg) => {
  const isAdmin = String(msg.chat.id) === String(ADMIN_ID);
  const adminCmds = isAdmin ? '\n\n👑 *Admin:*\n/signal <CA>\n/scan\n/pending\n/stats\n/wallets' : '';
  bot.sendMessage(msg.chat.id, '📋 *Commands:*\n\nSend CA — Analyze\n/pnl <CA> — PNL Card\n/price <symbol> — Price\n/status\n/submitwallet <address> — Submit Smart Wallet\n/mystatus — Check VIP status' + adminCmds, { parse_mode: 'Markdown' });
});

bot.onText(/\/status/, (msg) => {
  const count = getTodaySignalCount();
  bot.sendMessage(msg.chat.id, '📊 *Bot Status*\n\nSignals today: ' + count + '/' + MAX_SIGNALS_PER_DAY + '\nScan: Every 30 mins\nRunning!', { parse_mode: 'Markdown' });
});

bot.onText(/\/stats/, (msg) => {
  if (String(msg.chat.id) !== String(ADMIN_ID)) return;
  const count   = getTodaySignalCount();
  const pending = Object.keys(pendingSignals).length;
  bot.sendMessage(ADMIN_ID, '📊 *Stats*\n\nToday: ' + count + '/' + MAX_SIGNALS_PER_DAY + '\nPending: ' + pending, { parse_mode: 'Markdown' });
});

bot.onText(/\/scan/, async (msg) => {
  if (String(msg.chat.id) !== String(ADMIN_ID)) return;
  bot.sendMessage(ADMIN_ID, 'Starting manual scan...');
  await runScan(true);
});

bot.onText(/\/signal (.+)/, async (msg, match) => {
  if (String(msg.chat.id) !== String(ADMIN_ID)) return bot.sendMessage(msg.chat.id, 'Admin only!');
  await sendSignalForReview(match[1].trim(), null, null, false, null);
});

bot.onText(/\/pending/, (msg) => {
  if (String(msg.chat.id) !== String(ADMIN_ID)) return;
  const keys = Object.keys(pendingSignals);
  if (keys.length === 0) return bot.sendMessage(ADMIN_ID, 'No pending signals.');
  bot.sendMessage(ADMIN_ID, '📋 *Pending (' + keys.length + '):*\n\n' + keys.map((k, i) => (i + 1) + '. `' + k + '`').join('\n'), { parse_mode: 'Markdown' });
});

bot.onText(/\/analyze (.+)/, async (msg, match) => { await sendAnalysis(msg.chat.id, match[1].trim(), msg.from?.username); });
bot.onText(/\/pnl (.+)/,     async (msg, match) => { await sendPnl(msg.chat.id, match[1].trim(), msg.from?.username); });

bot.onText(/\/price (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const symbol = match[1].trim().toLowerCase();
  const loadMsg = await bot.sendMessage(chatId, 'Fetching price...');
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=' + symbol + '&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true');
    const data = res.data[symbol];
    if (!data) { await bot.deleteMessage(chatId, loadMsg.message_id); return bot.sendMessage(chatId, 'Coin not found!'); }
    await bot.deleteMessage(chatId, loadMsg.message_id);
    bot.sendMessage(chatId, '💰 *' + symbol.toUpperCase() + '*\n\nPrice: ' + fmtPrice(data.usd) + '\nMC: ' + fmt(data.usd_market_cap) + '\nVol (24h): ' + fmt(data.usd_24h_vol) + '\n' + fmtChangeEmoji(data.usd_24h_change) + ' (24h)\n\n_Powered by @YakubuWeb3_', { parse_mode: 'Markdown' });
  } catch(e) { await bot.deleteMessage(chatId, loadMsg.message_id); bot.sendMessage(chatId, 'Error!'); }
});

// ── NEW: Crowdsourced Wallet Submission Commands ─────────────
bot.onText(/\/submitwallet (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const address = match[1].trim();
  if (!(address.length >= 32 && address.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(address))) {
    return bot.sendMessage(chatId, '⚠️ Invalid wallet address! Please check the Solana wallet address and try again.');
  }
  addWalletSubmission(address, 'crowdsourced', String(chatId));
  bot.sendMessage(chatId, '✅ Wallet received!\n\nWe\'ll check its trading history (verification) within a few minutes. If it passes, you\'ll get ' + PREMIUM_REWARD_DAYS + ' days of free VIP Premium. Thanks for contributing!');
});

bot.onText(/\/mystatus/, (msg) => {
  const chatId = msg.chat.id;
  const premium = isPremium(chatId);
  if (premium) {
    const row = db.prepare('SELECT * FROM premium_users WHERE telegram_id = ?').get(String(chatId));
    const daysLeft = Math.ceil((row.expires_at - Date.now()) / (24 * 60 * 60 * 1000));
    bot.sendMessage(chatId, '⭐ You have VIP Premium! ' + daysLeft + ' day(s) remaining.');
  } else {
    bot.sendMessage(chatId, 'You don\'t have VIP Premium right now.\n\nUse /submitwallet <address> for a chance to earn ' + PREMIUM_REWARD_DAYS + ' free days if your wallet gets verified.');
  }
});

bot.onText(/\/wallets/, (msg) => {
  if (String(msg.chat.id) !== String(ADMIN_ID)) return;
  const verified = getVerifiedWallets();
  if (verified.length === 0) return bot.sendMessage(ADMIN_ID, 'No verified wallets yet.');
  const list = verified.slice(0, 20).map((w, i) => (i + 1) + '. `' + w.address.slice(0, 6) + '...' + w.address.slice(-4) + '` — ' + w.win_rate.toFixed(0) + '% win rate (' + w.source + ')').join('\n');
  bot.sendMessage(ADMIN_ID, '🐋 *Verified Smart Wallets (' + verified.length + '):*\n\n' + list, { parse_mode: 'Markdown' });
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  if (text.startsWith('/')) return;
  const ca = text.trim();
  if (ca.length >= 32 && ca.length <= 44 && /^[A-Za-z0-9]+$/.test(ca)) await sendAnalysis(chatId, ca, msg.from?.username);
});

// ═══════════════════════════════════════════════════════════
//  CALLBACK QUERIES
// ═══════════════════════════════════════════════════════════
bot.on('callback_query', async (query) => {
  const chatId   = query.message.chat.id;
  const msgId    = query.message.message_id;
  const data     = query.data;
  const username = query.from?.username;

  if (data.startsWith('signal_')) {
    if (String(chatId) !== String(ADMIN_ID)) return bot.answerCallbackQuery(query.id, { text: 'Admin only!' });
    await bot.answerCallbackQuery(query.id, { text: 'Preparing signal...' });
    await sendSignalForReview(data.replace('signal_', ''), null, null, false, null);
    return;
  }
  if (data.startsWith('approve_')) {
    if (String(chatId) !== String(ADMIN_ID)) return bot.answerCallbackQuery(query.id, { text: 'Admin only!' });
    await bot.answerCallbackQuery(query.id, { text: 'Posting to channel...' });
    await postSignalToChannel(data.replace('approve_', ''), msgId);
    return;
  }
  if (data.startsWith('reject_')) {
    if (String(chatId) !== String(ADMIN_ID)) return bot.answerCallbackQuery(query.id, { text: 'Rejected!' });
    const ca = data.replace('reject_', '');
    delete pendingSignals[ca];
    await bot.answerCallbackQuery(query.id, { text: 'Signal rejected!' });
    await bot.editMessageText('Signal rejected.\nCA: `' + ca + '`', { chat_id: ADMIN_ID, message_id: msgId, parse_mode: 'Markdown' });
    return;
  }
  if (data.startsWith('refresh_')) {
    const ca = data.replace('refresh_', '');
    await bot.answerCallbackQuery(query.id, { text: 'Refreshing...' });
    try {
      const p = await getTokenData(ca);
      if (!p) return;
      const text = await formatMsg(p, ca, chatId);
      const isAdmin = String(chatId) === String(ADMIN_ID);
      const keyboard = isAdmin
        ? [[{ text: 'Refresh', callback_data: 'refresh_' + ca }, { text: 'Delete', callback_data: 'delete' }, { text: 'Chart', url: 'https://dexscreener.com/solana/' + ca }],[{ text: 'PNL Card', callback_data: 'pnl_' + ca }, { text: 'Send as Signal', callback_data: 'signal_' + ca }],[{ text: '🔬 Deep Bundle Scan', callback_data: 'deepscan_' + ca }]]
        : [[{ text: 'Refresh', callback_data: 'refresh_' + ca }, { text: 'Delete', callback_data: 'delete' }, { text: 'Chart', url: 'https://dexscreener.com/solana/' + ca }],[{ text: 'PNL Card', callback_data: 'pnl_' + ca }],[{ text: '🔬 Deep Bundle Scan', callback_data: 'deepscan_' + ca }]];
      await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard } });
    } catch(e) { bot.answerCallbackQuery(query.id, { text: 'Error!' }); }
    return;
  }
  if (data.startsWith('deepscan_')) {
    const ca = data.replace('deepscan_', '');
    await bot.answerCallbackQuery(query.id, { text: 'Running deep scan (1-2 min)...' });
    const waitMsg = await bot.sendMessage(chatId, '🔬 Running deep on-chain bundle/sniper scan... this can take 1-2 minutes.');
    try {
      const p = await getTokenData(ca);
      if (!p || !p.pairAddress || !p.baseToken?.address || !p.pairCreatedAt) {
        await bot.editMessageText('Could not run deep scan — missing pair data for this token.', { chat_id: chatId, message_id: waitMsg.message_id });
        return;
      }
      const onchain = await detectBundlesAndSnipers(p.pairAddress, p.baseToken.address, p.pairCreatedAt);
      if (!onchain.available) {
        await bot.editMessageText('Deep scan failed: ' + (onchain.reason || 'unknown error'), { chat_id: chatId, message_id: waitMsg.message_id });
        return;
      }
      const bundleLine = onchain.bundleCount > 0
        ? onchain.bundleCount + ' wallets bundled (' + onchain.bundleTxCount + ' shared slots) — hold ' + onchain.bundleCurrentPct.toFixed(1) + '% now' + (onchain.bundleCurrentPct > 15 ? ' ⚠️' : '')
        : 'No bundles found';
      const sniperLine = onchain.sniperCount > 0
        ? onchain.sniperCount + ' snipers — hold ' + onchain.sniperCurrentPct.toFixed(1) + '% now'
        : 'No snipers found';
      await bot.editMessageText(
        '🔬 *Deep Bundle/Sniper Scan*\n' + p.baseToken.name + ' (' + p.baseToken.symbol + ')\n\n' +
        '📦 Bundles: ' + bundleLine + '\n' +
        '🎯 Snipers: ' + sniperLine + '\n\n' +
        '_Scanned ' + onchain.txScanned + ' earliest on-chain transactions_',
        { chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'Markdown' }
      );
    } catch(e) {
      console.error('deepscan error:', e.message);
      try { await bot.editMessageText('Deep scan error, try again later.', { chat_id: chatId, message_id: waitMsg.message_id }); } catch(e2) {}
    }
    return;
  }
  if (data.startsWith('pnl_')) { await bot.answerCallbackQuery(query.id, { text: 'Generating PNL...' }); await sendPnl(chatId, data.replace('pnl_', ''), username); return; }
  if (data === 'delete')        { await bot.deleteMessage(chatId, msgId); await bot.answerCallbackQuery(query.id, { text: 'Deleted!' }); return; }
  if (data === 'prompt_analyze') { await bot.answerCallbackQuery(query.id); bot.sendMessage(chatId, 'Send any Solana CA directly!'); return; }
  if (data === 'prompt_price')   { await bot.answerCallbackQuery(query.id); bot.sendMessage(chatId, 'Send: /price solana', { parse_mode: 'Markdown' }); return; }
});

// ═══════════════════════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════════════════════
console.log('YakubuWeb3Bot is running!');
console.log('Road Map 1 + 2 active');
console.log('DEX Analysis Engine: ON');
console.log('Wallet Tracking + Crowdsourcing: ON');
console.log('AI Explanation Layer: ' + (ANTHROPIC_API_KEY ? 'ON' : 'OFF (saita ANTHROPIC_API_KEY)'));
console.log('First scan in 1 minute, then every 30 minutes');

setTimeout(() => {
  runScan(true);
  setInterval(runScan, SCAN_INTERVAL_MS);
}, 60 * 1000);

setInterval(checkOpenTrades, 15 * 60 * 1000);
scheduleWeeklyReport();

initGramListener();
setTimeout(processWalletSubmissions, 90 * 1000);
setInterval(processWalletSubmissions, SUBMISSION_CHECK_INTERVAL_MS);
setTimeout(monitorSmartWallets, 120 * 1000);
setInterval(monitorSmartWallets, WALLET_CHECK_INTERVAL_MS);
