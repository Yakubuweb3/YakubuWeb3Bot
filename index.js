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
const SCAN_INTERVAL_MS    = 15 * 60 * 1000; // every 15 mins

// ── Token Filters — Early Smart Money Strategy ──
const MIN_AGE_HOURS  = 2;      // Token dole ya kasance 2hrs+
const MAX_AGE_HOURS  = 6;      // Kafin ya tsufa (degens don sun shigo)
const MIN_MC         = 20000;  // $20K min
const MAX_MC         = 100000; // $100K max
const MIN_LIQUIDITY  = 5000;   // $5K liquidity min
const MIN_VOLUME_1H  = 1000;   // $1K volume a 1h (yana da activity)
const MAX_RUG_SCORE  = 700;
const SCORE_PASS_MIN = 40;

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
    const cutoff = Date.now() - 12 * 60 * 60 * 1000;
    db.prepare('DELETE FROM pending_signals WHERE saved_at < ?').run(cutoff);
  } catch(e) {}
}

function clearScannedTokens() {
  try {
    db.prepare('DELETE FROM scanned_tokens').run();
    console.log('Cleared scanned_tokens cache');
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
  return (Date.now() - row.last_scanned) < 30 * 60 * 1000;
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
    const wins = trades.filter(t => ['T1','T2','T1_partial'].includes(t.result)).length;
    const totalPnl = trades.reduce((a,b) => a + (b.pnl_sol||0), 0);
    const best = [...trades].sort((a,b) => (b.pnl_pct||0) - (a.pnl_pct||0))[0];
    return { total: trades.length, wins, winRate: ((wins/trades.length)*100).toFixed(0), totalPnl: totalPnl.toFixed(3), best };
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
  return (c >= 0 ? '🟢 +' : '🔴 ') + parseFloat(c).toFixed(2) + '%';
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
    sol.sort((a,b) => (b.liquidity?.usd||0) - (a.liquidity?.usd||0));
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
//  FETCH CANDIDATES — 5 Sources
// ═══════════════════════════════════════════════
async function fetchCandidateTokens() {
  const results = [];

  // Source 1: Dexscreener boosted
  try {
    const res = await axios.get('https://api.dexscreener.com/token-boosts/top/v1', { timeout: 10000 });
    (res.data||[]).filter(t => t.chainId==='solana').forEach(t => { if(t.tokenAddress) results.push(t.tokenAddress); });
    console.log('S1 boosts:', results.length);
  } catch(e) { console.log('S1 failed'); }

  // Source 2: Dexscreener profiles
  try {
    const res = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 10000 });
    (res.data||[]).filter(t => t.chainId==='solana').forEach(t => { if(t.tokenAddress) results.push(t.tokenAddress); });
    console.log('S2 profiles:', results.length);
  } catch(e) { console.log('S2 failed'); }

  // Source 3: Pump.fun latest trades
  try {
    const res = await axios.get('https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=false', { timeout: 10000 });
    (res.data||[]).forEach(t => { if(t.mint) results.push(t.mint); });
    console.log('S3 pump latest:', results.length);
  } catch(e) { console.log('S3 failed'); }

  // Source 4: Pump.fun top MC (graduated)
  try {
    const res = await axios.get('https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=market_cap&order=DESC&includeNsfw=false', { timeout: 10000 });
    (res.data||[]).forEach(t => { if(t.mint) results.push(t.mint); });
    console.log('S4 pump mc:', results.length);
  } catch(e) { console.log('S4 failed'); }

  // Source 5: Dexscreener search solana
  try {
    const res = await axios.get('https://api.dexscreener.com/latest/dex/search?q=solana', { timeout: 10000 });
    (res.data?.pairs||[]).filter(p => p.chainId==='solana').forEach(p => { if(p.baseToken?.address) results.push(p.baseToken.address); });
    console.log('S5 dex search:', results.length);
  } catch(e) { console.log('S5 failed'); }

  const unique = [...new Set(results)];
  console.log('Total candidates:', unique.length);
  return unique;
}

// ═══════════════════════════════════════════════
//  DEX ANALYSIS ENGINE — Early Smart Money
// ═══════════════════════════════════════════════

