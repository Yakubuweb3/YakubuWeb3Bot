require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const Jimp = require('jimp');
const Database = require('better-sqlite3');
const fs = require('fs');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// DATABASE
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
    timestamp INTEGER,
    UNIQUE(chat_id, ca)
  )
`);

function saveSnapshot(chatId, ca, price, mc, name, symbol) {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO snapshots (chat_id, ca, price, mc, name, symbol, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(String(chatId), ca, price, mc, name, symbol, Date.now());
  } catch(e) { console.error('DB error:', e); }
}

function getSnapshot(chatId, ca) {
  try {
    return db.prepare(`
      SELECT * FROM snapshots WHERE chat_id = ? AND ca = ?
    `).get(String(chatId), ca);
  } catch(e) { return null; }
}

// FORMAT
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

// PNL IMAGE
async function generatePnlImage(data) {
  const {
    name, symbol, entryMc, currentMc,
    entryPrice, currentPrice, pnlPct,
    multiplier, isProfit, username, entryTime
  } = data;

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

  const pnlText = `${isProfit ? '+' : ''}${pnlPct.toFixed(1)}%`;
  img.print(font64, 40, 90, pnlText);

  img.print(font32, 40, 175, `${multiplier.toFixed(2)}x`);

  img.print(font16, 40, 240, `Entry MC:   ${fmt(entryMc)}`);
  img.print(font16, 40, 265, `Current MC: ${fmt(currentMc)}`);
  img.print(font16, 40, 295, `Entry Price:   ${fmtPrice(entryPrice)}`);
  img.print(font16, 40, 320, `Current Price: ${fmtPrice(currentPrice)}`);

  const timeAgo = Math.floor((Date.now() - entryTime) / 60000);
  const timeStr = timeAgo < 60
    ? `${timeAgo}m ago`
    : `${Math.floor(timeAgo / 60)}h ${timeAgo % 60}m ago`;

  img.print(font16, 40, 360, `Called: ${timeStr}`);
  img.print(font16, 40, 390, `@${username || 'Anonymous'}`);
  img.print(font16, W - 220, H - 25, '@YakubuWeb3Bot');

  const filePath = `/tmp/pnl_${Date.now()}.png`;
  await img.writeAsync(filePath);
  return filePath;
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
  const dexPaid = p.boosts ? '✅ Paid' : '❌ Not Paid';

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

  // HOLDERS FIX
  let holdersCount = 'N/A';
  let top10 = 'N/A';
  let top20 = 'N/A';

  if (rug) {
    riskScore = rug.score || 0;
    riskLevel = riskScore >= 800 ? '🔴 HIGH' : riskScore >= 500 ? '🟡 MEDIUM' : '🟢 LOW';

    if (rug.markets?.length > 0) {
      const maxMc = Math.max(...rug.markets.map(m => m.marketCap || 0));
      if (maxMc > 0) athMc = fmt(maxMc);
    }

    // ROBUST HOLDERS FIX
    const holdersData =
      rug?.topHolders ||
      rug?.holders ||
      rug?.data?.holders ||
      [];

    if (Array.isArray(holdersData) && holdersData.length > 0) {
      const list = holdersData
        .map(h => ({
          address: h.address || '',
          pct: Number(h.pct || h.percentage || h.share || 0)
        }))
        .filter(h => h.address && h.pct > 0 && h.pct < 50)
        .sort((a, b) => b.pct - a.pct);

      if (list.length > 0) {
        holdersCount = rug?.tokenMeta?.holderCount
          ? rug.tokenMeta.holderCount.toLocaleString()
          : list.length + '+';

        const t10 = list.slice(0, 10).reduce((a, b) => a + b.pct, 0);
        const t20 = list.slice(0, 20).reduce((a, b) => a + b.pct, 0);
        top10 = Math.min(t10, 100).toFixed(1) + '%';
        top20 = Math.min(t20, 100).toFixed(1) + '%';
      }
    }

    // DEV
    if (rug.creator) {
      const devBal = rug.creatorBalance
        ? (rug.creatorBalance / 1e9).toFixed(1) + ' SOL'
        : '0 SOL';
      const holdersData2 = rug?.topHolders || [];
      const devH = holdersData2.find(h => h.address === rug.creator);
      const devPct = devH ? devH.pct?.toFixed(1) + '%' : '0%';
      devInfo = `${devBal} • ${devPct}`;
    }

    // BUNDLES
    if (rug.insiderNetworks?.length > 0) {
      const count = rug.insiderNetworks.length;
      const bPct = rug.insiderNetworks
        .reduce((a, b) => a + (b.holdingPercent || 0), 0);
      const nPct = rug.insiderNetworks
        .reduce((a, b) => a + (b.currentHoldingPercent || 0), 0);
      const warn = bPct > 20 ? ' ⚠️' : '';
      bundleInfo = `${count} bundles • ${bPct.toFixed(1)}% bought • ${nPct.toFixed(1)}% now${warn}`;
    }

    // SNIPERS
    if (rug.snipers?.length > 0) {
      const count = rug.snipers.length;
      const bPct = rug.snipers
        .reduce((a, b) => a + (b.holdingPercent || 0), 0);
      const nPct = rug.snipers
        .reduce((a, b) => a + (b.currentHoldingPercent || 0), 0);
      sniperInfo = `${count} snipers • ${bPct.toFixed(1)}% bought • ${nPct.toFixed(1)}% now`;
    }

    // RISKS
    if (rug.risks?.length > 0) {
      risks = '';
      rug.risks.slice(0, 3).forEach(r => {
        const icon = r.level === 'danger' ? '🔴'
          : r.level === 'warn' ? '⚠️' : '📝';
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

🛡️ *Risk:* ${riskScore} — ${riskLevel}
⚠️ *Flags:*
${risks}
📋 \`${ca}\`
_💰 /pnl ${ca}_`;
}

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
    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: '🔄 Refresh', callback_data: `refresh_${ca}` },
          { text: '🗑️ Delete', callback_data: 'delete' },
          { text: '📈 Chart', url: `https://dexscreener.com/solana/${ca}` }
        ],[
          { text: '💰 PNL Card', callback_data: `pnl_${ca}` }
        ]]
      }
    });
  } catch(e) {
    try { await bot.deleteMessage(chatId, loadMsg.message_id); } catch(err) {}
    bot.sendMessage(chatId, '❌ Error! Try again.');
    console.error(e);
  }
}

