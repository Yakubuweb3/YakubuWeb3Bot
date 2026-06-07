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
      { headers: { 'X-API-KEY': 'public', 'x-chain': 'solana' }, timeout: 5000 }
    );
    if (res.data?.data?.holder && res.data.data.holder > 0) return res.data.data.holder.toLocaleString();
  } catch(e) {}
  try {
    const res = await axios.get(
      `https://api.solscan.io/v2/token/holders?address=${ca}&page=1&page_size=1`,
      { headers: { 'Accept': 'application/json' }, timeout: 5000 }
    );
    if (res.data?.data?.total) return res.data.data.total.toLocaleString();
  } catch(e) {}
  if (rugData?.topHolders?.length) return rugData.topHolders.length + '+';
  return 'N/A';
}

// ─── RUG SCORE BADGE ──────────────────────────────────────
function getRugBadge(riskScore) {
  if (riskScore === 'N/A') return '⚪ UNKNOWN';
  const score = Number(riskScore);
  if (score >= 800) return '🔴 HIGH RISK';
  if (score >= 500) return '🟡 MODERATE RISK';
  return '🟢 SAFE';
}

// ─── FORMAT FULL ANALYSIS ─────────────────────────────────
async function formatMsg(p, ca, chatId) {
  const name = p.baseToken.name;
  const symbol = p.baseToken.symbol;
  const price = parseFloat(p.priceUsd) || 0;
  const mc = p.fdv || 0;

  saveSnapshot(chatId, ca, price, mc, name, symbol);

  const vol24 = fmt(p.volume?.h24);
  const vol6 = fmt(p.volume?.h6);
  const vol1 = fmt(p.volume?.h1);
  const ch24 = fmtChange(p.priceChange?.h24);
  const ch6 = fmtChange(p.priceChange?.h6);
  const ch1 = fmtChange(p.priceChange?.h1);
  const created = p.pairCreatedAt
    ? Math.floor((Date.now() - p.pairCreatedAt) / 86400000) + 'd ago'
    : 'N/A';
  const chain = (p.chainId || '').toUpperCase();
  const dex = p.dexId || 'N/A';
  const buys = p.txns?.h24?.buys || 0;
  const sells = p.txns?.h24?.sells || 0;
  const dexPaid = checkDexPaid(p);

  let socials = '';
  if (p.info?.websites?.length > 0) socials += `🌐 [Web](${p.info.websites[0].url}) `;
  if (p.info?.socials?.length > 0) {
    p.info.socials.forEach(s => {
      if (s.type === 'twitter') socials += `🐦 [X](${s.url}) `;
      if (s.type === 'telegram') socials += `✈️ [TG](${s.url}) `;
    });
  }
  if (!socials) socials = '❌ No socials';

  const rug = await getRugcheck(ca);
  let riskScore = 'N/A', riskLevel = 'N/A';
  let bundleInfo = '✅ No bundles';
  let sniperInfo = '✅ No snipers';
  let athMc = 'N/A';
  let risks = '✅ Clean';
  let devInfo = 'N/A';
  let holdersCount = 'N/A';
  let top10 = 'N/A';
  let top20 = 'N/A';

  if (rug) {
    riskScore = rug.score || 0;
    riskLevel = getRugBadge(riskScore);

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
        const t10 = list.slice(0, 10).reduce((a, b) => a + b.pct, 0);
        const t20 = list.slice(0, 20).reduce((a, b) => a + b.pct, 0);
        top10 = Math.min(t10, 100).toFixed(1) + '%';
        top20 = Math.min(t20, 100).toFixed(1) + '%';
      }
    }

    if (rug.creator) {
      const devBal = rug.creatorBalance ? (rug.creatorBalance / 1e9).toFixed(1) + ' SOL' : '0 SOL';
      const devH = (rug?.topHolders || []).find(h => h.address === rug.creator);
      const devPct = devH ? devH.pct?.toFixed(1) + '%' : '0%';
      devInfo = `${devBal} • ${devPct}`;
    }

    if (rug.insiderNetworks?.length > 0) {
      const count = rug.insiderNetworks.length;
      const bPct = rug.insiderNetworks.reduce((a, b) => a + (b.holdingPercent || 0), 0);
      const nPct = rug.insiderNetworks.reduce((a, b) => a + (b.currentHoldingPercent || 0), 0);
      const warn = bPct > 20 ? ' ⚠️' : '';
      bundleInfo = `${count} bundles • ${bPct.toFixed(1)}% bought • ${nPct.toFixed(1)}% now${warn}`;
    }

    if (rug.snipers?.length > 0) {
      const count = rug.snipers.length;
      const bPct = rug.snipers.reduce((a, b) => a + (b.holdingPercent || 0), 0);
      const nPct = rug.snipers.reduce((a, b) => a + (b.currentHoldingPercent || 0), 0);
      sniperInfo = `${count} snipers • ${bPct.toFixed(1)}% bought • ${nPct.toFixed(1)}% now`;
    }

    if (rug.risks?.length > 0) {
      risks = '';
      rug.risks.slice(0, 3).forEach(r => {
        const icon = r.level === 'danger' ? '🔴' : r.level === 'warn' ? '⚠️' : '📝';
        risks += `${icon} ${r.name}\n`;
      });
    }
  }

  return `🔍 *${name}* (${symbol})
🔗 ${chain} | 🏦 ${dex} | ⏰ ${created}

💰 *Price:* ${fmtPrice(price)}
💊 *MC:* ${fmt(mc)} | 💧 *Liq:* ${fmt(p.liquidity?.usd)}
🏆 *ATH MC:* ${athMc}

📈 *Volume:*
├ 24h: ${vol24}
├ 6h: ${vol6}
└ 1h: ${vol1}

📉 *Change:*
├ 24h: ${ch24}
├ 6h: ${ch6}
└ 1h: ${ch1}

🛒 *Buys:* ${buys} | 🔴 *Sells:* ${sells}
⚡ *Dex:* ${dexPaid}
🔗 *Socials:* ${socials}

👥 *Holders:* ${holdersCount}
├ Top 10: ${top10}
└ Top 20: ${top20}
🔧 *Dev:* ${devInfo}

📦 *Bundles:* ${bundleInfo}
🎯 *Snipers:* ${sniperInfo}

🛡️ *Risk Score:* ${riskScore} — ${riskLevel}
⚠️ *Flags:*
${risks}
📋 \`${ca}\`
_💰 /pnl ${ca}_`;
}

