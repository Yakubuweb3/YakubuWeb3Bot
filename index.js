require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const Jimp = require('jimp');
const Database = require('better-sqlite3');
const fs = require('fs');

// CONFIG
const ADMIN_ID = 7126311531;
const CHANNEL_ID = -1002693570480;
const MAX_SIGNALS_PER_DAY = 5;
const SCAN_INTERVAL_MS = 30 * 60 * 1000;
const MIN_LIQUIDITY = 5000;
const MIN_AGE_HOURS = 1;
const MAX_AGE_HOURS = 12;
const MAX_RUG_SCORE = 700;

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

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
`);

const pendingSignals = {};

// PAPER TRADING DB
db.exec(`
  CREATE TABLE IF NOT EXISTS paper_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ca TEXT,
    name TEXT,
    symbol TEXT,
    entry_price REAL,
    entry_mc REAL,
    target1 REAL,
    target2 REAL,
    stop_loss REAL,
    sol_amount REAL DEFAULT 1,
    status TEXT DEFAULT 'open',
    result TEXT,
    pnl_pct REAL,
    pnl_sol REAL,
    opened_at INTEGER,
    closed_at INTEGER
  )
`);

function openPaperTrade(ca, name, symbol, entryPrice, entryMc, target1, target2, stopLoss) {
  try {
    db.prepare(`
      INSERT INTO paper_trades (ca, name, symbol, entry_price, entry_mc, target1, target2, stop_loss, sol_amount, status, opened_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'open', ?)
    `).run(ca, name, symbol, entryPrice, entryMc, target1, target2, stopLoss, Date.now());
    console.log('Paper trade opened: ' + ca);
  } catch(e) { console.error('Paper trade error:', e); }
}

function getOpenTrades() {
  try {
    return db.prepare(`SELECT * FROM paper_trades WHERE status = 'open'`).all();
  } catch(e) { return []; }
}

function closePaperTrade(id, result, pnlPct, pnlSol) {
  try {
    db.prepare(`
      UPDATE paper_trades SET status = 'closed', result = ?, pnl_pct = ?, pnl_sol = ?, closed_at = ?
      WHERE id = ?
    `).run(result, pnlPct, pnlSol, Date.now(), id);
  } catch(e) { console.error('Close trade error:', e); }
}

function getWeeklyStats() {
  try {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const trades = db.prepare(`SELECT * FROM paper_trades WHERE closed_at > ? AND status = 'closed'`).all(weekAgo);
    if (trades.length === 0) return null;
    const wins = trades.filter(t => t.result === 'T1' || t.result === 'T2').length;
    const totalPnlSol = trades.reduce((a, b) => a + (b.pnl_sol || 0), 0);
    const winRate = ((wins / trades.length) * 100).toFixed(0);
    const bestTrade = trades.sort((a, b) => b.pnl_pct - a.pnl_pct)[0];
    return { total: trades.length, wins, winRate, totalPnlSol: totalPnlSol.toFixed(3), bestTrade };
  } catch(e) { return null; }
}

// Track price of open trades
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

      // Check Stop Loss
      if (currentPrice <= trade.stop_loss) {
        closePaperTrade(trade.id, 'SL', pnlPct, pnlSol);
        await bot.sendMessage(CHANNEL_ID,
          '🛑 *STOP LOSS HIT*

' +
          '🪙 ' + trade.name + ' (' + trade.symbol + ')
' +
          '📉 Entry: ' + fmtPrice(trade.entry_price) + '
' +
          '📉 Exit: ' + fmtPrice(currentPrice) + '
' +
          '🔴 PNL: ' + pnlPct.toFixed(1) + '% (' + pnlSol.toFixed(3) + ' SOL)

' +
          '_Paper Trade — @YakubuWeb3_',
          { parse_mode: 'Markdown' }
        );
        continue;
      }

      // Check T2 hit
      if (currentPrice >= trade.target2) {
        closePaperTrade(trade.id, 'T2', pnlPct, pnlSol);
        await bot.sendMessage(CHANNEL_ID,
          '🚀 *TARGET 2 HIT!* 2x

' +
          '🪙 ' + trade.name + ' (' + trade.symbol + ')
' +
          '📈 Entry: ' + fmtPrice(trade.entry_price) + '
' +
          '📈 Exit: ' + fmtPrice(currentPrice) + '
' +
          '🟢 PNL: +' + pnlPct.toFixed(1) + '% (+' + pnlSol.toFixed(3) + ' SOL)
' +
          '✖️ ' + (currentPrice / trade.entry_price).toFixed(2) + 'x

' +
          '_Signal by @YakubuWeb3_',
          { parse_mode: 'Markdown' }
        );
        continue;
      }

      // Check T1 hit
      if (currentPrice >= trade.target1 && trade.result !== 'T1_partial') {
        db.prepare(`UPDATE paper_trades SET result = 'T1_partial' WHERE id = ?`).run(trade.id);
        await bot.sendMessage(CHANNEL_ID,
          '✅ *TARGET 1 HIT!* +50%

' +
          '🪙 ' + trade.name + ' (' + trade.symbol + ')
' +
          '📈 Entry: ' + fmtPrice(trade.entry_price) + '
' +
          '📈 Now: ' + fmtPrice(currentPrice) + '
' +
          '🟢 PNL: +' + pnlPct.toFixed(1) + '% (+' + pnlSol.toFixed(3) + ' SOL)
' +
          '🎯 Watching for T2 (+100%)...

' +
          '_Signal by @YakubuWeb3_',
          { parse_mode: 'Markdown' }
        );
        continue;
      }

      // Progress updates at 20% and 30%
      if (pnlPct >= 30 && trade.result !== 'T1_partial' && trade.result !== 'progress_30') {
        db.prepare(`UPDATE paper_trades SET result = 'progress_30' WHERE id = ?`).run(trade.id);
        await bot.sendMessage(CHANNEL_ID,
          '📊 *UPDATE — ' + trade.name + ' (' + trade.symbol + ')*

' +
          '🟢 +' + pnlPct.toFixed(1) + '% (' + pnlSol.toFixed(3) + ' SOL)
' +
          '🎯 ' + toT1 + '% remaining to T1 (+50%)
' +
          '🚀 ' + toT2 + '% remaining to T2 (+100%)

' +
          '_Signal by @YakubuWeb3_',
          { parse_mode: 'Markdown' }
        );
        continue;
      }

      if (pnlPct >= 20 && trade.result !== 'T1_partial' && trade.result !== 'progress_30' && trade.result !== 'progress_20') {
        db.prepare(`UPDATE paper_trades SET result = 'progress_20' WHERE id = ?`).run(trade.id);
        await bot.sendMessage(CHANNEL_ID,
          '📊 *UPDATE — ' + trade.name + ' (' + trade.symbol + ')*

' +
          '🟢 +' + pnlPct.toFixed(1) + '% (' + pnlSol.toFixed(3) + ' SOL)
' +
          '🎯 ' + toT1 + '% remaining to T1 (+50%)
' +
          '🚀 ' + toT2 + '% remaining to T2 (+100%)

' +
          '_Signal by @YakubuWeb3_',
          { parse_mode: 'Markdown' }
        );
        continue;
      }

      await new Promise(r => setTimeout(r, 1000));
    } catch(e) { console.error('Trade check error:', e.message); }
  }
}

// Weekly report every Sunday 8AM
function scheduleWeeklyReport() {
  setInterval(() => {
    const now = new Date();
    if (now.getDay() === 0 && now.getHours() === 8 && now.getMinutes() < 30) {
      sendWeeklyReport();
    }
  }, 30 * 60 * 1000);
}

async function sendWeeklyReport() {
  const stats = getWeeklyStats();
  if (!stats) return;
  const msg =
    '📊 *WEEKLY SIGNAL REPORT*
' +
    '━━━━━━━━━━━━━━━━━━━

' +
    '📅 Last 7 days:
' +
    '📈 Total Signals: ' + stats.total + '
' +
    '✅ Wins: ' + stats.wins + '/' + stats.total + '
' +
    '🎯 Win Rate: ' + stats.winRate + '%
' +
    '💰 Total PNL: ' + (stats.totalPnlSol > 0 ? '+' : '') + stats.totalPnlSol + ' SOL
' +
    (stats.bestTrade ? '🏆 Best Trade: ' + stats.bestTrade.symbol + ' +' + stats.bestTrade.pnl_pct?.toFixed(1) + '%
' : '') +
    '
_Signal by @YakubuWeb3_';

  await bot.sendMessage(CHANNEL_ID, msg, { parse_mode: 'Markdown' });
}

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
  } catch(e) { console.error('DB error:', e); }
}

function getSnapshot(chatId, ca) {
  try {
    return db.prepare('SELECT * FROM snapshots WHERE chat_id = ? AND ca = ? ORDER BY timestamp ASC LIMIT 1').get(String(chatId), ca);
  } catch(e) { return null; }
}

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
  const arrow = c >= 0 ? 'UP' : 'DOWN';
  return (c >= 0 ? 'UP +' : 'DOWN ') + parseFloat(c).toFixed(2) + '%';
}

function fmtChangeEmoji(c) {
  if (!c && c !== 0) return 'N/A';
  const icon = c >= 0 ? '🟢' : '🔴';
  return icon + ' ' + (c >= 0 ? '+' : '') + parseFloat(c).toFixed(2) + '%';
}

function getRugBadge(riskScore) {
  if (riskScore === 'N/A') return 'UNKNOWN';
  const score = Number(riskScore);
  if (score >= 800) return 'HIGH RISK';
  if (score >= 500) return 'MODERATE RISK';
  return 'SAFE';
}

function getRugEmoji(riskScore) {
  if (riskScore === 'N/A') return 'UNKNOWN';
  const score = Number(riskScore);
  if (score >= 800) return '🔴 HIGH RISK';
  if (score >= 500) return '🟡 MODERATE RISK';
  return '🟢 SAFE';
}

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
    if (res.data?.data?.holder && res.data.data.holder > 0) return res.data.data.holder.toLocaleString();
  } catch(e) {}
  if (rugData?.topHolders?.length) return rugData.topHolders.length + '+';
  return 'N/A';
}

// SMART SCANNER
async function fetchCandidateTokens() {
  const results = [];
  try {
    const res = await axios.get('https://api.dexscreener.com/token-boosts/top/v1', { timeout: 10000 });
    const tokens = res.data || [];
    tokens.filter(t => t.chainId === 'solana').forEach(t => { if (t.tokenAddress) results.push(t.tokenAddress); });
  } catch(e) { console.error('Trending fetch error:', e.message); }
  try {
    const res = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 10000 });
    const tokens = res.data || [];
    tokens.filter(t => t.chainId === 'solana').forEach(t => { if (t.tokenAddress) results.push(t.tokenAddress); });
  } catch(e) { console.error('Profiles fetch error:', e.message); }
  return [...new Set(results)];
}

async function analyzeForSignal(ca) {
  try {
    const p = await getTokenData(ca);
    if (!p) return null;
    if (p.chainId !== 'solana') return null;

    if (!p.pairCreatedAt) return null;
    const ageHours = (Date.now() - p.pairCreatedAt) / (1000 * 60 * 60);
    if (ageHours < MIN_AGE_HOURS || ageHours > MAX_AGE_HOURS) return null;

    const liq = p.liquidity?.usd || 0;
    if (liq < MIN_LIQUIDITY) return null;

    const ch24 = parseFloat(p.priceChange?.h24 || 0);
    const ch1 = parseFloat(p.priceChange?.h1 || 0);
    const ch5m = parseFloat(p.priceChange?.m5 || 0);
    const ch15m = parseFloat(p.priceChange?.m15 || 0);

    if (ch24 < 5) return null;
    if (ch5m <= -10 && ch15m <= -10) return null;

    const vol24 = p.volume?.h24 || 0;
    if (vol24 < 500) return null;

    // MC filter: 30K - 100K only
    const mc = p.fdv || 0;
    if (mc < 30000 || mc > 100000) return null;

    const rug = await getRugcheck(ca);
    if (rug && rug.score && rug.score > MAX_RUG_SCORE) return null;

    if (rug) {
      // Block fake holders: top 10 must not hold more than 20%
      const holdersData = rug?.topHolders || rug?.holders || [];
      if (Array.isArray(holdersData) && holdersData.length > 0) {
        const list = holdersData
          .map(h => Number(h.pct || h.percentage || h.share || 0))
          .filter(p => p > 0 && p < 50)
          .sort((a, b) => b - a);
        if (list.length > 0) {
          const top10pct = list.slice(0, 10).reduce((a, b) => a + b, 0);
          if (top10pct > 20) return null;
        }
      }

      // Block heavy bundles
      if (rug.insiderNetworks && rug.insiderNetworks.length > 10) return null;

      // Block heavy snipers
      if (rug.snipers && rug.snipers.length > 10) return null;
    }

    return { p, rug };
  } catch(e) { return null; }
}

let isScanning = false;

async function runScan(triggeredBy) {
  if (isScanning) {
    if (triggeredBy) bot.sendMessage(ADMIN_ID, 'Scan is already running! Please wait...');
    return;
  }
  const todayCount = getTodaySignalCount();
  if (todayCount >= MAX_SIGNALS_PER_DAY) {
    if (triggeredBy) bot.sendMessage(ADMIN_ID, 'Max signals reached today (' + MAX_SIGNALS_PER_DAY + '/' + MAX_SIGNALS_PER_DAY + '). Try tomorrow!');
    console.log('Max signals reached for today. Skipping scan.');
    return;
  }
  isScanning = true;
  console.log('Scanning... (' + todayCount + '/' + MAX_SIGNALS_PER_DAY + ' signals today)');
  try {
    const allCAs = await fetchCandidateTokens();
    console.log('Candidates: ' + allCAs.length);
    let found = 0;
    for (const ca of allCAs) {
      if (getTodaySignalCount() >= MAX_SIGNALS_PER_DAY) break;
      if (alreadyScanned(ca)) continue;
      markScanned(ca);
      const result = await analyzeForSignal(ca);
      if (result) {
        found++;
        console.log('Good token: ' + ca);
        await sendSignalForReview(ca, result.p, result.rug, true);
        await new Promise(r => setTimeout(r, 5000));
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (triggeredBy) {
      if (found === 0) {
        bot.sendMessage(ADMIN_ID, 'Scan complete — no qualifying tokens found. Next auto-scan in 30 mins.');
      } else {
        bot.sendMessage(ADMIN_ID, 'Scan complete — found ' + found + ' token(s)! Check previews above.');
      }
    }
  } catch(e) {
    console.error('Scan error:', e.message);
    if (triggeredBy) bot.sendMessage(ADMIN_ID, 'Scan error: ' + e.message);
  } finally {
    isScanning = false;
  }
}

async function formatMsg(p, ca, chatId) {
  const name = p.baseToken.name;
  const symbol = p.baseToken.symbol;
  const price = parseFloat(p.priceUsd) || 0;
  const mc = p.fdv || 0;

  saveSnapshot(chatId, ca, price, mc, name, symbol);

  const vol24 = fmt(p.volume?.h24);
  const vol6 = fmt(p.volume?.h6);
  const vol1 = fmt(p.volume?.h1);
  const ch24 = fmtChangeEmoji(p.priceChange?.h24);
  const ch6 = fmtChangeEmoji(p.priceChange?.h6);
  const ch1 = fmtChangeEmoji(p.priceChange?.h1);
  const created = p.pairCreatedAt ? Math.floor((Date.now() - p.pairCreatedAt) / 86400000) + 'd ago' : 'N/A';
  const chain = (p.chainId || '').toUpperCase();
  const dex = p.dexId || 'N/A';
  const buys = p.txns?.h24?.buys || 0;
  const sells = p.txns?.h24?.sells || 0;
  const dexPaid = checkDexPaid(p) ? 'Paid' : 'Not Paid';

  let socials = '';
  if (p.info?.websites?.length > 0) socials += '[Web](' + p.info.websites[0].url + ') ';
  if (p.info?.socials?.length > 0) {
    p.info.socials.forEach(s => {
      if (s.type === 'twitter') socials += '[X](' + s.url + ') ';
      if (s.type === 'telegram') socials += '[TG](' + s.url + ') ';
    });
  }
  if (!socials) socials = 'No socials';

  const rug = await getRugcheck(ca);
  let riskScore = 'N/A', riskLevel = 'N/A';
  let bundleInfo = 'No bundles', sniperInfo = 'No snipers';
  let athMc = 'N/A', risks = 'Clean', devInfo = 'N/A';
  let holdersCount = 'N/A', top10 = 'N/A', top20 = 'N/A';

  if (rug) {
    riskScore = rug.score || 0;
    riskLevel = getRugEmoji(riskScore);
    if (rug.markets?.length > 0) {
      const maxMc = Math.max(...rug.markets.map(m => m.marketCap || 0));
      if (maxMc > 0) athMc = fmt(maxMc);
    }
    holdersCount = await getHolderCount(ca, rug);
    const holdersData = rug?.topHolders || rug?.holders || rug?.data?.holders || [];
    if (Array.isArray(holdersData) && holdersData.length > 0) {
      const list = holdersData
        .map(h => ({ address: h.address || '', pct: Number(h.pct || h.percentage || h.share || 0) }))
        .filter(h => h.address && h.pct > 0 && h.pct < 50)
        .sort((a, b) => b.pct - a.pct);
      if (list.length > 0) {
        top10 = Math.min(list.slice(0, 10).reduce((a, b) => a + b.pct, 0), 100).toFixed(1) + '%';
        top20 = Math.min(list.slice(0, 20).reduce((a, b) => a + b.pct, 0), 100).toFixed(1) + '%';
      }
    }
    if (rug.creator) {
      const devBal = rug.creatorBalance ? (rug.creatorBalance / 1e9).toFixed(1) + ' SOL' : '0 SOL';
      const devH = (rug?.topHolders || []).find(h => h.address === rug.creator);
      const devPct = devH ? devH.pct?.toFixed(1) + '%' : '0%';
      devInfo = devBal + ' ' + devPct;
    }
    if (rug.insiderNetworks?.length > 0) {
      const count = rug.insiderNetworks.length;
      const bPct = rug.insiderNetworks.reduce((a, b) => a + (b.holdingPercent || 0), 0);
      const nPct = rug.insiderNetworks.reduce((a, b) => a + (b.currentHoldingPercent || 0), 0);
      bundleInfo = count + ' bundles ' + bPct.toFixed(1) + '% bought ' + nPct.toFixed(1) + '% now' + (bPct > 20 ? ' WARNING' : '');
    }
    if (rug.snipers?.length > 0) {
      const count = rug.snipers.length;
      const bPct = rug.snipers.reduce((a, b) => a + (b.holdingPercent || 0), 0);
      const nPct = rug.snipers.reduce((a, b) => a + (b.currentHoldingPercent || 0), 0);
      sniperInfo = count + ' snipers ' + bPct.toFixed(1) + '% bought ' + nPct.toFixed(1) + '% now';
    }
    if (rug.risks?.length > 0) {
      risks = '';
      rug.risks.slice(0, 3).forEach(r => {
        const icon = r.level === 'danger' ? '🔴' : r.level === 'warn' ? '⚠️' : '📝';
        risks += icon + ' ' + r.name + '\n';
      });
    }
  }

  return '🔍 *' + name + '* (' + symbol + ')\n' +
    '🔗 ' + chain + ' | 🏦 ' + dex + ' | ⏰ ' + created + '\n\n' +
    '💰 *Price:* ' + fmtPrice(price) + '\n' +
    '💊 *MC:* ' + fmt(mc) + ' | 💧 *Liq:* ' + fmt(p.liquidity?.usd) + '\n' +
    '🏆 *ATH MC:* ' + athMc + '\n\n' +
    '📈 *Volume:*\n├ 24h: ' + vol24 + '\n├ 6h: ' + vol6 + '\n└ 1h: ' + vol1 + '\n\n' +
    '📉 *Change:*\n├ 24h: ' + ch24 + '\n├ 6h: ' + ch6 + '\n└ 1h: ' + ch1 + '\n\n' +
    '🛒 *Buys:* ' + buys + ' | 🔴 *Sells:* ' + sells + '\n' +
    '⚡ *Dex:* ' + dexPaid + '\n' +
    '🔗 *Socials:* ' + socials + '\n\n' +
    '👥 *Holders:* ' + holdersCount + '\n├ Top 10: ' + top10 + '\n└ Top 20: ' + top20 + '\n' +
    '🔧 *Dev:* ' + devInfo + '\n\n' +
    '📦 *Bundles:* ' + bundleInfo + '\n' +
    '🎯 *Snipers:* ' + sniperInfo + '\n\n' +
    '🛡️ *Risk Score:* ' + riskScore + ' — ' + riskLevel + '\n' +
    '⚠️ *Flags:*\n' + risks + '\n' +
    '📋 `' + ca + '`\n' +
    '_💰 /pnl ' + ca + '_';
}

function formatSignalPost(p, ca, rug, entryPrice, target1, target2, stopLoss) {
  const name = p.baseToken.name;
  const symbol = p.baseToken.symbol;
  const mc = p.fdv || 0;
  const liq = p.liquidity?.usd || 0;
  const vol24 = fmt(p.volume?.h24);
  const ch5m = fmtChangeEmoji(p.priceChange?.m5);
  const ch1 = fmtChangeEmoji(p.priceChange?.h1);
  const ch24 = fmtChangeEmoji(p.priceChange?.h24);
  const buys = p.txns?.h24?.buys || 0;
  const sells = p.txns?.h24?.sells || 0;
  const chain = (p.chainId || '').toUpperCase();
  const ageHours = p.pairCreatedAt ? ((Date.now() - p.pairCreatedAt) / (1000 * 60 * 60)).toFixed(1) : 'N/A';

  let riskScore = 'N/A';
  let rugBadge = 'UNKNOWN';
  if (rug) { riskScore = rug.score || 0; rugBadge = getRugEmoji(riskScore); }

  let socials = '';
  if (p.info?.websites?.length > 0) socials += '[Web](' + p.info.websites[0].url + ') ';
  if (p.info?.socials?.length > 0) {
    p.info.socials.forEach(s => {
      if (s.type === 'twitter') socials += '[X](' + s.url + ') ';
      if (s.type === 'telegram') socials += '[TG](' + s.url + ') ';
    });
  }
  if (!socials) socials = 'No socials';

  return '📡 *SIGNAL ALERT* — @YakubuWeb3\n' +
    '━━━━━━━━━━━━━━━━━━━\n' +
    '🪙 *' + name + '* (' + symbol + ') | ' + chain + '\n' +
    '⏰ Age: ' + ageHours + 'h | 🏦 Pumpswap\n\n' +
    '💰 *Entry:* ' + fmtPrice(entryPrice) + '\n' +
    '💊 *MC:* ' + fmt(mc) + ' | 💧 *Liq:* ' + fmt(liq) + '\n\n' +
    '🎯 *Targets:*\n' +
    '├ T1: ' + fmtPrice(target1) + ' *(+50%)*\n' +
    '└ T2: ' + fmtPrice(target2) + ' *(+100%)*\n' +
    '🛑 *Stop Loss:* ' + fmtPrice(stopLoss) + ' *(-20%)*\n\n' +
    '📊 *Price Action:*\n' +
    '├ 5m: ' + ch5m + '\n' +
    '├ 1h: ' + ch1 + '\n' +
    '└ 24h: ' + ch24 + '\n\n' +
    '📈 *Vol 24h:* ' + vol24 + '\n' +
    '🛒 *Buys:* ' + buys + ' | 🔴 *Sells:* ' + sells + '\n\n' +
    '🛡️ *Rug Score:* ' + riskScore + ' — ' + rugBadge + '\n' +
    '🔗 *Socials:* ' + socials + '\n\n' +
    '📋 CA: `' + ca + '`\n' +
    '[Chart](https://dexscreener.com/solana/' + ca + ') | [Analyze](https://t.me/YakubuWeb3Bot?start=' + ca + ')\n' +
    '━━━━━━━━━━━━━━━━━━━\n' +
    '_DYOR — Not financial advice_\n' +
    '_Signal by @YakubuWeb3_';
}

async function sendSignalForReview(ca, existingP, existingRug, isAutoScan) {
  try {
    const p = existingP || await getTokenData(ca);
    if (!p) { if (!isAutoScan) bot.sendMessage(ADMIN_ID, 'Token not found!'); return; }

    const rug = existingRug || await getRugcheck(ca);
    const entryPrice = parseFloat(p.priceUsd) || 0;
    const target1 = entryPrice * 1.5;
    const target2 = entryPrice * 2;
    const stopLoss = entryPrice * 0.8;
    const signalText = formatSignalPost(p, ca, rug, entryPrice, target1, target2, stopLoss);
    const ageHours = p.pairCreatedAt ? ((Date.now() - p.pairCreatedAt) / (1000 * 60 * 60)).toFixed(1) : 'N/A';

    pendingSignals[ca] = { p, rug, signalText, entryPrice, target1, target2, stopLoss };

    const todayCount = getTodaySignalCount();
    const badge = isAutoScan ? '🤖 AUTO SCAN' : '👤 MANUAL';

    await bot.sendMessage(ADMIN_ID,
      (isAutoScan ? '🔔' : '👁️') + ' *SIGNAL PREVIEW* — ' + badge + '\n' +
      '📊 Today: ' + todayCount + '/' + MAX_SIGNALS_PER_DAY + ' signals\n' +
      '⏰ Token Age: ' + ageHours + 'h\n\n' + signalText,
      {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ APPROVE — Post to Channel', callback_data: 'approve_' + ca },
            { text: '❌ REJECT', callback_data: 'reject_' + ca }
          ]]
        }
      }
    );
  } catch(e) {
    console.error('Signal review error:', e.message);
    if (!isAutoScan) bot.sendMessage(ADMIN_ID, 'Error preparing signal!');
  }
}

async function postSignalToChannel(ca, msgId) {
  const pending = pendingSignals[ca];
  if (!pending) return bot.sendMessage(ADMIN_ID, 'Signal expired! Re-analyze the token.');

  const todayCount = getTodaySignalCount();
  if (todayCount >= MAX_SIGNALS_PER_DAY) {
    return bot.sendMessage(ADMIN_ID, 'Max signals reached today (' + MAX_SIGNALS_PER_DAY + '/' + MAX_SIGNALS_PER_DAY + '). Try tomorrow!');
  }

  try {
    await bot.sendMessage(CHANNEL_ID, pending.signalText, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: '📈 Chart', url: 'https://dexscreener.com/solana/' + ca },
          { text: '🤖 Analyze', url: 'https://t.me/YakubuWeb3Bot?start=' + ca }
        ]]
      }
    });

    recordSignalSent(ca);
    saveSnapshot(CHANNEL_ID, ca, pending.entryPrice, pending.p.fdv || 0, pending.p.baseToken.name, pending.p.baseToken.symbol);

    // Open paper trade automatically
    openPaperTrade(
      ca,
      pending.p.baseToken.name,
      pending.p.baseToken.symbol,
      pending.entryPrice,
      pending.p.fdv || 0,
      pending.target1,
      pending.target2,
      pending.stopLoss
    );

    delete pendingSignals[ca];

    const newCount = getTodaySignalCount();
    await bot.editMessageText(
      '✅ *Signal posted to channel!*\n📊 Today: ' + newCount + '/' + MAX_SIGNALS_PER_DAY + '\n\n' + pending.signalText,
      { chat_id: ADMIN_ID, message_id: msgId, parse_mode: 'Markdown', disable_web_page_preview: true }
    );
    bot.sendMessage(ADMIN_ID, '🎉 Signal posted! (' + newCount + '/' + MAX_SIGNALS_PER_DAY + ' today)');
  } catch(e) {
    bot.sendMessage(ADMIN_ID, 'Failed to post to channel! Check bot is admin in channel.');
    console.error(e);
  }
}

async function sendAnalysis(chatId, ca, username) {
  const loadMsg = await bot.sendMessage(chatId, '⏳ Analyzing token...');
  try {
    const p = await getTokenData(ca);
    if (!p) { await bot.deleteMessage(chatId, loadMsg.message_id); return bot.sendMessage(chatId, 'Token not found!'); }
    const text = await formatMsg(p, ca, chatId);
    await bot.deleteMessage(chatId, loadMsg.message_id);
    const isAdmin = String(chatId) === String(ADMIN_ID);
    const keyboard = isAdmin
      ? [[
          { text: '🔄 Refresh', callback_data: 'refresh_' + ca },
          { text: '🗑️ Delete', callback_data: 'delete' },
          { text: '📈 Chart', url: 'https://dexscreener.com/solana/' + ca }
        ],[
          { text: '💰 PNL Card', callback_data: 'pnl_' + ca },
          { text: '📡 Send as Signal', callback_data: 'signal_' + ca }
        ]]
      : [[
          { text: '🔄 Refresh', callback_data: 'refresh_' + ca },
          { text: '🗑️ Delete', callback_data: 'delete' },
          { text: '📈 Chart', url: 'https://dexscreener.com/solana/' + ca }
        ],[
          { text: '💰 PNL Card', callback_data: 'pnl_' + ca }
        ]];
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
  for (let x = 0; x < W; x++) {
    for (let t = 0; t < 4; t++) { img.setPixelColor(borderColor, x, t); img.setPixelColor(borderColor, x, H - 1 - t); }
  }
  for (let y = 0; y < H; y++) {
    for (let t = 0; t < 4; t++) { img.setPixelColor(borderColor, t, y); img.setPixelColor(borderColor, W - 1 - t, y); }
  }
  const font64 = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
  const font32 = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
  const font16 = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
  img.print(font32, 40, 35, name + ' (' + symbol + ')');
  img.print(font64, 40, 90, (isProfit ? '+' : '') + pnlPct.toFixed(1) + '%');
  img.print(font32, 40, 175, multiplier.toFixed(2) + 'x');
  img.print(font16, 40, 240, 'Entry MC:      ' + fmt(entryMc));
  img.print(font16, 40, 265, 'Current MC:    ' + fmt(currentMc));
  img.print(font16, 40, 295, 'Entry Price:   ' + fmtPrice(entryPrice));
  img.print(font16, 40, 320, 'Current Price: ' + fmtPrice(currentPrice));
  const timeAgo = Math.floor((Date.now() - entryTime) / 60000);
  const timeStr = timeAgo < 60 ? timeAgo + 'm ago' : Math.floor(timeAgo / 60) + 'h ' + (timeAgo % 60) + 'm ago';
  img.print(font16, 40, 360, 'Called: ' + timeStr);
  img.print(font16, 40, 390, '@' + (username || 'Anonymous'));
  img.print(font16, W - 220, H - 25, '@YakubuWeb3Bot');
  const filePath = '/tmp/pnl_' + Date.now() + '.png';
  await img.writeAsync(filePath);
  return filePath;
}

async function sendPnl(chatId, ca, username) {
  const snap = getSnapshot(chatId, ca);
  if (!snap) return bot.sendMessage(chatId, 'No entry found! Send the CA first to record entry price.');
  const loadMsg = await bot.sendMessage(chatId, '⏳ Generating PNL card...');
  try {
    const p = await getTokenData(ca);
    if (!p) { await bot.deleteMessage(chatId, loadMsg.message_id); return bot.sendMessage(chatId, 'Token not found!'); }
    const currentPrice = parseFloat(p.priceUsd) || 0;
    const currentMc = p.fdv || 0;
    const entryPrice = snap.price;
    const entryMc = snap.mc;
    const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
    const multiplier = currentPrice / entryPrice;
    const isProfit = pnlPct >= 0;
    const imgPath = await generatePnlImage({ name: snap.name, symbol: snap.symbol, entryMc, currentMc, entryPrice, currentPrice, pnlPct, multiplier, isProfit, username: username || 'Anonymous', entryTime: snap.timestamp });
    await bot.deleteMessage(chatId, loadMsg.message_id);
    const caption = '💰 *PNL — ' + snap.name + ' (' + snap.symbol + ')*\n\n' +
      '📥 Entry MC: ' + fmt(entryMc) + '\n' +
      '📤 Current MC: ' + fmt(currentMc) + '\n' +
      (isProfit ? '🟢' : '🔴') + ' PNL: ' + (isProfit ? '+' : '') + pnlPct.toFixed(1) + '%\n' +
      '✖️ Multiplier: ' + multiplier.toFixed(2) + 'x\n\n' +
      '_Powered by @YakubuWeb3Bot_';
    await bot.sendPhoto(chatId, imgPath, { caption, parse_mode: 'Markdown' });
    fs.unlinkSync(imgPath);
  } catch(e) {
    try { await bot.deleteMessage(chatId, loadMsg.message_id); } catch(err) {}
    bot.sendMessage(chatId, 'Error generating PNL!');
    console.error(e);
  }
}

// COMMANDS
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    '🚀 *YakubuWeb3 Signal Bot*\n\n' +
    'Send any *Solana CA* to analyze!\n\n' +
    '📡 Auto-scans every 30 mins for alpha\n' +
    '🎯 3-5 quality signals per day\n\n' +
    '/pnl <CA> — PNL Card\n' +
    '/price <symbol> — Price Check\n' +
    '/status — Bot status\n' +
    '/help — All Commands\n\n' +
    '_Powered by @YakubuWeb3_',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📊 Analyze Token', callback_data: 'prompt_analyze' }, { text: '💰 Price Check', callback_data: 'prompt_price' }]] } }
  );
});

bot.onText(/\/help/, (msg) => {
  const isAdmin = String(msg.chat.id) === String(ADMIN_ID);
  const adminCmds = isAdmin ? '\n\n👑 *Admin:*\n/signal <CA> — Manual signal\n/scan — Force scan now\n/pending — Pending signals\n/stats — Stats' : '';
  bot.sendMessage(msg.chat.id, '📋 *Commands:*\n\nSend CA — Analyze\n/pnl <CA> — PNL Card\n/price <symbol> — Price\n/status — Today signals' + adminCmds, { parse_mode: 'Markdown' });
});

bot.onText(/\/status/, (msg) => {
  const count = getTodaySignalCount();
  bot.sendMessage(msg.chat.id, '📊 *Bot Status*\n\n📡 Signals today: ' + count + '/' + MAX_SIGNALS_PER_DAY + '\n🔄 Scan: Every 30 mins\n✅ Running!', { parse_mode: 'Markdown' });
});

bot.onText(/\/stats/, (msg) => {
  if (String(msg.chat.id) !== String(ADMIN_ID)) return;
  const count = getTodaySignalCount();
  const pending = Object.keys(pendingSignals).length;
  bot.sendMessage(ADMIN_ID, '📊 *Stats*\n\n📅 Today: ' + count + '/' + MAX_SIGNALS_PER_DAY + '\n⏳ Pending: ' + pending, { parse_mode: 'Markdown' });
});

bot.onText(/\/scan/, async (msg) => {
  if (String(msg.chat.id) !== String(ADMIN_ID)) return;
  bot.sendMessage(ADMIN_ID, '🔍 Starting manual scan...');
  await runScan(true);
});

bot.onText(/\/signal (.+)/, async (msg, match) => {
  if (String(msg.chat.id) !== String(ADMIN_ID)) return bot.sendMessage(msg.chat.id, 'Admin only!');
  await sendSignalForReview(match[1].trim(), null, null, false);
});

bot.onText(/\/pending/, (msg) => {
  if (String(msg.chat.id) !== String(ADMIN_ID)) return;
  const keys = Object.keys(pendingSignals);
  if (keys.length === 0) return bot.sendMessage(ADMIN_ID, 'No pending signals.');
  bot.sendMessage(ADMIN_ID, '📋 *Pending (' + keys.length + '):*\n\n' + keys.map((k, i) => (i+1) + '. `' + k + '`').join('\n'), { parse_mode: 'Markdown' });
});

bot.onText(/\/analyze (.+)/, async (msg, match) => { await sendAnalysis(msg.chat.id, match[1].trim(), msg.from?.username); });
bot.onText(/\/pnl (.+)/, async (msg, match) => { await sendPnl(msg.chat.id, match[1].trim(), msg.from?.username); });

bot.onText(/\/price (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const symbol = match[1].trim().toLowerCase();
  const loadMsg = await bot.sendMessage(chatId, '⏳ Fetching price...');
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=' + symbol + '&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true');
    const data = res.data[symbol];
    if (!data) { await bot.deleteMessage(chatId, loadMsg.message_id); return bot.sendMessage(chatId, 'Coin not found!'); }
    await bot.deleteMessage(chatId, loadMsg.message_id);
    bot.sendMessage(chatId, '💰 *' + symbol.toUpperCase() + '*\n\n💵 *Price:* ' + fmtPrice(data.usd) + '\n📊 *MC:* ' + fmt(data.usd_market_cap) + '\n📈 *Vol (24h):* ' + fmt(data.usd_24h_vol) + '\n' + fmtChangeEmoji(data.usd_24h_change) + ' *(24h)*\n\n_Powered by @YakubuWeb3_', { parse_mode: 'Markdown' });
  } catch(e) { await bot.deleteMessage(chatId, loadMsg.message_id); bot.sendMessage(chatId, 'Error!'); }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  if (text.startsWith('/')) return;
  const ca = text.trim();
  if (ca.length >= 32 && ca.length <= 44 && /^[A-Za-z0-9]+$/.test(ca)) {
    await sendAnalysis(chatId, ca, msg.from?.username);
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const data = query.data;
  const username = query.from?.username;

  if (data.startsWith('signal_')) {
    if (String(chatId) !== String(ADMIN_ID)) return bot.answerCallbackQuery(query.id, { text: 'Admin only!' });
    await bot.answerCallbackQuery(query.id, { text: 'Preparing signal preview...' });
    await sendSignalForReview(data.replace('signal_', ''), null, null, false);
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
    await bot.editMessageText('❌ *Signal rejected.*\n\nCA: `' + ca + '`', { chat_id: ADMIN_ID, message_id: msgId, parse_mode: 'Markdown' });
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
        ? [[{ text: '🔄 Refresh', callback_data: 'refresh_' + ca }, { text: '🗑️ Delete', callback_data: 'delete' }, { text: '📈 Chart', url: 'https://dexscreener.com/solana/' + ca }],[{ text: '💰 PNL Card', callback_data: 'pnl_' + ca }, { text: '📡 Send as Signal', callback_data: 'signal_' + ca }]]
        : [[{ text: '🔄 Refresh', callback_data: 'refresh_' + ca }, { text: '🗑️ Delete', callback_data: 'delete' }, { text: '📈 Chart', url: 'https://dexscreener.com/solana/' + ca }],[{ text: '💰 PNL Card', callback_data: 'pnl_' + ca }]];
      await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard } });
    } catch(e) { bot.answerCallbackQuery(query.id, { text: 'Error!' }); }
    return;
  }

  if (data.startsWith('pnl_')) {
    await bot.answerCallbackQuery(query.id, { text: 'Generating PNL...' });
    await sendPnl(chatId, data.replace('pnl_', ''), username);
    return;
  }

  if (data === 'delete') { await bot.deleteMessage(chatId, msgId); await bot.answerCallbackQuery(query.id, { text: 'Deleted!' }); return; }
  if (data === 'prompt_analyze') { await bot.answerCallbackQuery(query.id); bot.sendMessage(chatId, 'Send any Solana CA directly!'); return; }
  if (data === 'prompt_price') { await bot.answerCallbackQuery(query.id); bot.sendMessage(chatId, 'Send: /price solana', { parse_mode: 'Markdown' }); return; }
});

// START
console.log('✅ YakubuWeb3Bot is running!');
console.log('🔍 First scan in 1 minute, then every 30 minutes');

setTimeout(() => {
  runScan(true);
  setInterval(runScan, SCAN_INTERVAL_MS);
}, 60 * 1000);

// Check open paper trades every 15 minutes
setInterval(checkOpenTrades, 15 * 60 * 1000);

// Weekly report scheduler
scheduleWeeklyReport();
