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
const SCAN_INTERVAL_MS    = 15 * 60 * 1000;

// ── Filters ──
const MIN_AGE_HOURS  = 1;
const MAX_AGE_HOURS  = 12;
const MIN_MC         = 20000;
const MAX_MC         = 500000;
const MIN_LIQUIDITY  = 3000;
const MIN_VOLUME_24H = 500;
const MAX_RUG_SCORE  = 800;
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

// ── Pending Signals DB ──
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
  try { db.prepare('DELETE FROM pending_signals WHERE saved_at < ?').run(Date.now() - 12 * 60 * 60 * 1000); } catch(e) {}
}
function clearScannedTokens() {
  try { db.prepare('DELETE FROM scanned_tokens').run(); console.log('Cleared scan cache'); } catch(e) {}
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
    const totalPnl = trades.reduce((a,b) => a+(b.pnl_sol||0), 0);
    const best = [...trades].sort((a,b) => (b.pnl_pct||0)-(a.pnl_pct||0))[0];
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
function timeAgo(ms) {
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 60) return mins + 'm ago';
  return Math.floor(mins/60) + 'h ' + (mins%60) + 'm ago';
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
//  TRENDING — Solana Hot Tokens
// ═══════════════════════════════════════════════
async function getTrendingTokens() {
  const tokens = [];
  try {
    // Dexscreener trending solana pairs
    const res = await axios.get('https://api.dexscreener.com/latest/dex/pairs/solana', { timeout: 10000 });
    const pairs = (res.data?.pairs || [])
      .filter(p => p.chainId === 'solana' && p.fdv > 0)
      .sort((a,b) => (b.volume?.h24||0) - (a.volume?.h24||0))
      .slice(0, 20);
    pairs.forEach(p => {
      tokens.push({
        address: p.baseToken?.address,
        name: p.baseToken?.name,
        symbol: p.baseToken?.symbol,
        price: parseFloat(p.priceUsd || 0),
        mc: p.fdv || 0,
        liq: p.liquidity?.usd || 0,
        vol24: p.volume?.h24 || 0,
        ch1h: parseFloat(p.priceChange?.h1 || 0),
        ch24: parseFloat(p.priceChange?.h24 || 0),
        dex: p.dexId || 'N/A',
        url: 'https://dexscreener.com/solana/' + p.baseToken?.address
      });
    });
  } catch(e) { console.log('Trending fetch error:', e.message); }
  return tokens;
}

// ═══════════════════════════════════════════════
//  FETCH CANDIDATES — 6 Sources
// ═══════════════════════════════════════════════
async function fetchCandidateTokens() {
  const results = [];

  // Source 1: Dexscreener solana pairs (best source — sorted by volume)
  try {
    const res = await axios.get('https://api.dexscreener.com/latest/dex/pairs/solana', { timeout: 10000 });
    (res.data?.pairs || []).forEach(p => { if(p.baseToken?.address) results.push(p.baseToken.address); });
    console.log('S1 dex/solana:', results.length);
  } catch(e) { console.log('S1 failed:', e.message); }

  // Source 2: Dexscreener boosted
  try {
    const res = await axios.get('https://api.dexscreener.com/token-boosts/top/v1', { timeout: 10000 });
    (res.data||[]).filter(t => t.chainId==='solana').forEach(t => { if(t.tokenAddress) results.push(t.tokenAddress); });
    console.log('S2 boosts:', results.length);
  } catch(e) { console.log('S2 failed:', e.message); }

  // Source 3: Dexscreener latest profiles
  try {
    const res = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 10000 });
    (res.data||[]).filter(t => t.chainId==='solana').forEach(t => { if(t.tokenAddress) results.push(t.tokenAddress); });
    console.log('S3 profiles:', results.length);
  } catch(e) { console.log('S3 failed:', e.message); }

  // Source 4: Pump.fun latest trades
  try {
    const res = await axios.get('https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=false', { timeout: 10000 });
    (res.data||[]).forEach(t => { if(t.mint) results.push(t.mint); });
    console.log('S4 pump latest:', results.length);
  } catch(e) { console.log('S4 failed:', e.message); }

  // Source 5: Pump.fun top MC
  try {
    const res = await axios.get('https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=market_cap&order=DESC&includeNsfw=false', { timeout: 10000 });
    (res.data||[]).forEach(t => { if(t.mint) results.push(t.mint); });
    console.log('S5 pump mc:', results.length);
  } catch(e) { console.log('S5 failed:', e.message); }

  // Source 6: Dexscreener search — new tokens
  try {
    const res = await axios.get('https://api.dexscreener.com/latest/dex/search?q=new', { timeout: 10000 });
    (res.data?.pairs||[]).filter(p => p.chainId==='solana').forEach(p => { if(p.baseToken?.address) results.push(p.baseToken.address); });
    console.log('S6 dex new:', results.length);
  } catch(e) { console.log('S6 failed:', e.message); }

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
  const v1h  = parseFloat(p.volume?.h1  || 0);
  const v6h  = parseFloat(p.volume?.h6  || 0);
  const ch5m = parseFloat(p.priceChange?.m5  || 0);
  const ch1h = parseFloat(p.priceChange?.h1  || 0);
  const buys1h  = p.txns?.h1?.buys  || 0;
  const sells1h = p.txns?.h1?.sells || 0;
  const buys24  = p.txns?.h24?.buys  || 0;
  const sells24 = p.txns?.h24?.sells || 0;

  if (v6h > 0) {
    const share = (v1h / v6h) * 100;
    if (share > 50)      { score += 25; notes.push('🔥 Huge volume spike 1h (' + share.toFixed(0) + '%)'); }
    else if (share > 30) { score += 15; notes.push('📈 Strong volume 1h (' + share.toFixed(0) + '%)'); }
    else if (share > 15) { score += 7;  notes.push('📊 Moderate volume'); }
    else                  { score -= 3;  notes.push('⚠️ Volume slowing'); }
  }
  if (buys1h + sells1h > 0) {
    const bp = (buys1h / (buys1h + sells1h)) * 100;
    if (bp > 70)      { score += 20; notes.push('🟢 Strong buys ' + bp.toFixed(0) + '%'); }
    else if (bp > 55) { score += 10; notes.push('🟡 Good buys ' + bp.toFixed(0) + '%'); }
    else if (bp < 40) { score -= 15; notes.push('🔴 Selling pressure ' + (100-bp).toFixed(0) + '%'); }
  }
  if (buys24 + sells24 > 0) {
    const bp24 = (buys24 / (buys24 + sells24)) * 100;
    if (bp24 > 60) { score += 10; notes.push('✅ Healthy 24h ratio ' + bp24.toFixed(0) + '%'); }
    else if (bp24 < 40) { score -= 8; notes.push('⚠️ More sells 24h'); }
  }
  if (ch5m > 5 && ch1h > 10)   { score += 15; notes.push('🚀 Strong momentum'); }
  else if (ch5m > 2 && ch1h > 3){ score += 8;  notes.push('📈 Good momentum'); }
  if (ch5m < -10 && ch1h < -10) { score -= 20; notes.push('📉 Dumping'); }

  return { score: Math.max(0, Math.min(score, 100)), notes };
}