// ─── FORMAT SIGNAL POST (for channel) ────────────────────
function formatSignalPost(p, ca, rug) {
  const name = p.baseToken.name;
  const symbol = p.baseToken.symbol;
  const price = parseFloat(p.priceUsd) || 0;
  const mc = p.fdv || 0;
  const liq = p.liquidity?.usd || 0;
  const vol24 = fmt(p.volume?.h24);
  const ch1 = fmtChange(p.priceChange?.h1);
  const ch24 = fmtChange(p.priceChange?.h24);
  const buys = p.txns?.h24?.buys || 0;
  const sells = p.txns?.h24?.sells || 0;
  const chain = (p.chainId || '').toUpperCase();

  let riskScore = 'N/A';
  let rugBadge = '⚪ UNKNOWN';
  if (rug) {
    riskScore = rug.score || 0;
    rugBadge = getRugBadge(riskScore);
  }

  let socials = '';
  if (p.info?.websites?.length > 0) socials += `🌐 [Web](${p.info.websites[0].url}) `;
  if (p.info?.socials?.length > 0) {
    p.info.socials.forEach(s => {
      if (s.type === 'twitter') socials += `🐦 [X](${s.url}) `;
      if (s.type === 'telegram') socials += `✈️ [TG](${s.url}) `;
    });
  }
  if (!socials) socials = '❌ No socials';

  return `📡 *SIGNAL ALERT* — @YakubuWeb3

🪙 *${name}* (${symbol}) | ${chain}

💰 Price: ${fmtPrice(price)}
💊 MC: ${fmt(mc)} | 💧 Liq: ${fmt(liq)}

📈 Change:
├ 1h: ${ch1}
└ 24h: ${ch24}

📊 Vol 24h: ${vol24}
🛒 Buys: ${buys} | 🔴 Sells: ${sells}

🛡️ Rug Score: ${riskScore} — ${rugBadge}

🔗 Socials: ${socials}

📋 CA: \`${ca}\`
📈 [Chart](https://dexscreener.com/solana/${ca}) | 🤖 [Analyze](https://t.me/YakubuWeb3Bot?start=${ca})

⚠️ _DYOR — Not financial advice_
_Signal by @YakubuWeb3_`;
}