// 1. Volume Momentum
function scoreVolumeMomentum(p) {
  let score = 0;
  const notes = [];
  const v1h  = parseFloat(p.volume?.h1  || 0);
  const v6h  = parseFloat(p.volume?.h6  || 0);
  const v24h = parseFloat(p.volume?.h24 || 0);
  const ch5m = parseFloat(p.priceChange?.m5  || 0);
  const ch1h = parseFloat(p.priceChange?.h1  || 0);
  const buys1h  = p.txns?.h1?.buys  || 0;
  const sells1h = p.txns?.h1?.sells || 0;
  const buys24  = p.txns?.h24?.buys  || 0;
  const sells24 = p.txns?.h24?.sells || 0;

  // Volume acceleration in 1h vs 6h
  if (v6h > 0) {
    const share = (v1h / v6h) * 100;
    if (share > 50)      { score += 25; notes.push('🔥 Huge volume spike 1h (' + share.toFixed(0) + '% of 6h)'); }
    else if (share > 30) { score += 15; notes.push('📈 Strong volume 1h (' + share.toFixed(0) + '% of 6h)'); }
    else if (share > 15) { score += 7;  notes.push('📊 Moderate volume'); }
    else                  { score -= 5;  notes.push('⚠️ Volume slowing down'); }
  }

  // Buy pressure 1h
  if (buys1h + sells1h > 0) {
    const buyPct = (buys1h / (buys1h + sells1h)) * 100;
    if (buyPct > 70)      { score += 20; notes.push('🟢 Very strong buys ' + buyPct.toFixed(0) + '% (1h)'); }
    else if (buyPct > 55) { score += 10; notes.push('🟡 Good buy pressure ' + buyPct.toFixed(0) + '% (1h)'); }
    else if (buyPct < 40) { score -= 15; notes.push('🔴 Heavy selling ' + (100-buyPct).toFixed(0) + '% sells'); }
  }

  // Buy pressure 24h
  if (buys24 + sells24 > 0) {
    const bp24 = (buys24 / (buys24 + sells24)) * 100;
    if (bp24 > 60) { score += 10; notes.push('✅ Healthy 24h ratio ' + bp24.toFixed(0) + '%'); }
    else if (bp24 < 40) { score -= 10; notes.push('⚠️ More sells 24h'); }
  }

  // Price momentum
  if (ch5m > 5 && ch1h > 10)   { score += 15; notes.push('🚀 Strong price momentum'); }
  else if (ch5m > 2 && ch1h > 5){ score += 8;  notes.push('📈 Good momentum'); }
  if (ch5m < -10 && ch1h < -10) { score -= 20; notes.push('📉 Dumping hard'); }

  return { score: Math.max(0, Math.min(score, 100)), notes };
}

// 2. Whale Detection
function scoreWhaleDetection(p, rug) {
  let score = 0;
  const notes = [];
  const whales = [];
  if (!rug) return { score: 10, notes: ['⚪ No rug data'], whales };

  const holders = rug?.topHolders || rug?.holders || [];
  if (holders.length > 0) {
    const list = holders
      .map(h => ({ addr: h.address||'', pct: Number(h.pct||h.percentage||h.share||0) }))
      .filter(h => h.addr && h.pct > 0 && h.pct < 60)
      .sort((a,b) => b.pct - a.pct);

    const top1  = list[0]?.pct || 0;
    const top10 = list.slice(0,10).reduce((a,b) => a+b.pct, 0);

    if (top1 > 15)     { score -= 25; notes.push('🐋 DANGER: Top holder ' + top1.toFixed(1) + '% — dump risk!'); }
    else if (top1 > 8) { score -= 10; notes.push('⚠️ Top holder ' + top1.toFixed(1) + '%'); }
    else if (top1 < 4) { score += 15; notes.push('✅ Distributed — top holder only ' + top1.toFixed(1) + '%'); }
    else               { score += 5;  notes.push('🟡 Top holder ' + top1.toFixed(1) + '%'); }

    if (top10 < 15)     { score += 20; notes.push('✅ Excellent distribution top10=' + top10.toFixed(1) + '%'); }
    else if (top10 < 25){ score += 10; notes.push('🟡 Good distribution top10=' + top10.toFixed(1) + '%'); }
    else if (top10 > 40){ score -= 15; notes.push('🔴 Concentrated top10=' + top10.toFixed(1) + '%'); }

    list.slice(0,3).forEach((h,i) => {
      if (h.pct > 1) whales.push({ rank: i+1, addr: h.addr.slice(0,6)+'...'+h.addr.slice(-4), pct: h.pct.toFixed(2) });
    });
  } else {
    score += 5; notes.push('⚪ No holder data available');
  }

  // Bundles
  if (rug.insiderNetworks?.length > 0) {
    const bPct = rug.insiderNetworks.reduce((a,b) => a+(b.holdingPercent||0), 0);
    const nPct = rug.insiderNetworks.reduce((a,b) => a+(b.currentHoldingPercent||0), 0);
    if (bPct > 20)     { score -= 25; notes.push('🔴 Bundles bought ' + bPct.toFixed(1) + '% still hold ' + nPct.toFixed(1) + '%'); }
    else if (bPct > 10){ score -= 10; notes.push('⚠️ Some bundles ' + bPct.toFixed(1) + '%'); }
    else               { score += 10; notes.push('✅ No significant bundles'); }
  } else {
    score += 10; notes.push('✅ No bundles detected');
  }

  // Snipers
  if (rug.snipers?.length > 0) {
    const sPct = rug.snipers.reduce((a,b) => a+(b.holdingPercent||0), 0);
    if (sPct > 10) { score -= 10; notes.push('🎯 Snipers holding ' + sPct.toFixed(1) + '%'); }
    else           { score += 5;  notes.push('✅ Low sniper activity'); }
  } else {
    score += 5; notes.push('✅ No snipers');
  }

  return { score: Math.max(0, Math.min(score, 100)), notes, whales };
}