function scoreWhaleDetection(p, rug) {
  let score = 0;
  const notes = [];
  const whales = [];
  if (!rug) return { score: 10, notes: ['⚪ No rug data'], whales };

  const holders = rug?.topHolders || rug?.holders || [];
  if (holders.length > 0) {
    const list = holders.map(h => ({ addr: h.address||'', pct: Number(h.pct||h.percentage||h.share||0) }))
      .filter(h => h.addr && h.pct > 0 && h.pct < 60).sort((a,b) => b.pct - a.pct);
    const top1  = list[0]?.pct || 0;
    const top10 = list.slice(0,10).reduce((a,b) => a+b.pct, 0);
    if (top1 > 15)     { score -= 25; notes.push('🐋 DANGER top holder ' + top1.toFixed(1) + '%'); }
    else if (top1 > 8) { score -= 10; notes.push('⚠️ Top holder ' + top1.toFixed(1) + '%'); }
    else               { score += 15; notes.push('✅ Top holder only ' + top1.toFixed(1) + '%'); }
    if (top10 < 20)     { score += 20; notes.push('✅ Great distribution top10=' + top10.toFixed(1) + '%'); }
    else if (top10 < 35){ score += 8;  notes.push('🟡 OK distribution top10=' + top10.toFixed(1) + '%'); }
    else                { score -= 10; notes.push('🔴 Concentrated top10=' + top10.toFixed(1) + '%'); }
    list.slice(0,3).forEach((h,i) => { if(h.pct>1) whales.push({rank:i+1, addr:h.addr.slice(0,6)+'...'+h.addr.slice(-4), pct:h.pct.toFixed(2)}); });
  } else { score += 5; notes.push('⚪ No holder data'); }

  if (rug.insiderNetworks?.length > 0) {
    const bPct = rug.insiderNetworks.reduce((a,b) => a+(b.holdingPercent||0), 0);
    if (bPct > 20)     { score -= 25; notes.push('🔴 Bundles ' + bPct.toFixed(1) + '%'); }
    else if (bPct > 10){ score -= 8;  notes.push('⚠️ Some bundles ' + bPct.toFixed(1) + '%'); }
    else               { score += 10; notes.push('✅ No significant bundles'); }
  } else { score += 10; notes.push('✅ No bundles'); }

  if (rug.snipers?.length > 0) {
    const sPct = rug.snipers.reduce((a,b) => a+(b.holdingPercent||0), 0);
    if (sPct > 10) { score -= 10; notes.push('🎯 Snipers ' + sPct.toFixed(1) + '%'); }
    else           { score += 5;  notes.push('✅ Low snipers'); }
  } else { score += 5; notes.push('✅ No snipers'); }

  return { score: Math.max(0, Math.min(score, 100)), notes, whales };
}

function scoreSmartMoney(p, rug) {
  let score = 0;
  const notes = [];
  if (!rug) return { score: 10, notes: ['⚪ No rug data'] };
  const v1h  = p.volume?.h1 || 0;
  const buys = p.txns?.h1?.buys || 0;
  if (buys > 0 && v1h > 0) {
    const avg = v1h / buys;
    if (avg > 1000)     { score += 25; notes.push('💰 Large avg buy $' + avg.toFixed(0)); }
    else if (avg > 500) { score += 15; notes.push('💵 Good avg buy $' + avg.toFixed(0)); }
    else if (avg > 200) { score += 7;  notes.push('🟡 Small avg buy $' + avg.toFixed(0)); }
    else                { score += 2;  notes.push('⚠️ Very small avg buy $' + avg.toFixed(0)); }
  }
  if (rug.creator) {
    const devH = (rug?.topHolders||[]).find(h => h.address === rug.creator);
    const devPct = devH ? Number(devH.pct||0) : 0;
    if (devPct === 0)    { score += 20; notes.push('✅ Dev not holding'); }
    else if (devPct < 3) { score += 10; notes.push('✅ Dev minimal ' + devPct.toFixed(1) + '%'); }
    else if (devPct > 5) { score -= 20; notes.push('🔴 Dev holds ' + devPct.toFixed(1) + '%!'); }
    else                  { score += 3;  notes.push('🟡 Dev ' + devPct.toFixed(1) + '%'); }
  }
  if (rug.score !== undefined) {
    const rs = Number(rug.score);
    if (rs < 200)      { score += 20; notes.push('🟢 Very safe rug score: ' + rs); }
    else if (rs < 500) { score += 10; notes.push('🟡 OK rug score: ' + rs); }
    else               { score -= 10; notes.push('🔴 High rug score: ' + rs); }
  }
  const hasSocials = p.info?.socials?.length > 0 || p.info?.websites?.length > 0;
  if (hasSocials) { score += 8; notes.push('✅ Has socials'); }
  if (rug.markets?.length > 0) {
    const locked = rug.markets.some(m => m.lp?.lpLockedPct > 50);
    if (locked) { score += 15; notes.push('🔒 LP locked!'); }
  }
  return { score: Math.max(0, Math.min(score, 100)), notes };
}

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
  if (a.whl.whales?.length > 0) a.whl.whales.forEach(w => { r += '  #' + w.rank + ' ' + w.addr + ' — ' + w.pct + '%\n'; });
  r += '\n💰 *Smart Money* (' + a.smt.score + 'pts)\n';
  a.smt.notes.slice(0,3).forEach(n => { r += '  ' + n + '\n'; });
  r += '\n━━━━━━━━━━━━━━━━━━━\n';
  r += a.passes ? '✅ *PASSES — Ready for review*\n' : '❌ *FAILS — Score ' + a.final + '/' + SCORE_PASS_MIN + '*\n';
  return r;
}