// ─── SEND ANALYSIS (to user) ──────────────────────────────
async function sendAnalysis(chatId, ca, username) {
  const loadMsg = await bot.sendMessage(chatId, '⏳ Analyzing token...');
  try {
    const p = await getTokenData(ca);
    if (!p) {
      await bot.deleteMessage(chatId, loadMsg.message_id);
      return bot.sendMessage(chatId, '❌ Token not found!');
    }
    const text = await formatMsg(p, ca, chatId);
    await bot.deleteMessage(chatId, loadMsg.message_id);

    // If admin is analyzing — add "Send as Signal" button
    const isAdmin = String(chatId) === String(ADMIN_ID);
    const keyboard = isAdmin
      ? [[
          { text: '🔄 Refresh', callback_data: `refresh_${ca}` },
          { text: '🗑️ Delete', callback_data: 'delete' },
          { text: '📈 Chart', url: `https://dexscreener.com/solana/${ca}` }
        ],[
          { text: '💰 PNL Card', callback_data: `pnl_${ca}` },
          { text: '📡 Send as Signal', callback_data: `signal_${ca}` }
        ]]
      : [[
          { text: '🔄 Refresh', callback_data: `refresh_${ca}` },
          { text: '🗑️ Delete', callback_data: 'delete' },
          { text: '📈 Chart', url: `https://dexscreener.com/solana/${ca}` }
        ],[
          { text: '💰 PNL Card', callback_data: `pnl_${ca}` }
        ]];

    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch(e) {
    try { await bot.deleteMessage(chatId, loadMsg.message_id); } catch(err) {}
    bot.sendMessage(chatId, '❌ Error! Try again.');
    console.error(e);
  }
}

// ─── SEND SIGNAL TO ADMIN FOR REVIEW ─────────────────────
async function sendSignalForReview(ca) {
  const loadMsg = await bot.sendMessage(ADMIN_ID, '⏳ Preparing signal for review...');
  try {
    const p = await getTokenData(ca);
    if (!p) {
      await bot.deleteMessage(ADMIN_ID, loadMsg.message_id);
      return bot.sendMessage(ADMIN_ID, '❌ Token not found!');
    }
    const rug = await getRugcheck(ca);
    const signalText = formatSignalPost(p, ca, rug);

    // Save to pending
    pendingSignals[ca] = { p, rug, signalText };

    await bot.deleteMessage(ADMIN_ID, loadMsg.message_id);

    // Preview to admin
    await bot.sendMessage(ADMIN_ID,
      `👁️ *SIGNAL PREVIEW*\n\nReview below then approve or reject:\n\n${signalText}`,
      {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ APPROVE — Post to Channel', callback_data: `approve_${ca}` },
            { text: '❌ REJECT', callback_data: `reject_${ca}` }
          ]]
        }
      }
    );
  } catch(e) {
    try { await bot.deleteMessage(ADMIN_ID, loadMsg.message_id); } catch(err) {}
    bot.sendMessage(ADMIN_ID, '❌ Error preparing signal!');
    console.error(e);
  }
}