// 3. Smart Money
function scoreSmartMoney(p, rug) {
  let score = 0;
  const notes = [];
  if (!rug) return { score: 10, notes: ['⚪ No rug data'] };

  const v1h  = p.volume?.h1  || 0;
  const buys = p.txns?.h1?.buys || 0;

  // Avg buy size — key indicator of smart money
  if (buys > 0 && v1h > 0) {
    const avg = v1h / buys;
    if (avg > 1000)     { score += 25; notes.push('💰 Large avg buy $' + avg.toFixed(0) + ' — smart money!'); }
    else if (avg > 500) { score += 15; notes.push('💵 Good avg buy $' + avg.toFixed(0)); }
    else if (avg > 200) { score += 7;  notes.push('🟡 Small avg buy $' + avg.toFixed(0)); }
    else                { score += 2;  notes.push('⚠️ Very small avg buy $' + avg.toFixed(0) + ' — retail/bots'); }
  }

  // Dev wallet
  if (rug.creator) {
    const devH = (rug?.topHolders||[]).find(h => h.address === rug.creator);
    const devPct = devH ? Number(devH.pct||0) : 0;
    if (devPct === 0)    { score += 20; notes.push('✅ Dev not holding — good sign'); }
    else if (devPct < 2) { score += 10; notes.push('✅ Dev minimal ' + devPct.toFixed(1) + '%'); }
    else if (devPct > 5) { score -= 20; notes.push('🔴 Dev holds ' + devPct.toFixed(1) + '% — RISK!'); }
    else                  { score += 3;  notes.push('🟡 Dev holds ' + devPct.toFixed(1) + '%'); }
  }

  // Rug score
  if (rug.score !== undefined) {
    const rs = Number(rug.score);
    if (rs < 200)      { score += 20; notes.push('🟢 Very safe rug score: ' + rs); }
    else if (rs < 400) { score += 12; notes.push('🟡 OK rug score: ' + rs); }
    else if (rs < 600) { score += 4;  notes.push('🟠 Moderate rug score: ' + rs); }
    else               { score -= 15; notes.push('🔴 High rug score: ' + rs); }
  }

  // Socials = legit project
  const hasSocials = p.info?.socials?.length > 0 || p.info?.websites?.length > 0;
  if (hasSocials) { score += 8;  notes.push('✅ Has socials/website'); }
  else            { score -= 3;  notes.push('⚠️ No socials found'); }

  // LP locked
  if (rug.markets?.length > 0) {
    const locked = rug.markets.some(m => m.lp?.lpLockedPct > 50);
    if (locked) { score += 15; notes.push('🔒 Liquidity locked!'); }
    else        { score -= 3;  notes.push('⚠️ LP not locked'); }
  }

  return { score: Math.max(0, Math.min(score, 100)), notes };
}

// 4. Master Score
function calcTokenStrength(p, rug) {
  const mom = scoreVolumeMomentum(p);
  const whl = scoreWhaleDetection(p, rug);
  const smt = scoreSmartMoney(p, rug);
  const final = Math.round((mom.score * 0.35) + (whl.score * 0.35) + (smt.score * 0.30));
  let grade, emoji;
  if (final >= 80)      { grade = 'S'; emoji = '🏆'; }
  else if (final >= 65) { grade = 'A'; emoji = '🔥'; }
  else if (final >= 50) { grade = 'B'; emoji = '✅'; }
  else if (final >= 35) { grade = 'C'; emoji = '🟡'; }
  else                   { grade = 'D'; emoji = '🔴'; }
  return { final, grade, emoji, passes: final >= SCORE_PASS_MIN, mom, whl, smt };
}

