require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const Jimp = require('jimp');
const Database = require('better-sqlite3');
const fs = require('fs');

// ═══════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════
const ADMIN_ID            = 7126311531;
const CHANNEL_ID          = -1002693570480;
const MAX_SIGNALS_PER_DAY = 5;
const SCAN_INTERVAL_MS    = 20 * 60 * 1000; // every 20 mins

// ── Token Filters ──
const MIN_LIQUIDITY  = 3000;
const MIN_AGE_HOURS  = 0.5;
const MAX_AGE_HOURS  = 48;
const MAX_RUG_SCORE  = 800;
const MIN_MC         = 10000;
const MAX_MC         = 800000;
const MIN_VOLUME_24H = 500;
const SCORE_PASS_MIN = 35;

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// ═══════════════════════════════════════════════
//  DATABASE
// ═══════════════════════════════════════════════
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
  CREATE TABLE IF NOT EXISTS pending_signals (
    ca TEXT PRIMARY KEY,
    signal_text TEXT,
    entry_price REAL,
    target1 REAL,
    target2 REAL,
    stop_loss REAL,
    token_name TEXT,
    token_symbol TEXT,
    token_fdv REAL,
    saved_at INTEGER
  );
`);

let isScanning = false;

// ── Pending Signals — DB backed (survives restarts) ──
function savePendingSignal(ca, data) {
  try {
    db.prepare('INSERT OR REPLACE INTO pending_signals (ca, signal_text, entry_price, target1, target2, stop_loss, token_name, token_symbol, token_fdv, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      ca, data.signalText, data.entry, data.t1, data.t2, data.sl,
      data.p.baseToken.name, data.p.baseToken.symbol, data.p.fdv || 0, Date.now()
    );
  } catch(e) { console.error('savePendingSignal error:', e.message); }
}
function getPendingSignal(ca) {
  try { return db.prepare('SELECT * FROM pending_signals WHERE ca = ?').get(ca); } catch(e) { return null; }
}
function deletePendingSignal(ca) {
  try { db.prepare('DELETE FROM pending_signals WHERE ca = ?').run(ca); } catch(e) {}
}
function cleanOldPending() {
  try {
    // Delete pending signals older than 12 hours
    const cutoff = Date.now() - 12 * 60 * 60 * 1000;
    db.prepare('DELETE FROM pending_signals WHERE saved_at < ?').run(cutoff);
  } catch(e) {}
}

// ═══════════════════════════════════════════════
//  DB HELPERS
// ═══════════════════════════════════════════════
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
  return (Date.now() - row.last_scanned) < 3 * 60 * 60 * 1000;
}
function markScanned(ca) {
  db.prepare('INSERT OR REPLACE INTO scanned_tokens (ca, last_scanned) VALUES (?, ?)').run(ca, Date.now());
}
function saveSnapshot(chatId, ca, price, mc, name, symbol) {
  try { db.prepare('INSERT INTO snapshots (chat_id, ca, price, mc, name, symbol, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)').run(String(chatId), ca, price, mc, name, symbol, Date.now()); } catch(e) {}
}
function getSnapshot(chatId, ca) {
  try { return db.prepare('SELECT * FROM snapshots WHERE chat_id = ? AND ca = ? ORDER BY timestamp ASC LIMIT 1').get(String(chatId), ca); } catch(e) { return null; }
}
function openPaperTrade(ca, name, symbol, entryPrice, entryMc, target1, target2, stopLoss) {
  try { db.prepare('INSERT INTO paper_trades (ca, name, symbol, entry_price, entry_mc, target1, target2, stop_loss, sol_amount, status, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)').run(ca, name, symbol, entryPrice, entryMc, target1, target2, stopLoss, 'open', Date.now()); } catch(e) {}
}
function getOpenTrades() {
  try { return db.prepare('SELECT * FROM paper_trades WHERE status = ?').all('open'); } catch(e) { return []; }
}
function closePaperTrade(id, result, pnlPct, pnlSol) {
  try { db.prepare('UPDATE paper_trades SET status = ?, result = ?, pnl_pct = ?, pnl_sol = ?, closed_at = ? WHERE id = ?').run('closed', result, pnlPct, pnlSol, Date.now(), id); } catch(e) {}
}
function getWeeklyStats() {
  try {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const trades = db.prepare('SELECT * FROM paper_trades WHERE closed_at > ? AND status = ?').all(weekAgo, 'closed');
    if (!trades.length) return null;
    const wins = trades.filter(t => ['T1', 'T2', 'T1_partial'].includes(t.result)).length;
    const totalPnl = trades.reduce((a, b) => a + (b.pnl_sol || 0), 0);
    const best = [...trades].sort((a, b) => (b.pnl_pct || 0) - (a.pnl_pct || 0))[0];
    return { total: trades.length, wins, winRate: ((wins / trades.length) * 100).toFixed(0), totalPnl: totalPnl.toFixed(3), best };
  } catch(e) { return null; }
}

// ═══════════════════════════════════════════════
//  FORMATTERS
// ═══════════════════════════════════════════════
function fmt(n) {
  if (!n) return 'N/A';
  if (n >= 1e9) return '$' + (n/1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n/1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n/1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(2);
}
function fmtPrice(p) {
  if (!p) return 'N/A';
  const n = parseFloat(p);
  if (n < 0.000001) return '$' + n.toExponential(2);
  if (n < 0.01) return '$' + n.toFixed(8);
  if (n < 1) return '$' + n.toFixed(4);
  return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmtPct(c) {
  if (!c && c !== 0) return 'N/A';
  const icon = c >= 0 ? '🟢' : '🔴';
  return icon + ' ' + (c >= 0 ? '+' : '') + parseFloat(c).toFixed(2) + '%';
}
function rugEmoji(s) {
  if (s === 'N/A') return '⚪ UNKNOWN';
  const n = Number(s);
  if (n >= 800) return '🔴 HIGH RISK';
  if (n >= 500) return '🟡 MODERATE';
  return '🟢 SAFE';
}

// ═══════════════════════════════════════════════
//  API
// ═══════════════════════════════════════════════
async function getTokenData(ca) {
  try {
    const res = await axios.get('https://api.dexscreener.com/latest/dex/tokens/' + ca, { timeout: 10000 });
    const pairs = res.data?.pairs;
    if (!pairs || !pairs.length) return null;
    const sol = pairs.filter(p => p.chainId === 'solana');
    if (!sol.length) return null;
    sol.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    return sol[0];
  } catch(e) { return null; }
}

async function getRugcheck(ca) {
  try {
    const res = await axios.get('https://api.rugcheck.xyz/v1/tokens/' + ca + '/report', { timeout: 8000 });
    return res.data;
  } catch(e) { return null; }
}

// ═══════════════════════════════════════════════
//  FETCH CANDIDATE TOKENS — Multiple Sources
// ═══════════════════════════════════════════════
async function fetchCandidateTokens() {
  const results = [];

  // Source 1: Dexscreener boosted tokens
  try {
    const res = await axios.get('https://api.dexscreener.com/token-boosts/top/v1', { timeout: 10000 });
    (res.data || []).filter(t => t.chainId === 'solana').forEach(t => { if (t.tokenAddress) results.push(t.tokenAddress); });
    console.log('Source 1 (boosts):', results.length);
  } catch(e) { console.log('Source 1 failed:', e.message); }

  // Source 2: Dexscreener latest profiles
  try {
    const res = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 10000 });
    (res.data || []).filter(t => t.chainId === 'solana').forEach(t => { if (t.tokenAddress) results.push(t.tokenAddress); });
    console.log('Source 2 (profiles):', results.length);
  } catch(e) { console.log('Source 2 failed:', e.message); }

  // Source 3: Pump.fun latest trades
  try {
    const res = await axios.get('https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=false', { timeout: 10000 });
    (res.data || []).forEach(t => { if (t.mint) results.push(t.mint); });
    console.log('Source 3 (pump.fun):', results.length);
  } catch(e) { console.log('Source 3 failed:', e.message); }

  // Source 4: Pump.fun graduated tokens (moved to dex)
  try {
    const res = await axios.get('https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=market_cap&order=DESC&includeNsfw=false', { timeout: 10000 });
    (res.data || []).forEach(t => { if (t.mint) results.push(t.mint); });
    console.log('Source 4 (pump top mc):', results.length);
  } catch(e) { console.log('Source 4 failed:', e.message); }

  // Source 5: Dexscreener search - new solana pairs
  try {
    const res = await axios.get('https://api.dexscreener.com/latest/dex/search?q=solana', { timeout: 10000 });
    (res.data?.pairs || []).filter(p => p.chainId === 'solana').forEach(p => {
      if (p.baseToken?.address) results.push(p.baseToken.address);
    });
    console.log('Source 5 (dex search):', results.length);
  } catch(e) { console.log('Source 5 failed:', e.message); }

  const unique = [...new Set(results)];
  console.log('Total unique candidates:', unique.length);
  return unique;
}

// ═══════════════════════════════════════════════
//  DEX ANALYSIS ENGINE
// ═══════════════════════════════════════════════
function scoreVolumeMomentum(p) {
  let score = 0;
  const notes = [];
  const v1h = parseFloat(p.volume?.h1 || 0);
  const v6h = parseFloat(p.volume?.h6 || 0);
  const v24h = parseFloat(p.volume?.h24 || 0);
  const ch5m = parseFloat(p.priceChange?.m5 || 0);
  const ch1h = parseFloat(p.priceChange?.h1 || 0);
  const ch24h = parseFloat(p.priceChange?.h24 || 0);
  const buys1h = p.txns?.h1?.buys || 0;
  const sells1h = p.txns?.h1?.sells || 0;

  if (v6h > 0) {
    const share = (v1h / v6h) * 100;
    if (share > 40) { score += 20; notes.push('🔥 Volume spike 1h (' + share.toFixed(0) + '% of 6h)'); }
    else if (share > 20) { score += 10; notes.push('📈 Rising volume'); }
    else { score += 4; }
  }
  if (buys1h + sells1h > 0) {
    const buyPct = (buys1h / (buys1h + sells1h)) * 100;
    if (buyPct > 65) { score += 15; notes.push('🟢 Strong buys ' + buyPct.toFixed(0) + '%'); }
    else if (buyPct > 50) { score += 7; notes.push('🟡 Moderate buys ' + buyPct.toFixed(0) + '%'); }
    else { score -= 5; notes.push('🔴 Sell pressure ' + (100-buyPct).toFixed(0) + '%'); }
  }
  if (ch5m > 3 && ch1h > 5) { score += 10; notes.push('🚀 Strong momentum'); }
  if (ch5m < -8 && ch1h < -8) { score -= 15; notes.push('📉 Dumping'); }

  return { score: Math.max(0, Math.min(score, 100)), notes };
}

function scoreWhaleDetection(p, rug) {
  let score = 0;
  const notes = [];
  const whales = [];
  if (!rug) return { score: 10, notes: ['⚪ No rug data'], whales };

  const holders = rug?.topHolders || rug?.holders || [];
  if (holders.length > 0) {
    const list = holders.map(h => ({ addr: h.address || '', pct: Number(h.pct || h.percentage || h.share || 0) }))
      .filter(h => h.addr && h.pct > 0 && h.pct < 60).sort((a, b) => b.pct - a.pct);
    const top1 = list[0]?.pct || 0;
    const top10 = list.slice(0, 10).reduce((a, b) => a + b.pct, 0);

    if (top1 > 15) { score -= 20; notes.push('🐋 DANGER top holder ' + top1.toFixed(1) + '%'); }
    else if (top1 > 7) { score -= 8; notes.push('⚠️ Top holder ' + top1.toFixed(1) + '%'); }
    else { score += 10; notes.push('✅ Top holder ' + top1.toFixed(1) + '%'); }

    if (top10 < 20) { score += 15; notes.push('✅ Good distribution top10=' + top10.toFixed(1) + '%'); }
    else if (top10 < 35) { score += 5; notes.push('🟡 Moderate concentration'); }
    else { score -= 10; notes.push('🔴 Concentrated top10=' + top10.toFixed(1) + '%'); }

    list.slice(0, 3).forEach((h, i) => { if (h.pct > 1) whales.push({ rank: i+1, addr: h.addr.slice(0,6)+'...'+h.addr.slice(-4), pct: h.pct.toFixed(2) }); });
  } else {
    score += 5;
    notes.push('⚪ No holder data');
  }

  if (rug.insiderNetworks?.length > 0) {
    const bPct = rug.insiderNetworks.reduce((a, b) => a + (b.holdingPercent || 0), 0);
    if (bPct > 25) { score -= 20; notes.push('🔴 Bundles ' + bPct.toFixed(1) + '%'); }
    else if (bPct > 10) { score -= 8; notes.push('⚠️ Bundles ' + bPct.toFixed(1) + '%'); }
    else { score += 5; notes.push('✅ Low bundles'); }
  } else { score += 8; notes.push('✅ No bundles'); }

  if (rug.snipers?.length > 0) {
    const sPct = rug.snipers.reduce((a, b) => a + (b.holdingPercent || 0), 0);
    if (sPct > 10) { score -= 10; notes.push('🎯 Snipers ' + sPct.toFixed(1) + '%'); }
    else { score += 5; notes.push('✅ Low snipers'); }
  } else { score += 5; notes.push('✅ No snipers'); }

  return { score: Math.max(0, Math.min(score, 100)), notes, whales };
}

function scoreSmartMoney(p, rug) {
  let score = 0;
  const notes = [];
  if (!rug) return { score: 10, notes: ['⚪ No rug data'] };

  const v1h = p.volume?.h1 || 0;
  const buys = p.txns?.h1?.buys || 0;
  if (buys > 0 && v1h > 0) {
    const avg = v1h / buys;
    if (avg > 500) { score += 20; notes.push('💰 Avg buy $' + avg.toFixed(0)); }
    else if (avg > 200) { score += 10; notes.push('💵 Avg buy $' + avg.toFixed(0)); }
    else { score += 3; notes.push('🟡 Small buys $' + avg.toFixed(0)); }
  }

  if (rug.creator) {
    const devH = (rug?.topHolders || []).find(h => h.address === rug.creator);
    const devPct = devH ? Number(devH.pct || 0) : 0;
    if (devPct === 0) { score += 15; notes.push('✅ Dev not holding'); }
    else if (devPct < 3) { score += 8; notes.push('✅ Dev ' + devPct.toFixed(1) + '%'); }
    else if (devPct > 5) { score -= 15; notes.push('🔴 Dev holds ' + devPct.toFixed(1) + '%!'); }
  }

  if (rug.score !== undefined) {
    const rs = Number(rug.score);
    if (rs < 200) { score += 20; notes.push('🟢 Rug score ' + rs); }
    else if (rs < 500) { score += 10; notes.push('🟡 Rug score ' + rs); }
    else { score -= 10; notes.push('🔴 Rug score ' + rs); }
  }

  const hasSocials = p.info?.socials?.length > 0 || p.info?.websites?.length > 0;
  if (hasSocials) { score += 8; notes.push('✅ Has socials'); }

  return { score: Math.max(0, Math.min(score, 100)), notes };
}

function calcTokenStrength(p, rug) {
  const mom = scoreVolumeMomentum(p);
  const whl = scoreWhaleDetection(p, rug);
  const smt = scoreSmartMoney(p, rug);
  const final = Math.round((mom.score * 0.35) + (whl.score * 0.35) + (smt.score * 0.30));
  let grade, emoji;
  if (final >= 80) { grade = 'S'; emoji = '🏆'; }
  else if (final >= 65) { grade = 'A'; emoji = '🔥'; }
  else if (final >= 50) { grade = 'B'; emoji = '✅'; }
  else if (final >= 35) { grade = 'C'; emoji = '🟡'; }
  else { grade = 'D'; emoji = '🔴'; }
  return { final, grade, emoji, passes: final >= SCORE_PASS_MIN, mom, whl, smt };
}

function fmtAnalysis(a) {
  let r = '\n━━━━━━━━━━━━━━━━━━━\n🧠 *DEX ANALYSIS*\n━━━━━━━━━━━━━━━━━━━\n\n';
  r += a.emoji + ' *Score: ' + a.final + '/100 — Grade ' + a.grade + '*\n\n';
  r += '📊 *Momentum* (' + a.mom.score + 'pts)\n';
  a.mom.notes.slice(0,2).forEach(n => { r += '  ' + n + '\n'; });
  r += '\n🐋 *Whales* (' + a.whl.score + 'pts)\n';
  a.whl.notes.slice(0,2).forEach(n => { r += '  ' + n + '\n'; });
  r += '\n💰 *Smart Money* (' + a.smt.score + 'pts)\n';
  a.smt.notes.slice(0,2).forEach(n => { r += '  ' + n + '\n'; });
  r += '\n━━━━━━━━━━━━━━━━━━━\n';
  r += a.passes ? '✅ *PASSES — Ready for review*\n' : '❌ *FAILS — Score too low*\n';
  return r;
}

// ═══════════════════════════════════════════════
//  MAIN SCAN LOGIC
// ═══════════════════════════════════════════════
async function analyzeForSignal(ca) {
  try {
    const p = await getTokenData(ca);
    if (!p) return null;

    // Age
    if (!p.pairCreatedAt) return null;
    const ageH = (Date.now() - p.pairCreatedAt) / 3600000;
    if (ageH < MIN_AGE_HOURS || ageH > MAX_AGE_HOURS) return null;

    // Liquidity
    const liq = p.liquidity?.usd || 0;
    if (liq < MIN_LIQUIDITY) return null;

    // MC
    const mc = p.fdv || 0;
    if (mc < MIN_MC || mc > MAX_MC) return null;

    // Volume
    if ((p.volume?.h24 || 0) < MIN_VOLUME_24H) return null;

    // Not dumping hard
    const ch1h = parseFloat(p.priceChange?.h1 || 0);
    if (ch1h < -30) return null;

    // Rug check
    const rug = await getRugcheck(ca);
    if (rug?.score && rug.score > MAX_RUG_SCORE) return null;

    // DEX score
    const analysis = calcTokenStrength(p, rug);
    if (!analysis.passes) {
      console.log('FAIL', ca.slice(0,8), 'score:', analysis.final);
      return null;
    }

    console.log('PASS', ca.slice(0,8), 'score:', analysis.final, 'grade:', analysis.grade);
    return { p, rug, analysis };
  } catch(e) {
    console.log('analyzeForSignal error:', e.message);
    return null;
  }
}

async function runScan(manual) {
  if (isScanning) {
    if (manual) bot.sendMessage(ADMIN_ID, '⏳ Scan already running, please wait...');
    return;
  }
  if (getTodaySignalCount() >= MAX_SIGNALS_PER_DAY) {
    if (manual) bot.sendMessage(ADMIN_ID, '✅ Max signals reached today (' + MAX_SIGNALS_PER_DAY + '/' + MAX_SIGNALS_PER_DAY + ')');
    return;
  }
  isScanning = true;
  if (manual) bot.sendMessage(ADMIN_ID, '🔍 Scanning... fetching tokens from 5 sources');
  console.log('=== SCAN STARTED ===');

  try {
    const cas = await fetchCandidateTokens();
    if (manual) bot.sendMessage(ADMIN_ID, '📋 Found ' + cas.length + ' candidates — analyzing...');

    let found = 0;
    let checked = 0;
    for (const ca of cas) {
      if (getTodaySignalCount() >= MAX_SIGNALS_PER_DAY) break;
      if (alreadyScanned(ca)) continue;
      markScanned(ca);
      checked++;
      const result = await analyzeForSignal(ca);
      if (result) {
        found++;
        await sendSignalForReview(ca, result.p, result.rug, result.analysis, true);
        await new Promise(r => setTimeout(r, 3000));
      }
      await new Promise(r => setTimeout(r, 500));
    }

    console.log('=== SCAN DONE === checked:', checked, 'found:', found);
    if (manual) {
      bot.sendMessage(ADMIN_ID, found === 0
        ? '🔍 Scan done — checked ' + checked + ' tokens, none qualified. Next scan in 20 mins.'
        : '✅ Scan done — ' + found + ' signal(s) sent for review!'
      );
    }
  } catch(e) {
    console.error('Scan error:', e.message);
    if (manual) bot.sendMessage(ADMIN_ID, '❌ Scan error: ' + e.message);
  } finally {
    isScanning = false;
  }
}

// ═══════════════════════════════════════════════
//  SIGNAL REVIEW
// ═══════════════════════════════════════════════
function fmtSignalPost(p, ca, rug, entry, t1, t2, sl) {
  const name = p.baseToken.name;
  const sym = p.baseToken.symbol;
  const mc = p.fdv || 0;
  const liq = p.liquidity?.usd || 0;
  const ageH = p.pairCreatedAt ? ((Date.now() - p.pairCreatedAt) / 3600000).toFixed(1) : 'N/A';
  const buys = p.txns?.h24?.buys || 0;
  const sells = p.txns?.h24?.sells || 0;
  const rs = rug?.score || 'N/A';
  let socials = '';
  if (p.info?.websites?.[0]) socials += '[Web](' + p.info.websites[0].url + ') ';
  if (p.info?.socials) p.info.socials.forEach(s => {
    if (s.type === 'twitter') socials += '[X](' + s.url + ') ';
    if (s.type === 'telegram') socials += '[TG](' + s.url + ') ';
  });
  if (!socials) socials = 'No socials';
  return (
    '📡 *SIGNAL ALERT* — @YakubuWeb3\n' +
    '━━━━━━━━━━━━━━━━━━━\n' +
    '🪙 *' + name + '* (' + sym + ') | SOLANA\n' +
    '⏰ Age: ' + ageH + 'h\n\n' +
    '💰 *Entry:* ' + fmtPrice(entry) + '\n' +
    '💊 *MC:* ' + fmt(mc) + ' | 💧 *Liq:* ' + fmt(liq) + '\n\n' +
    '🎯 *Targets:*\n' +
    '├ T1: ' + fmtPrice(t1) + ' *(+50%)*\n' +
    '└ T2: ' + fmtPrice(t2) + ' *(+100%)*\n' +
    '🛑 *Stop Loss:* ' + fmtPrice(sl) + ' *(-20%)*\n\n' +
    '📊 *Price Action:*\n' +
    '├ 5m: ' + fmtPct(p.priceChange?.m5) + '\n' +
    '├ 1h: ' + fmtPct(p.priceChange?.h1) + '\n' +
    '└ 24h: ' + fmtPct(p.priceChange?.h24) + '\n\n' +
    '📈 *Vol 24h:* ' + fmt(p.volume?.h24) + '\n' +
    '🛒 *Buys:* ' + buys + ' | 🔴 *Sells:* ' + sells + '\n\n' +
    '🛡️ *Rug Score:* ' + rs + ' — ' + rugEmoji(rs) + '\n' +
    '🔗 *Socials:* ' + socials + '\n\n' +
    '📋 CA: `' + ca + '`\n' +
    '[Chart](https://dexscreener.com/solana/' + ca + ') | [Trade](https://t.me/YakubuWeb3Bot?start=' + ca + ')\n' +
    '━━━━━━━━━━━━━━━━━━━\n' +
    '_DYOR — Not financial advice_\n' +
    '_Signal by @YakubuWeb3_'
  );
}

async function sendSignalForReview(ca, p, rug, analysis, isAuto) {
  try {
    const entry = parseFloat(p.priceUsd) || 0;
    const t1 = entry * 1.5;
    const t2 = entry * 2;
    const sl = entry * 0.8;
    const ageH = p.pairCreatedAt ? ((Date.now() - p.pairCreatedAt) / 3600000).toFixed(1) : 'N/A';
    const signalText = fmtSignalPost(p, ca, rug, entry, t1, t2, sl);
    const analysisText = fmtAnalysis(analysis);
    savePendingSignal(ca, { p, signalText, entry, t1, t2, sl });

    await bot.sendMessage(ADMIN_ID,
      (isAuto ? '🔔' : '👁️') + ' *SIGNAL PREVIEW* — ' + (isAuto ? '🤖 AUTO' : '👤 MANUAL') + '\n' +
      '📊 Today: ' + getTodaySignalCount() + '/' + MAX_SIGNALS_PER_DAY + '\n' +
      '⏰ Age: ' + ageH + 'h | ' + analysis.emoji + ' Score: ' + analysis.final + '/100\n\n' +
      signalText + analysisText,
      {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[
          { text: '✅ APPROVE', callback_data: 'approve_' + ca },
          { text: '❌ REJECT', callback_data: 'reject_' + ca }
        ]]}
      }
    );
  } catch(e) {
    console.error('sendSignalForReview error:', e.message);
    if (!isAuto) bot.sendMessage(ADMIN_ID, '❌ Error: ' + e.message);
  }
}

async function postToChannel(ca, msgId) {
  const pending = getPendingSignal(ca);
  if (!pending) return bot.sendMessage(ADMIN_ID, '⚠️ Signal expired! Use /signal <CA> to re-analyze.');
  if (getTodaySignalCount() >= MAX_SIGNALS_PER_DAY) return bot.sendMessage(ADMIN_ID, '❌ Max signals today!');
  try {
    await bot.sendMessage(CHANNEL_ID, pending.signal_text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[
        { text: 'Chart', url: 'https://dexscreener.com/solana/' + ca },
        { text: 'Analyze', url: 'https://t.me/YakubuWeb3Bot?start=' + ca }
      ]]}
    });
    recordSignalSent(ca);
    saveSnapshot(CHANNEL_ID, ca, pending.entry_price, pending.token_fdv, pending.token_name, pending.token_symbol);
    openPaperTrade(ca, pending.token_name, pending.token_symbol, pending.entry_price, pending.token_fdv, pending.target1, pending.target2, pending.stop_loss);
    deletePendingSignal(ca);
    const cnt = getTodaySignalCount();
    await bot.editMessageText('✅ Posted! (' + cnt + '/' + MAX_SIGNALS_PER_DAY + ' today)\n\n' + pending.signal_text, {
      chat_id: ADMIN_ID, message_id: msgId, parse_mode: 'Markdown', disable_web_page_preview: true
    });
  } catch(e) {
    bot.sendMessage(ADMIN_ID, '❌ Failed to post! Is bot admin in channel?');
    console.error(e);
  }
}

// ═══════════════════════════════════════════════
//  TRADE MONITORING
// ═══════════════════════════════════════════════
async function checkOpenTrades() {
  const trades = getOpenTrades();
  if (!trades.length) return;
  for (const trade of trades) {
    try {
      const p = await getTokenData(trade.ca);
      if (!p) continue;
      const cur = parseFloat(p.priceUsd) || 0;
      if (!cur) continue;
      const pnlPct = ((cur - trade.entry_price) / trade.entry_price) * 100;
      const pnlSol = (pnlPct / 100) * trade.sol_amount;
      const toT1 = ((trade.target1 - cur) / trade.target1 * 100).toFixed(1);
      const toT2 = ((trade.target2 - cur) / trade.target2 * 100).toFixed(1);

      // SL Hit
      if (cur <= trade.stop_loss) {
        closePaperTrade(trade.id, 'SL', pnlPct, pnlSol);
        await bot.sendMessage(CHANNEL_ID,
          '🔴 *STOP LOSS HIT*\n━━━━━━━━━━━━━━━━━━━\n' +
          '🪙 *' + trade.name + '* (' + trade.symbol + ')\n\n' +
          '📥 Entry: ' + fmtPrice(trade.entry_price) + '\n' +
          '📤 Exit: ' + fmtPrice(cur) + '\n' +
          '📉 PNL: ' + pnlPct.toFixed(1) + '% (' + pnlSol.toFixed(3) + ' SOL)\n\n' +
          '_Signal by @YakubuWeb3_', { parse_mode: 'Markdown' });
        continue;
      }

      // T2 Hit
      if (cur >= trade.target2) {
        closePaperTrade(trade.id, 'T2', pnlPct, pnlSol);
        await bot.sendMessage(CHANNEL_ID,
          '🏆 *TARGET 2 HIT! +100%* 🏆\n━━━━━━━━━━━━━━━━━━━\n' +
          '🪙 *' + trade.name + '* (' + trade.symbol + ')\n\n' +
          '📥 Entry: ' + fmtPrice(trade.entry_price) + '\n' +
          '📤 Exit: ' + fmtPrice(cur) + '\n' +
          '✅ PNL: +' + pnlPct.toFixed(1) + '% (+' + pnlSol.toFixed(3) + ' SOL)\n' +
          '📊 ' + (cur/trade.entry_price).toFixed(2) + 'x\n\n' +
          '_Signal by @YakubuWeb3_', { parse_mode: 'Markdown' });
        continue;
      }

      // T1 Hit
      if (cur >= trade.target1 && trade.result !== 'T1_partial') {
        db.prepare('UPDATE paper_trades SET result = ? WHERE id = ?').run('T1_partial', trade.id);
        await bot.sendMessage(CHANNEL_ID,
          '🎯 *TARGET 1 HIT! +50%*\n━━━━━━━━━━━━━━━━━━━\n' +
          '🪙 *' + trade.name + '* (' + trade.symbol + ')\n\n' +
          '📥 Entry: ' + fmtPrice(trade.entry_price) + '\n' +
          '📍 Now: ' + fmtPrice(cur) + '\n' +
          '✅ PNL: +' + pnlPct.toFixed(1) + '% (+' + pnlSol.toFixed(3) + ' SOL)\n\n' +
          '👀 Watching T2 (+100%)...\n' +
          '🛑 SL: ' + fmtPrice(trade.stop_loss) + '\n\n' +
          '_Signal by @YakubuWeb3_', { parse_mode: 'Markdown' });
        continue;
      }

      // SL Warning -15%
      if (pnlPct <= -15 && !['sl_warning','T1_partial'].includes(trade.result)) {
        db.prepare('UPDATE paper_trades SET result = ? WHERE id = ?').run('sl_warning', trade.id);
        await bot.sendMessage(CHANNEL_ID,
          '⚠️ *STOP LOSS WARNING*\n━━━━━━━━━━━━━━━━━━━\n' +
          '🪙 *' + trade.name + '* (' + trade.symbol + ')\n\n' +
          '📍 Now: ' + fmtPrice(cur) + '\n' +
          '📉 PNL: ' + pnlPct.toFixed(1) + '% (' + pnlSol.toFixed(3) + ' SOL)\n' +
          '🛑 SL approaching: ' + fmtPrice(trade.stop_loss) + '\n\n' +
          '_Signal by @YakubuWeb3_', { parse_mode: 'Markdown' });
        continue;
      }

      // Progress +30%
      if (pnlPct >= 30 && !['T1_partial','progress_30'].includes(trade.result)) {
        db.prepare('UPDATE paper_trades SET result = ? WHERE id = ?').run('progress_30', trade.id);
        await bot.sendMessage(CHANNEL_ID,
          '📈 *UPDATE — ' + trade.name + ' (' + trade.symbol + ')*\n━━━━━━━━━━━━━━━━━━━\n\n' +
          '✅ Up +' + pnlPct.toFixed(1) + '% (+' + pnlSol.toFixed(3) + ' SOL)\n\n' +
          '🎯 T1 (+50%): ' + toT1 + '% away\n' +
          '🏆 T2 (+100%): ' + toT2 + '% away\n\n' +
          '_Signal by @YakubuWeb3_', { parse_mode: 'Markdown' });
        continue;
      }

      // Progress +20%
      if (pnlPct >= 20 && !['T1_partial','progress_30','progress_20'].includes(trade.result)) {
        db.prepare('UPDATE paper_trades SET result = ? WHERE id = ?').run('progress_20', trade.id);
        await bot.sendMessage(CHANNEL_ID,
          '📈 *UPDATE — ' + trade.name + ' (' + trade.symbol + ')*\n━━━━━━━━━━━━━━━━━━━\n\n' +
          '✅ Up +' + pnlPct.toFixed(1) + '% (+' + pnlSol.toFixed(3) + ' SOL)\n\n' +
          '🎯 T1 (+50%): ' + toT1 + '% away\n' +
          '🏆 T2 (+100%): ' + toT2 + '% away\n\n' +
          '_Signal by @YakubuWeb3_', { parse_mode: 'Markdown' });
        continue;
      }

      await new Promise(r => setTimeout(r, 800));
    } catch(e) { console.error('Trade check error:', e.message); }
  }
}

// ═══════════════════════════════════════════════
//  TOKEN ANALYSIS (for users)
// ═══════════════════════════════════════════════
async function sendAnalysis(chatId, ca, username) {
  const load = await bot.sendMessage(chatId, '🔍 Analyzing token...');
  try {
    const p = await getTokenData(ca);
    if (!p) {
      await bot.deleteMessage(chatId, load.message_id);
      return bot.sendMessage(chatId, '❌ Token not found on Dexscreener!\n\nMake sure the CA is correct and the token has a DEX pair.');
    }
    const rug = await getRugcheck(ca);
    const analysis = calcTokenStrength(p, rug);
    saveSnapshot(chatId, ca, parseFloat(p.priceUsd)||0, p.fdv||0, p.baseToken.name, p.baseToken.symbol);

    const name = p.baseToken.name;
    const sym = p.baseToken.symbol;
    const mc = p.fdv || 0;
    const liq = p.liquidity?.usd || 0;
    const ageD = p.pairCreatedAt ? Math.floor((Date.now()-p.pairCreatedAt)/86400000)+'d ago' : 'N/A';
    const buys = p.txns?.h24?.buys || 0;
    const sells = p.txns?.h24?.sells || 0;
    const rs = rug?.score || 'N/A';
    let socials = '';
    if (p.info?.websites?.[0]) socials += '[Web](' + p.info.websites[0].url + ') ';
    if (p.info?.socials) p.info.socials.forEach(s => {
      if (s.type==='twitter') socials += '[X](' + s.url + ') ';
      if (s.type==='telegram') socials += '[TG](' + s.url + ') ';
    });
    if (!socials) socials = 'No socials';

    const holders = rug?.topHolders || rug?.holders || [];
    let top10str = 'N/A';
    if (holders.length) {
      const list = holders.map(h => Number(h.pct||h.percentage||h.share||0)).filter(x=>x>0&&x<60).sort((a,b)=>b-a);
      if (list.length) top10str = Math.min(list.slice(0,10).reduce((a,b)=>a+b,0),100).toFixed(1)+'%';
    }
    const devH = rug?.creator ? (rug?.topHolders||[]).find(h=>h.address===rug.creator) : null;
    const devInfo = devH ? (devH.pct||0).toFixed(1)+'%' : (rug?.creator ? '0%' : 'N/A');
    const bundleInfo = rug?.insiderNetworks?.length
      ? rug.insiderNetworks.length + ' bundles (' + rug.insiderNetworks.reduce((a,b)=>a+(b.holdingPercent||0),0).toFixed(1) + '% bought)'
      : 'None';

    const text =
      '🔍 *' + name + '* (' + sym + ')\n' +
      '⏰ ' + ageD + ' | 🏦 ' + (p.dexId||'N/A') + '\n\n' +
      '💰 *Price:* ' + fmtPrice(p.priceUsd) + '\n' +
      '💊 *MC:* ' + fmt(mc) + ' | 💧 *Liq:* ' + fmt(liq) + '\n\n' +
      '📈 *Volume:*\n' +
      '├ 24h: ' + fmt(p.volume?.h24) + '\n' +
      '├ 6h: ' + fmt(p.volume?.h6) + '\n' +
      '└ 1h: ' + fmt(p.volume?.h1) + '\n\n' +
      '📉 *Change:*\n' +
      '├ 24h: ' + fmtPct(p.priceChange?.h24) + '\n' +
      '├ 6h: ' + fmtPct(p.priceChange?.h6) + '\n' +
      '└ 1h: ' + fmtPct(p.priceChange?.h1) + '\n\n' +
      '🛒 *Buys:* ' + buys + ' | 🔴 *Sells:* ' + sells + '\n' +
      '🔗 *Socials:* ' + socials + '\n\n' +
      '👥 *Top 10 holders:* ' + top10str + '\n' +
      '🔧 *Dev:* ' + devInfo + '\n' +
      '📦 *Bundles:* ' + bundleInfo + '\n\n' +
      '🛡️ *Rug Score:* ' + rs + ' — ' + rugEmoji(rs) + '\n\n' +
      analysis.emoji + ' *Strength: ' + analysis.final + '/100 — ' + analysis.grade + '*\n\n' +
      '📋 `' + ca + '`\n_/pnl ' + ca + '_';

    await bot.deleteMessage(chatId, load.message_id);
    const isAdmin = String(chatId) === String(ADMIN_ID);
    const kb = isAdmin
      ? [[{text:'Refresh',callback_data:'refresh_'+ca},{text:'Delete',callback_data:'delete'},{text:'Chart',url:'https://dexscreener.com/solana/'+ca}],[{text:'PNL Card',callback_data:'pnl_'+ca},{text:'Send as Signal',callback_data:'signal_'+ca}]]
      : [[{text:'Refresh',callback_data:'refresh_'+ca},{text:'Delete',callback_data:'delete'},{text:'Chart',url:'https://dexscreener.com/solana/'+ca}],[{text:'PNL Card',callback_data:'pnl_'+ca}]];
    await bot.sendMessage(chatId, text, { parse_mode:'Markdown', disable_web_page_preview:true, reply_markup:{inline_keyboard:kb} });
  } catch(e) {
    try { await bot.deleteMessage(chatId, load.message_id); } catch(_) {}
    bot.sendMessage(chatId, '❌ Error analyzing token. Try again.');
    console.error('sendAnalysis error:', e.message);
  }
}

// ═══════════════════════════════════════════════
//  PNL CARD
// ═══════════════════════════════════════════════
async function sendPnl(chatId, ca, username) {
  const snap = getSnapshot(chatId, ca);
  if (!snap) return bot.sendMessage(chatId, '❌ No entry found! Send the CA first to record entry.');
  const load = await bot.sendMessage(chatId, '🎨 Generating PNL card...');
  try {
    const p = await getTokenData(ca);
    if (!p) { await bot.deleteMessage(chatId, load.message_id); return bot.sendMessage(chatId, '❌ Token not found!'); }
    const cur = parseFloat(p.priceUsd) || 0;
    const curMc = p.fdv || 0;
    const pnlPct = ((cur - snap.price) / snap.price) * 100;
    const mult = cur / snap.price;
    const isProfit = pnlPct >= 0;

    const W = 800, H = 450;
    const img = new Jimp(W, H, isProfit ? 0x0a2a1aff : 0x2a0a0aff);
    const bc = isProfit ? 0x00ff88ff : 0xff4444ff;
    for (let x=0;x<W;x++){for(let t=0;t<4;t++){img.setPixelColor(bc,x,t);img.setPixelColor(bc,x,H-1-t);}}
    for (let y=0;y<H;y++){for(let t=0;t<4;t++){img.setPixelColor(bc,t,y);img.setPixelColor(bc,W-1-t,y);}}
    const f64 = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
    const f32 = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
    const f16 = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
    img.print(f32, 40, 35, snap.name + ' (' + snap.symbol + ')');
    img.print(f64, 40, 90, (isProfit?'+':'') + pnlPct.toFixed(1) + '%');
    img.print(f32, 40, 175, mult.toFixed(2) + 'x');
    img.print(f16, 40, 240, 'Entry MC:   ' + fmt(snap.mc));
    img.print(f16, 40, 265, 'Current MC: ' + fmt(curMc));
    img.print(f16, 40, 295, 'Entry:   ' + fmtPrice(snap.price));
    img.print(f16, 40, 320, 'Current: ' + fmtPrice(cur));
    const ago = Math.floor((Date.now()-snap.timestamp)/60000);
    img.print(f16, 40, 360, 'Tracked: ' + (ago<60?ago+'m':Math.floor(ago/60)+'h'+ago%60+'m') + ' ago');
    img.print(f16, 40, 390, '@' + (username||'Anonymous'));
    img.print(f16, W-220, H-25, '@YakubuWeb3Bot');
    const fp = '/tmp/pnl_' + Date.now() + '.png';
    await img.writeAsync(fp);
    await bot.deleteMessage(chatId, load.message_id);
    await bot.sendPhoto(chatId, fp, {
      caption: 'PNL — ' + snap.name + ' (' + snap.symbol + ')\n\n' +
        'Entry MC: ' + fmt(snap.mc) + '\nCurrent MC: ' + fmt(curMc) + '\n' +
        (isProfit?'🟢':'🔴') + ' PNL: ' + (isProfit?'+':'') + pnlPct.toFixed(1) + '%\n' +
        'Multiplier: ' + mult.toFixed(2) + 'x\n\nPowered by @YakubuWeb3Bot',
      parse_mode: 'Markdown'
    });
    fs.unlinkSync(fp);
  } catch(e) {
    try { await bot.deleteMessage(chatId, load.message_id); } catch(_) {}
    bot.sendMessage(chatId, '❌ Error generating PNL!');
    console.error('sendPnl error:', e.message);
  }
}

// ═══════════════════════════════════════════════
//  WEEKLY REPORT
// ═══════════════════════════════════════════════
async function sendWeeklyReport() {
  const s = getWeeklyStats();
  if (!s) return;
  await bot.sendMessage(CHANNEL_ID,
    '*📊 WEEKLY SIGNAL REPORT*\n━━━━━━━━━━━━━━━━━━━\n\n' +
    'Last 7 days:\n' +
    '📈 Total Signals: ' + s.total + '\n' +
    '✅ Wins: ' + s.wins + '/' + s.total + '\n' +
    '🎯 Win Rate: ' + s.winRate + '%\n' +
    '💰 Total PNL: ' + (parseFloat(s.totalPnl)>0?'+':'') + s.totalPnl + ' SOL\n' +
    (s.best ? '🏆 Best Trade: ' + s.best.symbol + ' +' + (s.best.pnl_pct||0).toFixed(1) + '%\n' : '') +
    '\n_Signal by @YakubuWeb3_',
    { parse_mode: 'Markdown' }
  );
}
function scheduleWeeklyReport() {
  setInterval(() => {
    const n = new Date();
    if (n.getDay()===0 && n.getHours()===8 && n.getMinutes()<20) sendWeeklyReport();
  }, 20*60*1000);
}

// ═══════════════════════════════════════════════
//  BOT COMMANDS
// ═══════════════════════════════════════════════
bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id,
    '🚀 *YakubuWeb3 Signal Bot*\n\n' +
    'Send any *Solana CA* to analyze!\n\n' +
    '📡 Auto-scans every 20 mins\n' +
    '🎯 Up to 5 signals per day\n\n' +
    '/pnl <CA> — PNL Card\n' +
    '/price <symbol> — Price Check\n' +
    '/status — Bot Status\n' +
    '/help — All Commands\n\n' +
    '_Powered by @YakubuWeb3_',
    { parse_mode:'Markdown', reply_markup:{inline_keyboard:[[{text:'Analyze Token',callback_data:'prompt_analyze'},{text:'Price Check',callback_data:'prompt_price'}]]}}
  );
});

bot.onText(/\/help/, msg => {
  const isAdmin = String(msg.chat.id) === String(ADMIN_ID);
  bot.sendMessage(msg.chat.id,
    '📋 *Commands:*\n\n' +
    'Send CA → Analyze token\n' +
    '/pnl <CA> — PNL Card\n' +
    '/price <symbol> — Price\n' +
    '/status — Bot status\n' +
    (isAdmin ? '\n👑 *Admin:*\n/scan — Manual scan\n/signal <CA> — Manual signal\n/pending — Pending signals\n/stats — Stats\n/report — Weekly report' : ''),
    { parse_mode:'Markdown' }
  );
});

bot.onText(/\/status/, msg => {
  const cnt = getTodaySignalCount();
  const trades = getOpenTrades();
  bot.sendMessage(msg.chat.id,
    '📊 *Bot Status*\n\n' +
    '✅ Running\n' +
    '📡 Signals today: ' + cnt + '/' + MAX_SIGNALS_PER_DAY + '\n' +
    '📈 Open trades: ' + trades.length + '\n' +
    '⏱️ Scan: every 20 mins',
    { parse_mode:'Markdown' }
  );
});

bot.onText(/\/stats/, msg => {
  if (String(msg.chat.id) !== String(ADMIN_ID)) return;
  bot.sendMessage(ADMIN_ID,
    '📊 *Stats*\n\n' +
    'Today: ' + getTodaySignalCount() + '/' + MAX_SIGNALS_PER_DAY + '\n' +
    'Pending: ' + Object.keys(pendingSignals).length + '\n' +
    'Open trades: ' + getOpenTrades().length,
    { parse_mode:'Markdown' }
  );
});

bot.onText(/\/scan/, async msg => {
  if (String(msg.chat.id) !== String(ADMIN_ID)) return;
  await runScan(true);
});

bot.onText(/\/signal (.+)/, async (msg, match) => {
  if (String(msg.chat.id) !== String(ADMIN_ID)) return bot.sendMessage(msg.chat.id, '❌ Admin only!');
  const ca = match[1].trim();
  const load = await bot.sendMessage(ADMIN_ID, '🔍 Fetching token...');
  const p = await getTokenData(ca);
  if (!p) { await bot.deleteMessage(ADMIN_ID, load.message_id); return bot.sendMessage(ADMIN_ID, '❌ Token not found!'); }
  const rug = await getRugcheck(ca);
  const analysis = calcTokenStrength(p, rug);
  await bot.deleteMessage(ADMIN_ID, load.message_id);
  await sendSignalForReview(ca, p, rug, analysis, false);
});

bot.onText(/\/pending/, msg => {
  if (String(msg.chat.id) !== String(ADMIN_ID)) return;
  try {
    const rows = db.prepare('SELECT ca, token_name, token_symbol, saved_at FROM pending_signals ORDER BY saved_at DESC').all();
    if (!rows.length) return bot.sendMessage(ADMIN_ID, '📋 No pending signals.');
    const list = rows.map((r,i) => {
      const minsAgo = Math.floor((Date.now() - r.saved_at) / 60000);
      return (i+1) + '. *' + r.token_name + '* (' + r.token_symbol + ') — ' + minsAgo + 'm ago\n`' + r.ca + '`';
    }).join('\n\n');
    bot.sendMessage(ADMIN_ID, '📋 *Pending (' + rows.length + '):*\n\n' + list, { parse_mode:'Markdown' });
  } catch(e) { bot.sendMessage(ADMIN_ID, '❌ Error fetching pending signals.'); }
});

bot.onText(/\/report/, async msg => {
  if (String(msg.chat.id) !== String(ADMIN_ID)) return;
  await sendWeeklyReport();
});

bot.onText(/\/pnl (.+)/, async (msg, match) => {
  await sendPnl(msg.chat.id, match[1].trim(), msg.from?.username);
});

bot.onText(/\/price (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const sym = match[1].trim().toLowerCase();
  const load = await bot.sendMessage(chatId, '⏳ Fetching price...');
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids='+sym+'&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true');
    const d = res.data[sym];
    if (!d) { await bot.deleteMessage(chatId, load.message_id); return bot.sendMessage(chatId, '❌ Coin not found!'); }
    await bot.deleteMessage(chatId, load.message_id);
    bot.sendMessage(chatId,
      '💰 *' + sym.toUpperCase() + '*\n\n' +
      'Price: ' + fmtPrice(d.usd) + '\n' +
      'MC: ' + fmt(d.usd_market_cap) + '\n' +
      'Vol 24h: ' + fmt(d.usd_24h_vol) + '\n' +
      fmtPct(d.usd_24h_change) + ' (24h)\n\n' +
      '_Powered by @YakubuWeb3_',
      { parse_mode:'Markdown' }
    );
  } catch(e) {
    await bot.deleteMessage(chatId, load.message_id);
    bot.sendMessage(chatId, '❌ Error fetching price!');
  }
});

// Any message — if CA, analyze
bot.on('message', async msg => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const ca = msg.text.trim();
  if (/^[A-Za-z0-9]{32,50}$/.test(ca)) {
    await sendAnalysis(msg.chat.id, ca, msg.from?.username);
  }
});

// ═══════════════════════════════════════════════
//  CALLBACKS
// ═══════════════════════════════════════════════
bot.on('callback_query', async query => {
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const data = query.data;
  const username = query.from?.username;

  if (data.startsWith('approve_')) {
    if (String(chatId) !== String(ADMIN_ID)) return bot.answerCallbackQuery(query.id, {text:'Admin only!'});
    await bot.answerCallbackQuery(query.id, {text:'Posting...'});
    await postToChannel(data.replace('approve_',''), msgId);
    return;
  }
  if (data.startsWith('reject_')) {
    if (String(chatId) !== String(ADMIN_ID)) return bot.answerCallbackQuery(query.id, {text:'Admin only!'});
    const ca = data.replace('reject_','');
    delete pendingSignals[ca];
    await bot.answerCallbackQuery(query.id, {text:'Rejected!'});
    await bot.editMessageText('❌ Signal rejected.\nCA: `'+ca+'`', {chat_id:ADMIN_ID, message_id:msgId, parse_mode:'Markdown'});
    return;
  }
  if (data.startsWith('signal_')) {
    if (String(chatId) !== String(ADMIN_ID)) return bot.answerCallbackQuery(query.id, {text:'Admin only!'});
    await bot.answerCallbackQuery(query.id, {text:'Preparing...'});
    const ca = data.replace('signal_','');
    const p = await getTokenData(ca);
    if (!p) return bot.sendMessage(ADMIN_ID, '❌ Token not found!');
    const rug = await getRugcheck(ca);
    const analysis = calcTokenStrength(p, rug);
    await sendSignalForReview(ca, p, rug, analysis, false);
    return;
  }
  if (data.startsWith('refresh_')) {
    const ca = data.replace('refresh_','');
    await bot.answerCallbackQuery(query.id, {text:'Refreshing...'});
    await sendAnalysis(chatId, ca, username);
    try { await bot.deleteMessage(chatId, msgId); } catch(_) {}
    return;
  }
  if (data.startsWith('pnl_')) {
    await bot.answerCallbackQuery(query.id, {text:'Generating...'});
    await sendPnl(chatId, data.replace('pnl_',''), username);
    return;
  }
  if (data === 'delete') {
    await bot.deleteMessage(chatId, msgId);
    await bot.answerCallbackQuery(query.id, {text:'Deleted!'});
    return;
  }
  if (data === 'prompt_analyze') { await bot.answerCallbackQuery(query.id); bot.sendMessage(chatId, 'Send any Solana CA directly!'); return; }
  if (data === 'prompt_price') { await bot.answerCallbackQuery(query.id); bot.sendMessage(chatId, 'Use: /price solana'); return; }
});

// ═══════════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════════
console.log('=============================');
console.log('  YakubuWeb3Bot — STARTED');
console.log('  Road Map 1 + 2 Active');
console.log('  Scan every 20 mins');
console.log('  Score threshold:', SCORE_PASS_MIN);
console.log('=============================');

// Clean old pending signals on startup
cleanOldPending();

// First scan after 2 mins
setTimeout(() => {
  console.log('Starting first scan...');
  runScan(false);
}, 2 * 60 * 1000);

// Auto scan every 20 mins
setInterval(() => runScan(false), SCAN_INTERVAL_MS);

// Check open trades every 10 mins
setInterval(checkOpenTrades, 10 * 60 * 1000);

// Weekly report
scheduleWeeklyReport();