// ─── POST SIGNAL TO CHANNEL ───────────────────────────────
async function postSignalToChannel(ca, msgId) {
  const pending = pendingSignals[ca];
  if (!pending) {
    return bot.sendMessage(ADMIN_ID, '❌ Signal expired! Re-analyze the token.');
  }

  try {
    await bot.sendMessage(CHANNEL_ID, pending.signalText, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: '📈 Chart', url: `https://dexscreener.com/solana/${ca}` },
          { text: '🤖 Analyze', url: `https://t.me/YakubuWeb3Bot?start=${ca}` }
        ]]
      }
    });

    delete pendingSignals[ca];

    // Update admin message
    await bot.editMessageText(
      `✅ *Signal posted to channel!*\n\n${pending.signalText}`,
      {
        chat_id: ADMIN_ID,
        message_id: msgId,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      }
    );

    bot.sendMessage(ADMIN_ID, '🎉 Signal posted successfully!');
  } catch(e) {
    bot.sendMessage(ADMIN_ID, '❌ Failed to post to channel! Check bot is admin in channel.');
    console.error(e);
  }
}

// ─── PNL IMAGE ────────────────────────────────────────────
async function generatePnlImage(data) {
  const { name, symbol, entryMc, currentMc, entryPrice, currentPrice, pnlPct, multiplier, isProfit, username, entryTime } = data;

  const W = 800, H = 450;
  const img = new Jimp(W, H, isProfit ? 0x0a2a1aff : 0x2a0a0aff);

  const borderColor = isProfit ? 0x00ff88ff : 0xff4444ff;
  for (let x = 0; x < W; x++) {
    for (let t = 0; t < 4; t++) {
      img.setPixelColor(borderColor, x, t);
      img.setPixelColor(borderColor, x, H - 1 - t);
    }
  }
  for (let y = 0; y < H; y++) {
    for (let t = 0; t < 4; t++) {
      img.setPixelColor(borderColor, t, y);
      img.setPixelColor(borderColor, W - 1 - t, y);
    }
  }

  const font64 = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
  const font32 = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
  const font16 = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);

  img.print(font32, 40, 35, `${name} (${symbol})`);
  img.print(font64, 40, 90, `${isProfit ? '+' : ''}${pnlPct.toFixed(1)}%`);
  img.print(font32, 40, 175, `${multiplier.toFixed(2)}x`);
  img.print(font16, 40, 240, `Entry MC:      ${fmt(entryMc)}`);
  img.print(font16, 40, 265, `Current MC:    ${fmt(currentMc)}`);
  img.print(font16, 40, 295, `Entry Price:   ${fmtPrice(entryPrice)}`);
  img.print(font16, 40, 320, `Current Price: ${fmtPrice(currentPrice)}`);

  const timeAgo = Math.floor((Date.now() - entryTime) / 60000);
  const timeStr = timeAgo < 60 ? `${timeAgo}m ago` : `${Math.floor(timeAgo / 60)}h ${timeAgo % 60}m ago`;

  img.print(font16, 40, 360, `Called: ${timeStr}`);
  img.print(font16, 40, 390, `@${username || 'Anonymous'}`);
  img.print(font16, W - 220, H - 25, '@YakubuWeb3Bot');

  const filePath = `/tmp/pnl_${Date.now()}.png`;
  await img.writeAsync(filePath);
  return filePath;
}

async function sendPnl(chatId, ca, username) {
  const snap = getSnapshot(chatId, ca);
  if (!snap) {
    return bot.sendMessage(chatId, `❌ No entry found!\n\nSend the CA first to record entry price.`);
  }

  const loadMsg = await bot.sendMessage(chatId, '⏳ Generating PNL card...');
  try {
    const p = await getTokenData(ca);
    if (!p) {
      await bot.deleteMessage(chatId, loadMsg.message_id);
      return bot.sendMessage(chatId, '❌ Token not found!');
    }

    const currentPrice = parseFloat(p.priceUsd) || 0;
    const currentMc = p.fdv || 0;
    const entryPrice = snap.price;
    const entryMc = snap.mc;
    const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
    const multiplier = currentPrice / entryPrice;
    const isProfit = pnlPct >= 0;

    const imgPath = await generatePnlImage({
      name: snap.name, symbol: snap.symbol,
      entryMc, currentMc, entryPrice, currentPrice,
      pnlPct, multiplier, isProfit,
      username: username || 'Anonymous',
      entryTime: snap.timestamp
    });

    await bot.deleteMessage(chatId, loadMsg.message_id);

    const caption =
      `💰 *PNL — ${snap.name} (${snap.symbol})*\n\n` +
      `📥 Entry MC: ${fmt(entryMc)}\n` +
      `📤 Current MC: ${fmt(currentMc)}\n` +
      `${isProfit ? '🟢' : '🔴'} PNL: ${isProfit ? '+' : ''}${pnlPct.toFixed(1)}%\n` +
      `✖️ Multiplier: ${multiplier.toFixed(2)}x\n\n` +
      `_Powered by @YakubuWeb3Bot_`;

    await bot.sendPhoto(chatId, imgPath, { caption, parse_mode: 'Markdown' });
    fs.unlinkSync(imgPath);
  } catch(e) {
    try { await bot.deleteMessage(chatId, loadMsg.message_id); } catch(err) {}
    bot.sendMessage(chatId, '❌ Error generating PNL!');
    console.error(e);
  }
}

