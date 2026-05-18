require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

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

async function getRugcheckData(ca) {
  try {
    const res = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${ca}/report`);
    return res.data;
  } catch (e) {
    return null;
  }
}

async function formatMsg(p, ca) {
  const name = p.baseToken.name;
  const symbol = p.baseToken.symbol;
  const price = fmtPrice(p.priceUsd);
  const mc = fmt(p.fdv);
  const liq = fmt(p.liquidity?.usd);
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

  // SOCIALS
  let socials = '';
  if (p.info?.websites?.length > 0) {
    socials += `🌐 [Web](${p.info.websites[0].url}) `;
  }
  if (p.info?.socials?.length > 0) {
    p.info.socials.forEach(s => {
      if (s.type === 'twitter') socials += `🐦 [X](${s.url}) `;
      if (s.type === 'telegram') socials += `✈️ [TG](${s.url}) `;
      if (s.type === 'discord') socials += `💬 [Discord](${s.url}) `;
    });
  }
  if (!socials) socials = '❌ No socials';

  // DEX PAID
  const dexPaid = p.boosts ? '✅ Paid' : '❌ Not Paid';

  // RUGCHECK DATA
  const rug = await getRugcheckData(ca);

  let riskScore = 'N/A';
  let riskLevel = 'N/A';
  let topHolders = 'N/A';
  let devHolding = 'N/A';
  let bundleInfo = 'N/A';
  let snipers = 'N/A';
  let insiderPct = 'N/A';
  let athMc = 'N/A';
  let risks = '';

  if (rug) {
    // RISK SCORE
    riskScore = rug.score || 'N/A';
    if (rug.score >= 800) riskLevel = '🔴 HIGH RISK';
    else if (rug.score >= 500) riskLevel = '🟡 MEDIUM RISK';
    else riskLevel = '🟢 LOW RISK';

    // ATH MC
    if (rug.markets && rug.markets.length > 0) {
      const maxMc = Math.max(...rug.markets.map(m => m.marketCap || 0));
      athMc = fmt(maxMc);
    }

    // TOP HOLDERS
    if (rug.topHolders && rug.topHolders.length > 0) {
      const top10 = rug.topHolders.slice(0, 10);
      const top10Pct = top10.reduce((a, b) => a + (b.pct || 0), 0);
      topHolders = `Top 10: ${top10Pct.toFixed(1)}%`;
    }

    // DEV HOLDING
    if (rug.creator) {
      const devHolder = rug.topHolders?.find(h =>
        h.address === rug.creator
      );
      devHolding = devHolder ? `${devHolder.pct?.toFixed(1)}%` : '0%';
    }

    // BUNDLE ANALYSIS
    if (rug.insiderNetworks && rug.insiderNetworks.length > 0) {
      const totalBundled = rug.insiderNetworks.reduce(
        (a, b) => a + (b.holdingPercent || 0), 0
      );
      const bundleCount = rug.insiderNetworks.length;
      bundleInfo = `${bundleCount} bundles • ${totalBundled.toFixed(1)}%`;
      insiderPct = totalBundled.toFixed(1) + '%';
    } else {
      bundleInfo = '✅ No bundles detected';
      insiderPct = '0%';
    }

    // SNIPERS
    if (rug.snipers && rug.snipers.length > 0) {
      const sniperPct = rug.snipers.reduce(
        (a, b) => a + (b.holdingPercent || 0), 0
      );
      snipers = `${rug.snipers.length} snipers • ${sniperPct.toFixed(1)}%`;
    } else {
      snipers = '✅ No snipers';
    }

    // RISKS
    if (rug.risks && rug.risks.length > 0) {
      rug.risks.slice(0, 3).forEach(r => {
        const icon = r.level === 'danger' ? '🔴' : r.level === 'warn' ? '⚠️' : '📝';
        risks += `${icon} ${r.name}\n`;
      });
    } else {
      risks = '✅ No major risks';
    }
  }

  return `🔍 *${name}* (${symbol})
🔗 ${chain} | 🏦 ${dex} | ⏰ ${created}

💰 *Price:* ${price}
💊 *MC:* ${mc} | 💧 *Liq:* ${liq}
🏆 *ATH MC:* ${athMc}

📈 *Volume:*
├ 24h: ${vol24}
├ 6h: ${vol6}
└ 1h: ${vol1}

📉 *Price Change:*
├ 24h: ${ch24}
├ 6h: ${ch6}
└ 1h: ${ch1}

🛒 *Buys (24h):* ${buys} | 🔴 *Sells:* ${sells}

⚡ *Dex:* ${dexPaid}
🔗 *Socials:* ${socials}

👥 *Holders:* ${topHolders}
🔧 *Dev Holding:* ${devHolding}

📦 *Bundle Analysis:*
└ ${bundleInfo}

🎯 *Snipers:*
└ ${snipers}

🛡️ *Risk Score:* ${riskScore} — ${riskLevel}
⚠️ *Risks:*
${risks}

📋 \`${ca}\``;
}

async function sendAnalysis(chatId, ca) {
  const loadMsg = await bot.sendMessage(chatId, '⏳ Analyzing token...');
  try {
    const p = await getTokenData(ca);
    if (!p) {
      await bot.deleteMessage(chatId, loadMsg.message_id);
      return bot.sendMessage(chatId, '❌ Token not found! Check the contract address.');
    }
    const text = await formatMsg(p, ca);
    await bot.deleteMessage(chatId, loadMsg.message_id);
    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: '🔄 Refresh', callback_data: `refresh_${ca}` },
          { text: '🗑️ Delete', callback_data: 'delete' },
          { text: '📈 Chart', url: `https://dexscreener.com/solana/${ca}` }
        ]]
      }
    });
  } catch (e) {
    try { await bot.deleteMessage(chatId, loadMsg.message_id); } catch(err) {}
    bot.sendMessage(chatId, '❌ Error analyzing token. Try again!');
    console.error(e);
  }
}