function fmtAnalysis(a) {
  let r = '\n━━━━━━━━━━━━━━━━━━━\n🧠 *DEX ANALYSIS*\n━━━━━━━━━━━━━━━━━━━\n\n';
  r += a.emoji + ' *Score: ' + a.final + '/100 — Grade ' + a.grade + '*\n\n';
  r += '📊 *Momentum* (' + a.mom.score + 'pts)\n';
  a.mom.notes.slice(0,3).forEach(n => { r += '  ' + n + '\n'; });
  r += '\n🐋 *Whales* (' + a.whl.score + 'pts)\n';
  a.whl.notes.slice(0,3).forEach(n => { r += '  ' + n + '\n'; });
  if (a.whl.whales?.length > 0) {
    a.whl.whales.forEach(w => { r += '  #' + w.rank + ' ' + w.addr + ' — ' + w.pct + '%\n'; });
  }
  r += '\n💰 *Smart Money* (' + a.smt.score + 'pts)\n';
  a.smt.notes.slice(0,3).forEach(n => { r += '  ' + n + '\n'; });
  r += '\n━━━━━━━━━━━━━━━━━━━\n';
  r += a.passes ? '✅ *PASSES — Ready for review*\n' : '❌ *FAILS — Score too low (' + a.final + '/' + SCORE_PASS_MIN + ')*\n';
  return r;
}