// ═══════════════════════════════════════════════
//  ANALYZE TOKEN FOR SIGNAL
// ═══════════════════════════════════════════════
async function analyzeForSignal(ca) {
  try {
    const p = await getTokenData(ca);
    if (!p) return null;

    if (!p.pairCreatedAt) return null;
    const ageH = (Date.now() - p.pairCreatedAt) / 3600000;
    const mc  = p.fdv || 0;
    const liq = p.liquidity?.usd || 0;

    // Filters
    if (ageH < MIN_AGE_HOURS || ageH > MAX_AGE_HOURS) return null;
    if (mc < MIN_MC || mc > MAX_MC) return null;
    if (liq < MIN_LIQUIDITY) return null;
    if ((p.volume?.h24 || 0) < MIN_VOLUME_24H) return null;

    // Not crashing
    const ch1h = parseFloat(p.priceChange?.h1 || 0);
    if (ch1h < -40) return null;

    // Rug check
    const rug = await getRugcheck(ca);
    if (rug?.score && rug.score > MAX_RUG_SCORE) return null;

    if (rug) {
      const holders = rug?.topHolders || rug?.holders || [];
      if (holders.length > 0) {
        const list = holders.map(h => Number(h.pct||h.percentage||h.share||0)).filter(x => x>0&&x<60);
        const top10 = list.sort((a,b)=>b-a).slice(0,10).reduce((a,b)=>a+b,0);
        if (top10 > 50) return null;
      }
      if (rug.insiderNetworks?.length > 20) return null;
    }

    const analysis = calcTokenStrength(p, rug);
    if (!analysis.passes) {
      console.log('FAIL', ca.slice(0,8), 'score:', analysis.final, 'age:', ageH.toFixed(1)+'h', 'mc:', fmt(mc));
      return null;
    }

    console.log('✅ PASS', ca.slice(0,8), 'score:', analysis.final, 'grade:', analysis.grade, 'age:', ageH.toFixed(1)+'h', 'mc:', fmt(mc));
    return { p, rug, analysis };
  } catch(e) { return null; }
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
  if (manual) bot.sendMessage(ADMIN_ID, '🔍 Scanning...\n⏰ Age: ' + MIN_AGE_HOURS + '-' + MAX_AGE_HOURS + 'h | MC: ' + fmt(MIN_MC) + '-' + fmt(MAX_MC));
  console.log('=== SCAN START ===');

  try {
    const cas = await fetchCandidateTokens();
    if (manual) bot.sendMessage(ADMIN_ID, '📋 ' + cas.length + ' candidates — analyzing...');

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
      await new Promise(r => setTimeout(r, 500));
    }

    console.log('=== SCAN DONE === checked:', checked, 'found:', found);
    if (manual) {
      bot.sendMessage(ADMIN_ID, found === 0
        ? '🔍 Done — checked ' + checked + ' tokens, none passed.\n\nFilters: Age ' + MIN_AGE_HOURS + '-' + MAX_AGE_HOURS + 'h | MC ' + fmt(MIN_MC) + '-' + fmt(MAX_MC) + ' | Score ' + SCORE_PASS_MIN + '+\n\nNext scan in 15 mins.'
        : '✅ Done — ' + found + ' signal(s) ready!'
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
//  SIGNAL FORMAT & POST
// ═══════════════════════════════════════════════
function fmtSignalPost(p, ca, rug, entry, t1, t2, sl) {
  const name = p.baseToken.name;
  const sym  = p.baseToken.symbol;
  const mc   = p.fdv || 0;
  const liq  = p.liquidity?.usd || 0;
  const ageH = p.pairCreatedAt ? ((Date.now()-p.pairCreatedAt)/3600000).toFixed(1) : 'N/A';
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
    const ageH = p.pairCreatedAt ? ((Date.now()-p.pairCreatedAt)/3600000).toFixed(1) : 'N/A';
    const signalText = fmtSignalPost(p, ca, rug, entry, t1, t2, sl);
    const analysisText = fmtAnalysis(analysis);
    savePendingSignal(ca, { p, signalText, entry, t1, t2, sl });
    await bot.sendMessage(ADMIN_ID,
      (isAuto?'🔔':'👁️') + ' *SIGNAL PREVIEW* — ' + (isAuto?'🤖 AUTO':'👤 MANUAL') + '\n' +
      '📊 Today: ' + getTodaySignalCount() + '/' + MAX_SIGNALS_PER_DAY + '\n' +
      '⏰ Age: ' + ageH + 'h | ' + analysis.emoji + ' Score: ' + analysis.final + '/100\n\n' +
      signalText + analysisText,
      { parse_mode:'Markdown', disable_web_page_preview:true,
        reply_markup:{inline_keyboard:[[{text:'✅ APPROVE',callback_data:'approve_'+ca},{text:'❌ REJECT',callback_data:'reject_'+ca}]]}
      }
    );
  } catch(e) { console.error('sendSignalForReview:', e.message); if(!isAuto) bot.sendMessage(ADMIN_ID,'❌ Error: '+e.message); }
}

async function postToChannel(ca, msgId) {
  const pending = getPendingSignal(ca);
  if (!pending) return bot.sendMessage(ADMIN_ID, '⚠️ Signal expired! Use /signal <CA> to re-analyze.');
  if (getTodaySignalCount() >= MAX_SIGNALS_PER_DAY) return bot.sendMessage(ADMIN_ID, '❌ Max signals today!');
  try {
    await bot.sendMessage(CHANNEL_ID, pending.signal_text, {
      parse_mode:'Markdown', disable_web_page_preview:true,
      reply_markup:{inline_keyboard:[[{text:'Chart',url:'https://dexscreener.com/solana/'+ca},{text:'Analyze',url:'https://t.me/YakubuWeb3Bot?start='+ca}]]}
    });
    recordSignalSent(ca);
    saveSnapshot(CHANNEL_ID, ca, pending.entry_price, pending.token_fdv, pending.token_name, pending.token_symbol);
    openPaperTrade(ca, pending.token_name, pending.token_symbol, pending.entry_price, pending.token_fdv, pending.target1, pending.target2, pending.stop_loss);
    deletePendingSignal(ca);
    const cnt = getTodaySignalCount();
    await bot.editMessageText('✅ Posted! ('+cnt+'/'+MAX_SIGNALS_PER_DAY+' today)\n\n'+pending.signal_text,
      {chat_id:ADMIN_ID, message_id:msgId, parse_mode:'Markdown', disable_web_page_preview:true});
  } catch(e) { bot.sendMessage(ADMIN_ID,'❌ Failed to post! Check bot is admin in channel.'); console.error(e); }
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
      const toT2   = ((trade.target2 - cur) / trade.target2 * 100).toFixed(1);
      const t1Hit  = trade.result === 'T1_partial' || trade.result === 'T1_progress' || trade.result === 'T2';

      // ── After T1 hit — SL moves to entry price ──
      // Only close if price falls BELOW entry (after T1)
      // No SL warning after T1 — silent protection

      // ── TARGET 2 HIT (+100%) ──
      if (cur >= trade.target2) {
        closePaperTrade(trade.id, 'T2', pnlPct, pnlSol);
        await bot.sendMessage(CHANNEL_ID,
          '🏆 *TARGET 2 HIT! +100%* 🏆\n' +
          '━━━━━━━━━━━━━━━━━━━\n' +
          '🪙 *' + trade.name + '* (' + trade.symbol + ')\n\n' +
          '📥 Entry: ' + fmtPrice(trade.entry_price) + '\n' +
          '📤 Exit: ' + fmtPrice(cur) + '\n' +
          '✅ PNL: +' + pnlPct.toFixed(1) + '% (+' + pnlSol.toFixed(3) + ' SOL)\n' +
          '📊 Multiplier: ' + (cur/trade.entry_price).toFixed(2) + 'x\n\n' +
          '_Signal by @YakubuWeb3_',
          { parse_mode: 'Markdown' }
        );
        continue;
      }

      // ── TARGET 1 HIT (+50%) — first time ──
      if (cur >= trade.target1 && !t1Hit) {
        // Move SL to entry price silently
        db.prepare('UPDATE paper_trades SET result = ?, stop_loss = ? WHERE id = ?').run('T1_partial', trade.entry_price, trade.id);
        await bot.sendMessage(CHANNEL_ID,
          '🎯 *TARGET 1 HIT! +50%*\n' +
          '━━━━━━━━━━━━━━━━━━━\n' +
          '🪙 *' + trade.name + '* (' + trade.symbol + ')\n\n' +
          '📥 Entry: ' + fmtPrice(trade.entry_price) + '\n' +
          '📍 Now: ' + fmtPrice(cur) + '\n' +
          '✅ PNL: +' + pnlPct.toFixed(1) + '% (+' + pnlSol.toFixed(3) + ' SOL)\n\n' +
          '👀 Watching T2 (+100%)...\n' +
          '🛡️ SL moved to entry — protected!\n\n' +
          '_Signal by @YakubuWeb3_',
          { parse_mode: 'Markdown' }
        );
        continue;
      }

      // ── AFTER T1: price fell back to entry or below — close silently ──
      if (t1Hit && cur <= trade.entry_price) {
        closePaperTrade(trade.id, 'T1', pnlPct, pnlSol);
        // No channel post — T1 was already celebrated, this is just closing
        console.log('Trade closed at entry after T1:', trade.name, pnlPct.toFixed(1) + '%');
        continue;
      }

      // ── BEFORE T1: SL HIT (-20%) ──
      if (!t1Hit && cur <= trade.stop_loss) {
        closePaperTrade(trade.id, 'SL', pnlPct, pnlSol);
        await bot.sendMessage(CHANNEL_ID,
          '🔴 *STOP LOSS HIT*\n' +
          '━━━━━━━━━━━━━━━━━━━\n' +
          '🪙 *' + trade.name + '* (' + trade.symbol + ')\n\n' +
          '📥 Entry: ' + fmtPrice(trade.entry_price) + '\n' +
          '📤 Exit: ' + fmtPrice(cur) + '\n' +
          '📉 PNL: ' + pnlPct.toFixed(1) + '% (' + pnlSol.toFixed(3) + ' SOL)\n\n' +
          '_Signal by @YakubuWeb3_',
          { parse_mode: 'Markdown' }
        );
        continue;
      }

      // ── BEFORE T1: SL WARNING (-15%) ──
      if (!t1Hit && pnlPct <= -15 && trade.result !== 'sl_warning') {
        db.prepare('UPDATE paper_trades SET result = ? WHERE id = ?').run('sl_warning', trade.id);
        await bot.sendMessage(CHANNEL_ID,
          '⚠️ *STOP LOSS WARNING*\n' +
          '━━━━━━━━━━━━━━━━━━━\n' +
          '🪙 *' + trade.name + '* (' + trade.symbol + ')\n\n' +
          '📍 Now: ' + fmtPrice(cur) + '\n' +
          '📉 PNL: ' + pnlPct.toFixed(1) + '% (' + pnlSol.toFixed(3) + ' SOL)\n' +
          '🛑 SL approaching: ' + fmtPrice(trade.stop_loss) + '\n\n' +
          '_Signal by @YakubuWeb3_',
          { parse_mode: 'Markdown' }
        );
        continue;
      }

      // ── PROGRESS +30% (before T1) ──
      if (!t1Hit && pnlPct >= 30 && trade.result !== 'progress_30') {
        db.prepare('UPDATE paper_trades SET result = ? WHERE id = ?').run('progress_30', trade.id);
        const toT1 = ((trade.target1 - cur) / trade.target1 * 100).toFixed(1);
        await bot.sendMessage(CHANNEL_ID,
          '📈 *UPDATE — ' + trade.name + ' (' + trade.symbol + ')*\n' +
          '━━━━━━━━━━━━━━━━━━━\n\n' +
          '✅ Up +' + pnlPct.toFixed(1) + '% (+' + pnlSol.toFixed(3) + ' SOL)\n\n' +
          '🎯 T1 (+50%): ' + toT1 + '% away\n' +
          '🏆 T2 (+100%): ' + toT2 + '% away\n\n' +
          '_Signal by @YakubuWeb3_',
          { parse_mode: 'Markdown' }
        );
        continue;
      }

      // ── PROGRESS +20% (before T1) ──
      if (!t1Hit && pnlPct >= 20 && !['progress_30','progress_20'].includes(trade.result)) {
        db.prepare('UPDATE paper_trades SET result = ? WHERE id = ?').run('progress_20', trade.id);
        const toT1 = ((trade.target1 - cur) / trade.target1 * 100).toFixed(1);
        await bot.sendMessage(CHANNEL_ID,
          '📈 *UPDATE — ' + trade.name + ' (' + trade.symbol + ')*\n' +
          '━━━━━━━━━━━━━━━━━━━\n\n' +
          '✅ Up +' + pnlPct.toFixed(1) + '% (+' + pnlSol.toFixed(3) + ' SOL)\n\n' +
          '🎯 T1 (+50%): ' + toT1 + '% away\n' +
          '🏆 T2 (+100%): ' + toT2 + '% away\n\n' +
          '_Signal by @YakubuWeb3_',
          { parse_mode: 'Markdown' }
        );
        continue;
      }

      await new Promise(r => setTimeout(r, 800));
    } catch(e) { console.error('Trade check error:', e.message); }
  }
}