// START
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `
🚀 *YakubuWeb3 Solana Bot*

*Welcome!* 

Just send any *Solana CA* and I will analyze it instantly!

Or use commands:
/analyze <CA> — Analyze token
/price <symbol> — Check price
/help — All commands

_Powered by @YakubuWeb3_
  `, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '📊 Analyze Token', callback_data: 'prompt_analyze' },
        { text: '💰 Check Price', callback_data: 'prompt_price' }
      ]]
    }
  });
});

// HELP
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `
📋 *Commands:*

Just send a CA directly!
/analyze <CA> — Token Analysis
/price <symbol> — Token Price
/start — Main Menu
  `, { parse_mode: 'Markdown' });
});

// ANALYZE COMMAND
bot.onText(/\/analyze (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const ca = match[1].trim();
  await sendAnalysis(chatId, ca);
});

// AUTO DETECT CA
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  if (text.startsWith('/')) return;
  const ca = text.trim();
  if (ca.length >= 32 && ca.length <= 44 && /^[A-Za-z0-9]+$/.test(ca)) {
    await sendAnalysis(chatId, ca);
  }
});

// CALLBACK BUTTONS
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const data = query.data;

  if (data.startsWith('refresh_')) {
    const ca = data.replace('refresh_', '');
    await bot.answerCallbackQuery(query.id, { text: '🔄 Refreshing...' });
    try {
      const p = await getTokenData(ca);
      if (!p) return bot.answerCallbackQuery(query.id, { text: '❌ Not found!' });
      const text = await formatMsg(p, ca);
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
          ]]
        }
      });
    } catch (e) {
      bot.answerCallbackQuery(query.id, { text: '❌ Error!' });
    }
  }

  if (data === 'delete') {
    await bot.deleteMessage(chatId, msgId);
    await bot.answerCallbackQuery(query.id, { text: '🗑️ Deleted!' });
  }

  if (data === 'prompt_analyze') {
    await bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, '📋 Just send the CA directly!', { parse_mode: 'Markdown' });
  }

  if (data === 'prompt_price') {
    await bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, '💰 Send: `/price bitcoin`', { parse_mode: 'Markdown' });
  }
});

// PRICE
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
    const price = fmtPrice(data.usd);
    const change = fmtChange(data.usd_24h_change);
    const mc = fmt(data.usd_market_cap);
    const vol = fmt(data.usd_24h_vol);
    await bot.deleteMessage(chatId, loadMsg.message_id);
    bot.sendMessage(chatId, `
💰 *${symbol.toUpperCase()}*

💵 *Price:* ${price}
📊 *MC:* ${mc}
📈 *Vol (24h):* ${vol}
${change} *(24h)*

_Powered by @YakubuWeb3_
    `, { parse_mode: 'Markdown' });
  } catch (e) {
    await bot.deleteMessage(chatId, loadMsg.message_id);
    bot.sendMessage(chatId, '❌ Error!');
  }
});

console.log('✅ YakubuWeb3Bot is running!');