async function sendPnl(chatId, ca, username) {
  const snap = getSnapshot(chatId, ca);
  if (!snap) {
    return bot.sendMessage(chatId,
      `❌ No entry found!\n\nSend the CA first to record your entry price.`
    );
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
      name: snap.name,
      symbol: snap.symbol,
      entryMc,
      currentMc,
      entryPrice,
      currentPrice,
      pnlPct,
      multiplier,
      isProfit,
      username: username || 'Anonymous',
      entryTime: snap.timestamp
    });

    await bot.deleteMessage(chatId, loadMsg.message_id);

    const caption = `💰 *PNL — ${snap.name} (${snap.symbol})*\n\n` +
      `📥 Entry MC: ${fmt(entryMc)}\n` +
      `📤 Current MC: ${fmt(currentMc)}\n` +
      `${isProfit ? '🟢' : '🔴'} PNL: ${isProfit ? '+' : ''}${pnlPct.toFixed(1)}%\n` +
      `✖️ Multiplier: ${multiplier.toFixed(2)}x\n\n` +
      `_Powered by @YakubuWeb3Bot_`;

    await bot.sendPhoto(chatId, imgPath, {
      caption,
      parse_mode: 'Markdown'
    });

    fs.unlinkSync(imgPath);

  } catch(e) {
    try { await bot.deleteMessage(chatId, loadMsg.message_id); } catch(err) {}
    bot.sendMessage(chatId, '❌ Error generating PNL!');
    console.error(e);
  }
}

// COMMANDS
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
  bot.sendMessage(msg.chat.id, `
📋 *Commands:*

Send CA directly — Analyze token
/pnl <CA> — PNL Card
/price <symbol> — Price
/start — Main Menu
  `, { parse_mode: 'Markdown' });
});

bot.onText(/\/analyze (.+)/, async (msg, match) => {
  await sendAnalysis(msg.chat.id, match[1].trim(), msg.from?.username);
});

bot.onText(/\/pnl (.+)/, async (msg, match) => {
  await sendPnl(msg.chat.id, match[1].trim(), msg.from?.username);
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

  if (data.startsWith('refresh_')) {
    const ca = data.replace('refresh_', '');
    await bot.answerCallbackQuery(query.id, { text: '🔄 Refreshing...' });
    try {
      const p = await getTokenData(ca);
      if (!p) return;
      const text = await formatMsg(p, ca, chatId);
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [[
            { text: '🔄 Refresh', callback_data: `refresh_${ca}` },
            { text: '🗑️ Delete', callback_data: 'delete' },
            { text: '📈 Chart', url: `https://dexscreener.com/solana/${ca}` }
          ],[
            { text: '💰 PNL Card', callback_data: `pnl_${ca}` }
          ]]
        }
      });
    } catch(e) {
      bot.answerCallbackQuery(query.id, { text: '❌ Error!' });
    }
  }

  if (data.startsWith('pnl_')) {
    const ca = data.replace('pnl_', '');
    await bot.answerCallbackQuery(query.id, { text: '💰 Generating PNL...' });
    await sendPnl(chatId, ca, username);
  }

  if (data === 'delete') {
    await bot.deleteMessage(chatId, msgId);
    await bot.answerCallbackQuery(query.id, { text: '🗑️ Deleted!' });
  }

  if (data === 'prompt_analyze') {
    await bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, '📋 Just send the CA directly!');
  }

  if (data === 'prompt_price') {
    await bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, '💰 Send: `/price bitcoin`', { parse_mode: 'Markdown' });
  }
});

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