// ═══════════════════════════════════════════════
//  TOKEN ANALYSIS
// ═══════════════════════════════════════════════
async function sendAnalysis(chatId, ca, username) {
  const load = await bot.sendMessage(chatId, '🔍 Analyzing token...');
  try {
    const p = await getTokenData(ca);
    if (!p) { await bot.deleteMessage(chatId,load.message_id); return bot.sendMessage(chatId,'❌ Token not found! Check CA is correct.'); }
    const rug = await getRugcheck(ca);
    const analysis = calcTokenStrength(p, rug);
    saveSnapshot(chatId, ca, parseFloat(p.priceUsd)||0, p.fdv||0, p.baseToken.name, p.baseToken.symbol);
    const mc = p.fdv||0, liq = p.liquidity?.usd||0;
    const ageH = p.pairCreatedAt ? ((Date.now()-p.pairCreatedAt)/3600000).toFixed(1)+'h' : 'N/A';
    const buys=p.txns?.h24?.buys||0, sells=p.txns?.h24?.sells||0;
    const rs = rug?.score||'N/A';
    let socials='';
    if(p.info?.websites?.[0]) socials+='[Web]('+p.info.websites[0].url+') ';
    if(p.info?.socials) p.info.socials.forEach(s=>{if(s.type==='twitter')socials+='[X]('+s.url+') ';if(s.type==='telegram')socials+='[TG]('+s.url+') ';});
    if(!socials)socials='No socials';
    const holders=rug?.topHolders||rug?.holders||[];
    let top10str='N/A';
    if(holders.length){const list=holders.map(h=>Number(h.pct||h.percentage||h.share||0)).filter(x=>x>0&&x<60).sort((a,b)=>b-a);if(list.length)top10str=Math.min(list.slice(0,10).reduce((a,b)=>a+b,0),100).toFixed(1)+'%';}
    const devH=rug?.creator?(rug?.topHolders||[]).find(h=>h.address===rug.creator):null;
    const devInfo=devH?(devH.pct||0).toFixed(1)+'%':(rug?.creator?'0%':'N/A');
    const bundleInfo=rug?.insiderNetworks?.length?rug.insiderNetworks.length+' bundles ('+rug.insiderNetworks.reduce((a,b)=>a+(b.holdingPercent||0),0).toFixed(1)+'%)':'None';
    const text='🔍 *'+p.baseToken.name+'* ('+p.baseToken.symbol+')\n⏰ Age: '+ageH+' | 🏦 '+(p.dexId||'N/A')+'\n\n💰 *Price:* '+fmtPrice(p.priceUsd)+'\n💊 *MC:* '+fmt(mc)+' | 💧 *Liq:* '+fmt(liq)+'\n\n📈 *Volume:*\n├ 1h: '+fmt(p.volume?.h1)+'\n├ 6h: '+fmt(p.volume?.h6)+'\n└ 24h: '+fmt(p.volume?.h24)+'\n\n📉 *Change:*\n├ 5m: '+fmtPct(p.priceChange?.m5)+'\n├ 1h: '+fmtPct(p.priceChange?.h1)+'\n└ 24h: '+fmtPct(p.priceChange?.h24)+'\n\n🛒 *Buys 24h:* '+buys+' | 🔴 *Sells:* '+sells+'\n🔗 *Socials:* '+socials+'\n\n👥 *Top 10 holders:* '+top10str+'\n🔧 *Dev:* '+devInfo+'\n📦 *Bundles:* '+bundleInfo+'\n\n🛡️ *Rug Score:* '+rs+' — '+rugEmoji(rs)+'\n\n'+analysis.emoji+' *Strength: '+analysis.final+'/100 — Grade '+analysis.grade+'*\n\n📋 `'+ca+'`\n_/pnl '+ca+'_';
    await bot.deleteMessage(chatId, load.message_id);
    const isAdmin=String(chatId)===String(ADMIN_ID);
    const kb=isAdmin?[[{text:'Refresh',callback_data:'refresh_'+ca},{text:'Delete',callback_data:'delete'},{text:'Chart',url:'https://dexscreener.com/solana/'+ca}],[{text:'PNL Card',callback_data:'pnl_'+ca},{text:'Send as Signal',callback_data:'signal_'+ca}]]:[[{text:'Refresh',callback_data:'refresh_'+ca},{text:'Delete',callback_data:'delete'},{text:'Chart',url:'https://dexscreener.com/solana/'+ca}],[{text:'PNL Card',callback_data:'pnl_'+ca}]];
    await bot.sendMessage(chatId, text, {parse_mode:'Markdown',disable_web_page_preview:true,reply_markup:{inline_keyboard:kb}});
  } catch(e) { try{await bot.deleteMessage(chatId,load.message_id);}catch(_){} bot.sendMessage(chatId,'❌ Error. Try again.'); console.error('sendAnalysis:',e.message); }
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
    if (!p) { await bot.deleteMessage(chatId,load.message_id); return bot.sendMessage(chatId,'❌ Token not found!'); }
    const cur=parseFloat(p.priceUsd)||0, curMc=p.fdv||0;
    const pnlPct=((cur-snap.price)/snap.price)*100, mult=cur/snap.price, isProfit=pnlPct>=0;
    const W=800,H=450,img=new Jimp(W,H,isProfit?0x0a2a1aff:0x2a0a0aff),bc=isProfit?0x00ff88ff:0xff4444ff;
    for(let x=0;x<W;x++){for(let t=0;t<4;t++){img.setPixelColor(bc,x,t);img.setPixelColor(bc,x,H-1-t);}}
    for(let y=0;y<H;y++){for(let t=0;t<4;t++){img.setPixelColor(bc,t,y);img.setPixelColor(bc,W-1-t,y);}}
    const f64=await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE),f32=await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE),f16=await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
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
    await bot.deleteMessage(chatId,load.message_id);
    await bot.sendPhoto(chatId,fp,{caption:'PNL — '+snap.name+' ('+snap.symbol+')\n\nEntry MC: '+fmt(snap.mc)+'\nCurrent MC: '+fmt(curMc)+'\n'+(isProfit?'🟢':'🔴')+' PNL: '+(isProfit?'+':'')+pnlPct.toFixed(1)+'%\nMultiplier: '+mult.toFixed(2)+'x\n\nPowered by @YakubuWeb3Bot',parse_mode:'Markdown'});
    fs.unlinkSync(fp);
  } catch(e) { try{await bot.deleteMessage(chatId,load.message_id);}catch(_){} bot.sendMessage(chatId,'❌ Error!'); console.error('sendPnl:',e.message); }
}