// ─── COMMANDS ─────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `
🚀 *YakubuWeb3 Solana Bot*

Send any *Solana CA* directly to analyze!

/pnl <CA> — PNL Card
/price <symbol> — Price Check
/help — Commands

_Powered by @YakubuWeb3_
  `, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '📊 Analyze', callback_data: 'prompt_analyze' },
        { text: '💰 Price', callback_data: 'prompt_price' }
      ]]
    }
  });
});

bot.onText(/\/help/, (msg) => {
  const isAdmin = String(msg.chat.id) === String(ADMIN_ID);
  const adminCmds = isAdmin ? `\n\n👑 *Admin Commands:*\n/signal <CA> — Review & post signal\n/pending — View pending signals` : '';
  bot.sendMessage(msg.chat.id, `
📋 *Commands:*

Send CA directly — Analyze
/pnl <CA> — PNL Card
/price <symbol> — Price
/start — Menu${adminCmds}
  `, { parse_mode: 'Markdown' });
});

bot.onText(/\/analyze (.+)/, async (msg, match) => {
  await sendAnalysis(msg.chat.id, match[1].trim(), msg.from?.username);
});

bot.onText(/\/pnl (.+)/, async (msg, match) => {
  await sendPnl(msg.chat.id, match[1].trim(), msg.from?.username);
});

// Admin: /signal <CA> — send for review
bot.onText(/\/signal (.+)/, async (msg, match) => {
  if (String(msg.chat.id) !== String(ADMIN_ID)) {
    return bot.sendMessage(msg.chat.id, '❌ Admin only command!');
  }
  await sendSignalForReview(match[1].trim());
});

// Admin: /pending — show pending signals
bot.onText(/\/pending/, (msg) => {
  if (String(msg.chat.id) !== String(ADMIN_ID)) return;
  const keys = Object.keys(pendingSignals);
  if (keys.length === 0) {
    return bot.sendMessage(ADMIN_ID, '📭 No pending signals.');
  }
  bot.sendMessage(ADMIN_ID, `📋 *Pending signals:*\n\n${keys.map((k, i) => `${i+1}. \`${k}\``).join('\n')}`, { parse_mode: 'Markdown' });
});

// ─── MESSAGES ─────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  if (text.startsWith('/')) return;
  const ca = text.trim();
  if (ca.length >= 32 && ca.length <= 44 && /^[A-Za-z0-9]+$/.test(ca)) {
    await sendAnalysis(chatId, ca, msg.from?.username);
  }
});

// ─── CALLBACK QUERIES ─────────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const data = query.data;
  const username = query.from?.username;

  // ── Admin: Send as Signal ──
  if (data.startsWith('signal_')) {
    if (String(chatId) !== String(ADMIN_ID)) {
      return bot.answerCallbackQuery(query.id, { text: '❌ Admin only!' });
    }
    const ca = data.replace('signal_', '');
    await bot.answerCallbackQuery(query.id, { text: '📡 Preparing signal preview...' });
    await sendSignalForReview(ca);
    return;
  }

  // ── Admin: Approve Signal ──
  if (data.startsWith('approve_')) {
    if (String(chatId) !== String(ADMIN_ID)) {
      return bot.answerCallbackQuery(query.id, { text: '❌ Admin only!' });
    }
    const ca = data.replace('approve_', '');
    await bot.answerCallbackQuery(query.id, { text: '✅ Posting to channel...' });
    await postSignalToChannel(ca, msgId);
    return;
  }

  // ── Admin: Reject Signal ──
  if (data.startsWith('reject_')) {
    if (String(chatId) !== String(ADMIN_ID)) {
      return bot.answerCallbackQuery(query.id, { text: '❌ Admin only!' });
    }
    const ca = data.replace('reject_', '');
    delete pendingSignals[ca];
    await bot.answerCallbackQuery(query.id, { text: '❌ Signal rejected!' });
    await bot.editMessageText(`❌ *Signal rejected.*\n\nCA: \`${ca}\``, {
      chat_id: ADMIN_ID,
      message_id: msgId,
      parse_mode: 'Markdown'
    });
    return;
  }

  // ── Refresh ──
  if (data.startsWith('refresh_')) {
    const ca = data.replace('refresh_', '');
    await bot.answerCallbackQuery(query.id, { text: '🔄 Refreshing...' });
    try {
      const p = await getTokenData(ca);
      if (!p) return;
      const text = await formatMsg(p, ca, chatId);
      const isAdmin = String(chatId) === String(ADMIN_ID);
      const keyboard = isAdmin
        ? [[
            { text: '🔄 Refresh', callback_data: `refresh_${ca}` },
            { text: '🗑️ Delete', callback_data: 'delete' },
            { text: '📈 Chart', url: `https://dexscreener.com/solana/${ca}` }
          ],[
            { text: '💰 PNL Card', callback_data: `pnl_${ca}` },
            { text: '📡 Send as Signal', callback_data: `signal_${ca}` }
          ]]
        : [[
            { text: '🔄 Refresh', callback_data: `refresh_${ca}` },
            { text: '🗑️ Delete', callback_data: 'delete' },
            { text: '📈 Chart', url: `https://dexscreener.com/solana/${ca}` }
          ],[
            { text: '💰 PNL Card', callback_data: `pnl_${ca}` }
          ]];

      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: keyboard }
      });
    } catch(e) {
      bot.answerCallbackQuery(query.id, { text: '❌ Error!' });
    }
    return;
  }

  // ── PNL ──
  if (data.startsWith('pnl_')) {
    const ca = data.replace('pnl_', '');
    await bot.answerCallbackQuery(query.id, { text: '💰 Generating PNL...' });
    await sendPnl(chatId, ca, username);
    return;
  }

  // ── Delete ──
  if (data === 'delete') {
    await bot.deleteMessage(chatId, msgId);
    await bot.answerCallbackQuery(query.id, { text: '🗑️ Deleted!' });
    return;
  }

  if (data === 'prompt_analyze') {
    await bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, '📋 Just send the CA directly!');
    return;
  }

  if (data === 'prompt_price') {
    await bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, '💰 Send: `/price bitcoin`', { parse_mode: 'Markdown' });
    return;
  }
});

// ─── PRICE ────────────────────────────────────────────────
bot.onText(/\/price (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const symbol = match[1].trim().toLowerCase();
  const loadMsg = await bot.sendMessage(chatId, '⏳ Fetching price...');
  try {
    const res = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${symbol}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`
    );
    const data = res.data[symbol];
    if (!data) {
      await bot.deleteMessage(chatId, loadMsg.message_id);
      return bot.sendMessage(chatId, '❌ Coin not found!');
    }
    await bot.deleteMessage(chatId, loadMsg.message_id);
    bot.sendMessage(chatId, `
💰 *${symbol.toUpperCase()}*

💵 *Price:* ${fmtPrice(data.usd)}
📊 *MC:* ${fmt(data.usd_market_cap)}
📈 *Vol (24h):* ${fmt(data.usd_24h_vol)}
${fmtChange(data.usd_24h_change)} *(24h)*

_Powered by @YakubuWeb3_
    `, { parse_mode: 'Markdown' });
  } catch(e) {
    await bot.deleteMessage(chatId, loadMsg.message_id);
    bot.sendMessage(chatId, '❌ Error!');
  }
});

console.log('✅ YakubuWeb3Bot is running!');