// ═══════════════════════════════════════════════
//  MAIN FILTER — Early Smart Money Strategy
// ═══════════════════════════════════════════════
async function analyzeForSignal(ca) {
  try {
    const p = await getTokenData(ca);
    if (!p) return null;

    // Age filter — 2 to 6 hours ONLY
    if (!p.pairCreatedAt) return null;
    const ageH = (Date.now() - p.pairCreatedAt) / 3600000;
    if (ageH < MIN_AGE_HOURS || ageH > MAX_AGE_HOURS) return null;

    // MC filter — $20K to $100K
    const mc = p.fdv || 0;
    if (mc < MIN_MC || mc > MAX_MC) return null;

    // Liquidity filter
    const liq = p.liquidity?.usd || 0;
    if (liq < MIN_LIQUIDITY) return null;

    // Must have activity in last 1h
    const v1h = p.volume?.h1 || 0;
    if (v1h < MIN_VOLUME_1H) return null;

    // Not crashing
    const ch1h = parseFloat(p.priceChange?.h1 || 0);
    if (ch1h < -25) return null;

    // Must have more buys than sells in 1h
    const buys1h  = p.txns?.h1?.buys  || 0;
    const sells1h = p.txns?.h1?.sells || 0;
    if (buys1h > 0 && sells1h > 0) {
      const buyPct = (buys1h / (buys1h + sells1h)) * 100;
      if (buyPct < 45) return null; // too many sells
    }

    // Rug check
    const rug = await getRugcheck(ca);
    if (rug?.score && rug.score > MAX_RUG_SCORE) return null;

    // Holder concentration — reject if top 10 > 35%
    if (rug) {
      const holders = rug?.topHolders || rug?.holders || [];
      if (holders.length > 0) {
        const list = holders.map(h => Number(h.pct||h.percentage||h.share||0)).filter(x => x > 0 && x < 60);
        const top10 = list.sort((a,b)=>b-a).slice(0,10).reduce((a,b)=>a+b,0);
        if (top10 > 35) return null;
      }
      if (rug.insiderNetworks?.length > 15) return null;
    }

    // DEX Analysis Score
    const analysis = calcTokenStrength(p, rug);
    if (!analysis.passes) {
      console.log('FAIL', ca.slice(0,8), 'score:', analysis.final, 'age:', ageH.toFixed(1)+'h', 'mc:', fmt(mc));
      return null;
    }

    console.log('✅ PASS', ca.slice(0,8), 'score:', analysis.final, 'grade:', analysis.grade, 'age:', ageH.toFixed(1)+'h', 'mc:', fmt(mc));
    return { p, rug, analysis };
  } catch(e) {
    console.log('analyzeForSignal error:', e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════
//  SCAN
// ═══════════════════════════════════════════════
async function runScan(manual) {
  if (isScanning) {
    if (manual) bot.sendMessage(ADMIN_ID, '⏳ Scan already running...');
    return;
  }
  if (getTodaySignalCount() >= MAX_SIGNALS_PER_DAY) {
    if (manual) bot.sendMessage(ADMIN_ID, '✅ Max signals today (' + MAX_SIGNALS_PER_DAY + '/' + MAX_SIGNALS_PER_DAY + ')');
    return;
  }
  isScanning = true;
  if (manual) bot.sendMessage(ADMIN_ID, '🔍 Scanning... fetching from 5 sources\n⏰ Filter: 2-6hrs age | MC $20K-$100K');
  console.log('=== SCAN START ===');

  try {
    const cas = await fetchCandidateTokens();
    if (manual) bot.sendMessage(ADMIN_ID, '📋 ' + cas.length + ' candidates found — analyzing...');

    let found = 0, checked = 0;
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
      await new Promise(r => setTimeout(r, 600));
    }

    console.log('=== SCAN DONE === checked:', checked, 'found:', found);
    if (manual) {
      bot.sendMessage(ADMIN_ID, found === 0
        ? '🔍 Done — checked ' + checked + ' tokens, none passed filters.\n\nFilters: Age 2-6h | MC $20K-$100K | Vol 1h $1K+ | Buys > Sells\n\nNext auto-scan in 15 mins.'
        : '✅ Done — ' + found + ' signal(s) ready for review!'
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
  const sym  = p.baseToken.symbol;
  const mc   = p.fdv || 0;
  const liq  = p.liquidity?.usd || 0;
  const ageH = p.pairCreatedAt ? ((Date.now() - p.pairCreatedAt) / 3600000).toFixed(1) : 'N/A';
  const buys  = p.txns?.h24?.buys  || 0;
  const sells = p.txns?.h24?.sells || 0;
  const rs = rug?.score || 'N/A';
  let socials = '';
  if (p.info?.websites?.[0]) socials += '[Web](' + p.info.websites[0].url + ') ';
  if (p.info?.socials) p.info.socials.forEach(s => {
    if (s.type==='twitter')  socials += '[X](' + s.url + ') ';
    if (s.type==='telegram') socials += '[TG](' + s.url + ') ';
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
    '📈 *Vol 1h:* ' + fmt(p.volume?.h1) + ' | *24h:* ' + fmt(p.volume?.h24) + '\n' +
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
          { text: '❌ REJECT',  callback_data: 'reject_'  + ca }
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
        { text: 'Chart',   url: 'https://dexscreener.com/solana/' + ca },
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
    bot.sendMessage(ADMIN_ID, '❌ Failed to post! Check bot is admin in channel.');
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
//  TOKEN ANALYSIS (users)
// ═══════════════════════════════════════════════
async function sendAnalysis(chatId, ca, username) {
  const load = await bot.sendMessage(chatId, '🔍 Analyzing token...');
  try {
    const p = await getTokenData(ca);
    if (!p) {
      await bot.deleteMessage(chatId, load.message_id);
      return bot.sendMessage(chatId, '❌ Token not found on Dexscreener!\nCheck CA and make sure token has a DEX pair.');
    }
    const rug = await getRugcheck(ca);
    const analysis = calcTokenStrength(p, rug);
    saveSnapshot(chatId, ca, parseFloat(p.priceUsd)||0, p.fdv||0, p.baseToken.name, p.baseToken.symbol);

    const mc  = p.fdv || 0;
    const liq = p.liquidity?.usd || 0;
    const ageH = p.pairCreatedAt ? ((Date.now()-p.pairCreatedAt)/3600000).toFixed(1)+'h' : 'N/A';
    const buys  = p.txns?.h24?.buys  || 0;
    const sells = p.txns?.h24?.sells || 0;
    const rs = rug?.score || 'N/A';

    let socials = '';
    if (p.info?.websites?.[0]) socials += '[Web](' + p.info.websites[0].url + ') ';
    if (p.info?.socials) p.info.socials.forEach(s => {
      if (s.type==='twitter')  socials += '[X](' + s.url + ') ';
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
    const devInfo = devH ? (devH.pct||0).toFixed(1)+'%' : (rug?.creator?'0%':'N/A');
    const bundleInfo = rug?.insiderNetworks?.length
      ? rug.insiderNetworks.length + ' bundles (' + rug.insiderNetworks.reduce((a,b)=>a+(b.holdingPercent||0),0).toFixed(1)+'% bought)'
      : 'None';

    const text =
      '🔍 *' + p.baseToken.name + '* (' + p.baseToken.symbol + ')\n' +
      '⏰ Age: ' + ageH + ' | 🏦 ' + (p.dexId||'N/A') + '\n\n' +
      '💰 *Price:* ' + fmtPrice(p.priceUsd) + '\n' +
      '💊 *MC:* ' + fmt(mc) + ' | 💧 *Liq:* ' + fmt(liq) + '\n\n' +
      '📈 *Volume:*\n' +
      '├ 1h: ' + fmt(p.volume?.h1) + '\n' +
      '├ 6h: ' + fmt(p.volume?.h6) + '\n' +
      '└ 24h: ' + fmt(p.volume?.h24) + '\n\n' +
      '📉 *Change:*\n' +
      '├ 5m: ' + fmtPct(p.priceChange?.m5) + '\n' +
      '├ 1h: ' + fmtPct(p.priceChange?.h1) + '\n' +
      '└ 24h: ' + fmtPct(p.priceChange?.h24) + '\n\n' +
      '🛒 *Buys 24h:* ' + buys + ' | 🔴 *Sells:* ' + sells + '\n' +
      '🔗 *Socials:* ' + socials + '\n\n' +
      '👥 *Top 10 holders:* ' + top10str + '\n' +
      '🔧 *Dev:* ' + devInfo + '\n' +
      '📦 *Bundles:* ' + bundleInfo + '\n\n' +
      '🛡️ *Rug Score:* ' + rs + ' — ' + rugEmoji(rs) + '\n\n' +
      analysis.emoji + ' *Strength: ' + analysis.final + '/100 — Grade ' + analysis.grade + '*\n\n' +
      '📋 `' + ca + '`\n_/pnl ' + ca + '_';

    await bot.deleteMessage(chatId, load.message_id);
    const isAdmin = String(chatId) === String(ADMIN_ID);
    const kb = isAdmin
      ? [[{text:'Refresh',callback_data:'refresh_'+ca},{text:'Delete',callback_data:'delete'},{text:'Chart',url:'https://dexscreener.com/solana/'+ca}],[{text:'PNL Card',callback_data:'pnl_'+ca},{text:'Send as Signal',callback_data:'signal_'+ca}]]
      : [[{text:'Refresh',callback_data:'refresh_'+ca},{text:'Delete',callback_data:'delete'},{text:'Chart',url:'https://dexscreener.com/solana/'+ca}],[{text:'PNL Card',callback_data:'pnl_'+ca}]];
    await bot.sendMessage(chatId, text, { parse_mode:'Markdown', disable_web_page_preview:true, reply_markup:{inline_keyboard:kb} });
  } catch(e) {
    try { await bot.deleteMessage(chatId, load.message_id); } catch(_) {}
    bot.sendMessage(chatId, '❌ Error analyzing. Try again.');
    console.error('sendAnalysis error:', e.message);
  }
}

// ═══════════════════════════════════════════════
//  PNL CARD
// ═══════════════════════════════════════════════
async function sendPnl(chatId, ca, username) {
  const snap = getSnapshot(chatId, ca);
  if (!snap) return bot.sendMessage(chatId, '❌ No entry found! Send the CA first.');
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
    for(let x=0;x<W;x++){for(let t=0;t<4;t++){img.setPixelColor(bc,x,t);img.setPixelColor(bc,x,H-1-t);}}
    for(let y=0;y<H;y++){for(let t=0;t<4;t++){img.setPixelColor(bc,t,y);img.setPixelColor(bc,W-1-t,y);}}
    const f64=await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
    const f32=await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
    const f16=await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
    img.print(f32,40,35,snap.name+' ('+snap.symbol+')');
    img.print(f64,40,90,(isProfit?'+':'')+pnlPct.toFixed(1)+'%');
    img.print(f32,40,175,mult.toFixed(2)+'x');
    img.print(f16,40,240,'Entry MC:   '+fmt(snap.mc));
    img.print(f16,40,265,'Current MC: '+fmt(curMc));
    img.print(f16,40,295,'Entry:   '+fmtPrice(snap.price));
    img.print(f16,40,320,'Current: '+fmtPrice(cur));
    const ago=Math.floor((Date.now()-snap.timestamp)/60000);
    img.print(f16,40,360,'Tracked: '+(ago<60?ago+'m':Math.floor(ago/60)+'h '+ago%60+'m')+' ago');
    img.print(f16,40,390,'@'+(username||'Anonymous'));
    img.print(f16,W-220,H-25,'@YakubuWeb3Bot');
    const fp='/tmp/pnl_'+Date.now()+'.png';
    await img.writeAsync(fp);
    await bot.deleteMessage(chatId, load.message_id);
    await bot.sendPhoto(chatId, fp, {
      caption: 'PNL — '+snap.name+' ('+snap.symbol+')\n\nEntry MC: '+fmt(snap.mc)+'\nCurrent MC: '+fmt(curMc)+'\n'+(isProfit?'🟢':'🔴')+' PNL: '+(isProfit?'+':'')+pnlPct.toFixed(1)+'%\nMultiplier: '+mult.toFixed(2)+'x\n\nPowered by @YakubuWeb3Bot',
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
  if (!s) { bot.sendMessage(ADMIN_ID, '📊 No closed trades this week yet.'); return; }
  await bot.sendMessage(CHANNEL_ID,
    '*📊 WEEKLY SIGNAL REPORT*\n━━━━━━━━━━━━━━━━━━━\n\n' +
    'Last 7 days:\n' +
    '📈 Total: ' + s.total + '\n' +
    '✅ Wins: ' + s.wins + '/' + s.total + '\n' +
    '🎯 Win Rate: ' + s.winRate + '%\n' +
    '💰 Total PNL: ' + (parseFloat(s.totalPnl)>0?'+':'') + s.totalPnl + ' SOL\n' +
    (s.best ? '🏆 Best: ' + s.best.symbol + ' +' + (s.best.pnl_pct||0).toFixed(1) + '%\n' : '') +
    '\n_Signal by @YakubuWeb3_',
    { parse_mode: 'Markdown' }
  );
}
function scheduleWeeklyReport() {
  setInterval(() => {
    const n = new Date();
    if (n.getDay()===0 && n.getHours()===8 && n.getMinutes()<15) sendWeeklyReport();
  }, 15*60*1000);
}

// ═══════════════════════════════════════════════
//  BOT COMMANDS
// ═══════════════════════════════════════════════
bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id,
    '🚀 *YakubuWeb3 Signal Bot*\n\n' +
    'Send any *Solana CA* to analyze!\n\n' +
    '📡 Auto-scans every 15 mins\n' +
    '🎯 Targets: 2-6h tokens | $20K-$100K MC\n' +
    '💡 Up to 5 signals/day\n\n' +
    '/pnl <CA> — PNL Card\n' +
    '/price <symbol> — Price\n' +
    '/status — Bot Status\n' +
    '/help — Commands\n\n' +
    '_Powered by @YakubuWeb3_',
    { parse_mode:'Markdown', reply_markup:{inline_keyboard:[[{text:'Analyze Token',callback_data:'prompt_analyze'},{text:'Price Check',callback_data:'prompt_price'}]]}}
  );
});

bot.onText(/\/help/, msg => {
  const isAdmin = String(msg.chat.id) === String(ADMIN_ID);
  bot.sendMessage(msg.chat.id,
    '📋 *Commands:*\n\n' +
    'Send CA → Analyze\n' +
    '/pnl <CA> — PNL Card\n' +
    '/price <symbol> — Price\n' +
    '/status — Status\n' +
    (isAdmin ? '\n👑 *Admin:*\n/scan — Manual scan\n/signal <CA> — Force signal\n/pending — View pending\n/stats — Stats\n/report — Weekly report' : ''),
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
    '⏰ Filter: Age 2-6h | MC $20K-$100K\n' +
    '🔄 Auto-scan: every 15 mins',
    { parse_mode:'Markdown' }
  );
});

bot.onText(/\/stats/, msg => {
  if (String(msg.chat.id) !== String(ADMIN_ID)) return;
  const rows = db.prepare('SELECT ca, token_name, token_symbol, saved_at FROM pending_signals ORDER BY saved_at DESC').all();
  bot.sendMessage(ADMIN_ID,
    '📊 *Stats*\n\n' +
    'Today: ' + getTodaySignalCount() + '/' + MAX_SIGNALS_PER_DAY + '\n' +
    'Pending: ' + rows.length + '\n' +
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
      const mins = Math.floor((Date.now()-r.saved_at)/60000);
      return (i+1)+'. *'+r.token_name+'* ('+r.token_symbol+') — '+mins+'m ago\n`'+r.ca+'`';
    }).join('\n\n');
    bot.sendMessage(ADMIN_ID, '📋 *Pending ('+rows.length+'):*\n\n'+list, { parse_mode:'Markdown' });
  } catch(e) { bot.sendMessage(ADMIN_ID, '❌ Error.'); }
});

bot.onText(/\/report/, async msg => {
  if (String(msg.chat.id) !== String(ADMIN_ID)) return;
  await sendWeeklyReport();
});

bot.onText(/\/clearcache/, msg => {
  if (String(msg.chat.id) !== String(ADMIN_ID)) return;
  clearScannedTokens();
  bot.sendMessage(ADMIN_ID, '✅ Scan cache cleared! All tokens will be re-checked on next scan.');
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
    if (!d) { await bot.deleteMessage(chatId,load.message_id); return bot.sendMessage(chatId,'❌ Coin not found!'); }
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
  } catch(e) { await bot.deleteMessage(chatId,load.message_id); bot.sendMessage(chatId,'❌ Error!'); }
});

bot.on('message', async msg => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const ca = msg.text.trim();
  if (/^[A-Za-z0-9]{32,50}$/.test(ca)) await sendAnalysis(msg.chat.id, ca, msg.from?.username);
});

// ═══════════════════════════════════════════════
//  CALLBACKS
// ═══════════════════════════════════════════════
bot.on('callback_query', async query => {
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const data   = query.data;
  const username = query.from?.username;

  if (data.startsWith('approve_')) {
    if (String(chatId)!==String(ADMIN_ID)) return bot.answerCallbackQuery(query.id,{text:'Admin only!'});
    await bot.answerCallbackQuery(query.id,{text:'Posting to channel...'});
    await postToChannel(data.replace('approve_',''), msgId);
    return;
  }
  if (data.startsWith('reject_')) {
    if (String(chatId)!==String(ADMIN_ID)) return bot.answerCallbackQuery(query.id,{text:'Admin only!'});
    const ca = data.replace('reject_','');
    deletePendingSignal(ca);
    await bot.answerCallbackQuery(query.id,{text:'Rejected!'});
    await bot.editMessageText('❌ Signal rejected.\nCA: `'+ca+'`', {chat_id:ADMIN_ID,message_id:msgId,parse_mode:'Markdown'});
    return;
  }
  if (data.startsWith('signal_')) {
    if (String(chatId)!==String(ADMIN_ID)) return bot.answerCallbackQuery(query.id,{text:'Admin only!'});
    await bot.answerCallbackQuery(query.id,{text:'Preparing signal...'});
    const ca = data.replace('signal_','');
    const p = await getTokenData(ca);
    if (!p) return bot.sendMessage(ADMIN_ID,'❌ Token not found!');
    const rug = await getRugcheck(ca);
    const analysis = calcTokenStrength(p, rug);
    await sendSignalForReview(ca, p, rug, analysis, false);
    return;
  }
  if (data.startsWith('refresh_')) {
    const ca = data.replace('refresh_','');
    await bot.answerCallbackQuery(query.id,{text:'Refreshing...'});
    try { await bot.deleteMessage(chatId, msgId); } catch(_) {}
    await sendAnalysis(chatId, ca, username);
    return;
  }
  if (data.startsWith('pnl_')) {
    await bot.answerCallbackQuery(query.id,{text:'Generating PNL...'});
    await sendPnl(chatId, data.replace('pnl_',''), username);
    return;
  }
  if (data==='delete') {
    await bot.deleteMessage(chatId, msgId);
    await bot.answerCallbackQuery(query.id,{text:'Deleted!'});
    return;
  }
  if (data==='prompt_analyze') { await bot.answerCallbackQuery(query.id); bot.sendMessage(chatId,'Send any Solana CA!'); return; }
  if (data==='prompt_price')   { await bot.answerCallbackQuery(query.id); bot.sendMessage(chatId,'Use: /price solana'); return; }
});

// ═══════════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════════
cleanOldPending();
clearScannedTokens(); // Clear on every restart so all tokens are fresh

console.log('=============================');
console.log('  YakubuWeb3Bot — STARTED');
console.log('  Strategy: Early Smart Money');
console.log('  Age: 2-6h | MC: $20K-$100K');
console.log('  Score threshold:', SCORE_PASS_MIN);
console.log('  Scan: every 15 mins');
console.log('=============================');

bot.sendMessage(ADMIN_ID,
  '🚀 *Bot Started!*\n\n' +
  '⏰ Strategy: 2-6h tokens\n' +
  '💊 MC: $20K - $100K\n' +
  '🔄 Scan: every 15 mins\n' +
  '🎯 Score threshold: ' + SCORE_PASS_MIN + '/100\n\n' +
  'First scan in 1 minute...',
  { parse_mode: 'Markdown' }
);

setTimeout(() => runScan(false), 60 * 1000);
setInterval(() => runScan(false), SCAN_INTERVAL_MS);
setInterval(checkOpenTrades, 10 * 60 * 1000);
scheduleWeeklyReport();