// ═══════════════════════════════════════════════
//  WEEKLY REPORT
// ═══════════════════════════════════════════════
async function sendWeeklyReport() {
  const s = getWeeklyStats();
  if (!s) { bot.sendMessage(ADMIN_ID,'📊 No closed trades this week.'); return; }
  await bot.sendMessage(CHANNEL_ID,
    '*📊 WEEKLY SIGNAL REPORT*\n━━━━━━━━━━━━━━━━━━━\n\nLast 7 days:\n📈 Total: '+s.total+'\n✅ Wins: '+s.wins+'/'+s.total+'\n🎯 Win Rate: '+s.winRate+'%\n💰 PNL: '+(parseFloat(s.totalPnl)>0?'+':'')+s.totalPnl+' SOL\n'+(s.best?'🏆 Best: '+s.best.symbol+' +'+(s.best.pnl_pct||0).toFixed(1)+'%\n':'')+'\n_Signal by @YakubuWeb3_',
    {parse_mode:'Markdown'});
}
function scheduleWeeklyReport() {
  setInterval(()=>{const n=new Date();if(n.getDay()===0&&n.getHours()===8&&n.getMinutes()<15)sendWeeklyReport();},15*60*1000);
}

// ═══════════════════════════════════════════════
//  /TRENDING COMMAND
// ═══════════════════════════════════════════════
bot.onText(/\/trending/, async msg => {
  const chatId = msg.chat.id;
  const load = await bot.sendMessage(chatId, '🔥 Fetching Solana trending tokens...');
  try {
    const tokens = await getTrendingTokens();
    if (!tokens.length) { await bot.deleteMessage(chatId,load.message_id); return bot.sendMessage(chatId,'❌ Could not fetch trending tokens.'); }
    const now = new Date().toUTCString();
    let text = '🔥 *Solana Trending Tokens* 🔥\n_Updated: ' + now + '_\n\n';
    tokens.slice(0,10).forEach((t,i) => {
      text += (i+1) + '. *' + t.name + '* (' + t.symbol + ')\n';
      text += '💊 MCap: ' + fmt(t.mc) + ' | 💧 Liq: ' + fmt(t.liq) + '\n';
      text += '📈 Vol 24h: ' + fmt(t.vol24) + '\n';
      text += '1h: ' + fmtPct(t.ch1h) + ' | 24h: ' + fmtPct(t.ch24) + '\n';
      text += '[DEXScreener](' + t.url + ') | [Swap on Jupiter](https://jup.ag/swap/SOL-' + t.address + ')\n\n';
    });
    await bot.deleteMessage(chatId, load.message_id);
    await bot.sendMessage(chatId, text, {
      parse_mode:'Markdown', disable_web_page_preview:true,
      reply_markup:{inline_keyboard:[[{text:'🔄 Refresh',callback_data:'trending_refresh'},{text:'📡 Get Signal',callback_data:'prompt_analyze'}]]}
    });
  } catch(e) { try{await bot.deleteMessage(chatId,load.message_id);}catch(_){} bot.sendMessage(chatId,'❌ Error fetching trending!'); }
});

// ═══════════════════════════════════════════════
//  BOT COMMANDS
// ═══════════════════════════════════════════════
bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id,
    '🚀 *YakubuWeb3 Signal Bot*\n\n' +
    'Send any *Solana CA* to analyze!\n\n' +
    '🔥 /trending — Hot Solana tokens\n' +
    '📡 Auto-scan every 15 mins\n' +
    '🎯 Targets: 1-12h | $20K-$500K MC\n\n' +
    '/pnl <CA> — PNL Card\n' +
    '/price <symbol> — Price\n' +
    '/trending — Trending tokens\n' +
    '/status — Bot Status\n' +
    '/help — All Commands\n\n' +
    '_Powered by @YakubuWeb3_',
    {parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'🔥 Trending',callback_data:'trending_refresh'},{text:'📊 Analyze CA',callback_data:'prompt_analyze'}]]}}
  );
});

bot.onText(/\/help/, msg => {
  const isAdmin = String(msg.chat.id)===String(ADMIN_ID);
  bot.sendMessage(msg.chat.id,
    '📋 *Commands:*\n\n' +
    '🔥 /trending — Hot Solana tokens\n' +
    'Send CA → Analyze\n' +
    '/pnl <CA> — PNL Card\n' +
    '/price <symbol> — Price\n' +
    '/status — Status\n' +
    (isAdmin?'\n👑 *Admin:*\n/scan — Manual scan\n/signal <CA> — Force signal\n/pending — View pending\n/stats — Stats\n/clearcache — Clear scan cache\n/report — Weekly report':''),
    {parse_mode:'Markdown'}
  );
});

bot.onText(/\/status/, msg => {
  const cnt=getTodaySignalCount(), trades=getOpenTrades();
  bot.sendMessage(msg.chat.id,
    '📊 *Bot Status*\n\n✅ Running\n📡 Signals today: '+cnt+'/'+MAX_SIGNALS_PER_DAY+'\n📈 Open trades: '+trades.length+'\n\n⚙️ *Filters:*\n⏰ Age: '+MIN_AGE_HOURS+'-'+MAX_AGE_HOURS+'h\n💊 MC: '+fmt(MIN_MC)+'-'+fmt(MAX_MC)+'\n🎯 Score: '+SCORE_PASS_MIN+'+/100\n🔄 Scan: every 15 mins',
    {parse_mode:'Markdown'});
});

bot.onText(/\/stats/, msg => {
  if(String(msg.chat.id)!==String(ADMIN_ID)) return;
  const rows=db.prepare('SELECT ca, token_name, token_symbol, saved_at FROM pending_signals ORDER BY saved_at DESC').all();
  bot.sendMessage(ADMIN_ID,'📊 *Stats*\n\nToday: '+getTodaySignalCount()+'/'+MAX_SIGNALS_PER_DAY+'\nPending: '+rows.length+'\nOpen trades: '+getOpenTrades().length,{parse_mode:'Markdown'});
});

bot.onText(/\/scan/, async msg => { if(String(msg.chat.id)!==String(ADMIN_ID))return; await runScan(true); });

bot.onText(/\/signal (.+)/, async (msg,match) => {
  if(String(msg.chat.id)!==String(ADMIN_ID)) return bot.sendMessage(msg.chat.id,'❌ Admin only!');
  const ca=match[1].trim();
  const load=await bot.sendMessage(ADMIN_ID,'🔍 Fetching...');
  const p=await getTokenData(ca);
  if(!p){await bot.deleteMessage(ADMIN_ID,load.message_id);return bot.sendMessage(ADMIN_ID,'❌ Token not found!');}
  const rug=await getRugcheck(ca);
  const analysis=calcTokenStrength(p,rug);
  await bot.deleteMessage(ADMIN_ID,load.message_id);
  await sendSignalForReview(ca,p,rug,analysis,false);
});

bot.onText(/\/pending/, msg => {
  if(String(msg.chat.id)!==String(ADMIN_ID)) return;
  try {
    const rows=db.prepare('SELECT ca, token_name, token_symbol, saved_at FROM pending_signals ORDER BY saved_at DESC').all();
    if(!rows.length) return bot.sendMessage(ADMIN_ID,'📋 No pending signals.');
    const list=rows.map((r,i)=>(i+1)+'. *'+r.token_name+'* ('+r.token_symbol+') — '+Math.floor((Date.now()-r.saved_at)/60000)+'m ago\n`'+r.ca+'`').join('\n\n');
    bot.sendMessage(ADMIN_ID,'📋 *Pending ('+rows.length+'):*\n\n'+list,{parse_mode:'Markdown'});
  } catch(e){bot.sendMessage(ADMIN_ID,'❌ Error.');}
});

bot.onText(/\/clearcache/, msg => {
  if(String(msg.chat.id)!==String(ADMIN_ID)) return;
  clearScannedTokens();
  bot.sendMessage(ADMIN_ID,'✅ Scan cache cleared! All tokens fresh on next scan.');
});

bot.onText(/\/report/, async msg => { if(String(msg.chat.id)!==String(ADMIN_ID))return; await sendWeeklyReport(); });
bot.onText(/\/pnl (.+)/, async (msg,match) => { await sendPnl(msg.chat.id,match[1].trim(),msg.from?.username); });

bot.onText(/\/price (.+)/, async (msg,match) => {
  const chatId=msg.chat.id, sym=match[1].trim().toLowerCase();
  const load=await bot.sendMessage(chatId,'⏳ Fetching price...');
  try {
    const res=await axios.get('https://api.coingecko.com/api/v3/simple/price?ids='+sym+'&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true');
    const d=res.data[sym];
    if(!d){await bot.deleteMessage(chatId,load.message_id);return bot.sendMessage(chatId,'❌ Coin not found!');}
    await bot.deleteMessage(chatId,load.message_id);
    bot.sendMessage(chatId,'💰 *'+sym.toUpperCase()+'*\n\nPrice: '+fmtPrice(d.usd)+'\nMC: '+fmt(d.usd_market_cap)+'\nVol 24h: '+fmt(d.usd_24h_vol)+'\n'+fmtPct(d.usd_24h_change)+' (24h)\n\n_Powered by @YakubuWeb3_',{parse_mode:'Markdown'});
  } catch(e){await bot.deleteMessage(chatId,load.message_id);bot.sendMessage(chatId,'❌ Error!');}
});

bot.on('message', async msg => {
  if(!msg.text||msg.text.startsWith('/')) return;
  const ca=msg.text.trim();
  if(/^[A-Za-z0-9]{32,50}$/.test(ca)) await sendAnalysis(msg.chat.id,ca,msg.from?.username);
});

// ═══════════════════════════════════════════════
//  CALLBACKS
// ═══════════════════════════════════════════════
bot.on('callback_query', async query => {
  const chatId=query.message.chat.id, msgId=query.message.message_id, data=query.data, username=query.from?.username;

  if(data==='trending_refresh') {
    await bot.answerCallbackQuery(query.id,{text:'Fetching trending...'});
    try{await bot.deleteMessage(chatId,msgId);}catch(_){}
    const load=await bot.sendMessage(chatId,'🔥 Refreshing trending...');
    try {
      const tokens=await getTrendingTokens();
      const now=new Date().toUTCString();
      let text='🔥 *Solana Trending Tokens* 🔥\n_Updated: '+now+'_\n\n';
      tokens.slice(0,10).forEach((t,i)=>{
        text+=(i+1)+'. *'+t.name+'* ('+t.symbol+')\n';
        text+='💊 MCap: '+fmt(t.mc)+' | 💧 Liq: '+fmt(t.liq)+'\n';
        text+='📈 Vol 24h: '+fmt(t.vol24)+'\n';
        text+='1h: '+fmtPct(t.ch1h)+' | 24h: '+fmtPct(t.ch24)+'\n';
        text+='[DEXScreener]('+t.url+') | [Swap on Jupiter](https://jup.ag/swap/SOL-'+t.address+')\n\n';
      });
      await bot.deleteMessage(chatId,load.message_id);
      await bot.sendMessage(chatId,text,{parse_mode:'Markdown',disable_web_page_preview:true,reply_markup:{inline_keyboard:[[{text:'🔄 Refresh',callback_data:'trending_refresh'},{text:'📡 Get Signal',callback_data:'prompt_analyze'}]]}});
    } catch(e){try{await bot.deleteMessage(chatId,load.message_id);}catch(_){}bot.sendMessage(chatId,'❌ Error!');}
    return;
  }
  if(data.startsWith('approve_')){
    if(String(chatId)!==String(ADMIN_ID)) return bot.answerCallbackQuery(query.id,{text:'Admin only!'});
    await bot.answerCallbackQuery(query.id,{text:'Posting...'});
    await postToChannel(data.replace('approve_',''),msgId); return;
  }
  if(data.startsWith('reject_')){
    if(String(chatId)!==String(ADMIN_ID)) return bot.answerCallbackQuery(query.id,{text:'Admin only!'});
    const ca=data.replace('reject_','');
    deletePendingSignal(ca);
    await bot.answerCallbackQuery(query.id,{text:'Rejected!'});
    await bot.editMessageText('❌ Signal rejected.\nCA: `'+ca+'`',{chat_id:ADMIN_ID,message_id:msgId,parse_mode:'Markdown'}); return;
  }
  if(data.startsWith('signal_')){
    if(String(chatId)!==String(ADMIN_ID)) return bot.answerCallbackQuery(query.id,{text:'Admin only!'});
    await bot.answerCallbackQuery(query.id,{text:'Preparing...'});
    const ca=data.replace('signal_','');
    const p=await getTokenData(ca);
    if(!p) return bot.sendMessage(ADMIN_ID,'❌ Token not found!');
    const rug=await getRugcheck(ca), analysis=calcTokenStrength(p,rug);
    await sendSignalForReview(ca,p,rug,analysis,false); return;
  }
  if(data.startsWith('refresh_')){
    const ca=data.replace('refresh_','');
    await bot.answerCallbackQuery(query.id,{text:'Refreshing...'});
    try{await bot.deleteMessage(chatId,msgId);}catch(_){}
    await sendAnalysis(chatId,ca,username); return;
  }
  if(data.startsWith('pnl_')){await bot.answerCallbackQuery(query.id,{text:'Generating...'}); await sendPnl(chatId,data.replace('pnl_',''),username); return;}
  if(data==='delete'){await bot.deleteMessage(chatId,msgId);await bot.answerCallbackQuery(query.id,{text:'Deleted!'});return;}
  if(data==='prompt_analyze'){await bot.answerCallbackQuery(query.id);bot.sendMessage(chatId,'Send any Solana CA!');return;}
  if(data==='prompt_price'){await bot.answerCallbackQuery(query.id);bot.sendMessage(chatId,'Use: /price solana');return;}
});

// ═══════════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════════
cleanOldPending();
clearScannedTokens();

console.log('================================');
console.log('  YakubuWeb3Bot — STARTED');
console.log('  Age: '+MIN_AGE_HOURS+'-'+MAX_AGE_HOURS+'h | MC: $'+MIN_MC/1000+'K-$'+MAX_MC/1000+'K');
console.log('  Score: '+SCORE_PASS_MIN+'+ | Scan: 15mins');
console.log('================================');

bot.sendMessage(ADMIN_ID,
  '🚀 *Bot Started!*\n\n' +
  '⏰ Age: '+MIN_AGE_HOURS+'-'+MAX_AGE_HOURS+'h\n' +
  '💊 MC: '+fmt(MIN_MC)+' - '+fmt(MAX_MC)+'\n' +
  '🔄 Scan: every 15 mins\n' +
  '🔥 New: /trending command!\n\n' +
  'First scan in 1 minute...',
  {parse_mode:'Markdown'}
);

setTimeout(()=>runScan(false), 60*1000);
setInterval(()=>runScan(false), SCAN_INTERVAL_MS);
setInterval(checkOpenTrades, 10*60*1000);
scheduleWeeklyReport();
