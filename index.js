

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

// FILTER LP AND PROGRAM ADDRESSES
function isLpOrProgram(holder) {
  const addr = holder.address || '';
  // Filter if insider/LP flag is set
  if (holder.insider === true) return true;
  if (holder.isPool === true) return true;
  if (holder.isLp === true) return true;
  // Filter known program addresses
  const known = [
    '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    '11111111111111111111111111111111',
    'So11111111111111111111111111111111111111112',
    'GThUX1Atko4tqhN2NaiTazFAcaPBQ',
    'FEESngU3neckdwib9X3KWqdL',
  ];
  if (known.some(k => addr.startsWith(k))) return true;
  // Filter if % is suspiciously high for single holder
  if ((holder.pct || 0) > 50) return true;
  return false;
}

async function getTokenData(ca) {
  const res = await axios.get(
    `https://api.dexscreener.com/latest/dex/tokens/${ca}`
  );
  const pairs = res.data.pairs;
  if (!pairs || pairs.length === 0) return null;
  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  return pairs[0];
}

async function getRugcheckData(ca) {
  try {
    const res = await axios.get(
      `https://api.rugcheck.xyz/v1/tokens/${ca}/report`
    );
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
      if (s.type === 'discord') socials += `💬 [DC](${s.url}) `;
    });
  }
  if (!socials) socials = '❌ No socials';

  const dexPaid = p.boosts ? '✅ Paid' : '❌ Not Paid';

  // RUGCHECK
  const rug = await getRugcheckData(ca);

  let riskScore = 'N/A';
  let riskLevel = 'N/A';
  let holdersCount = 'N/A';
  let top10Pct = 'N/A';
  let top20Pct = 'N/A';
  let devHolding = '0%';
  let devSol = 'N/A';
  let bundleInfo = '✅ No bundles';
  let sniperInfo = '✅ No snipers';
  let athMc = 'N/A';
  let risks = '✅ Clean';

  if (rug) {
    riskScore = rug.score || 0;
    if (riskScore >= 800) riskLevel = '🔴 HIGH RISK';
    else if (riskScore >= 500) riskLevel = '🟡 MEDIUM RISK';
    else riskLevel = '🟢 LOW RISK';

    // ATH MC
    if (rug.markets && rug.markets.length > 0) {
      const maxMc = Math.max(...rug.markets.map(m => m.marketCap || 0));
      if (maxMc > 0) athMc = fmt(maxMc);
    }

    // HOLDERS — strict filter
    if (rug.topHolders && rug.topHolders.length > 0) {
      // Remove LP/program addresses
      const filtered = rug.topHolders.filter(h => !isLpOrProgram(h));

      // Holders count
      holdersCount = rug.tokenMeta?.holderCount
        ? rug.tokenMeta.holderCount.toLocaleString()
        : 'N/A';

      // Top 10 — max 100%
      const top10 = filtered.slice(0, 10);
      const top20 = filtered.slice(0, 20);
      let t10 = top10.reduce((a, b) => a + (b.pct || 0), 0);
      let t20 = top20.reduce((a, b) => a + (b.pct || 0), 0);
      // Cap at 100%
      t10 = Math.min(t10, 100);
      t20 = Math.min(t20, 100);
      top10Pct = t10.toFixed(1) + '%';
      top20Pct = t20.toFixed(1) + '%';

      // DEV HOLDING
      if (rug.creator) {
        const devH = filtered.find(h => h.address === rug.creator);
        if (devH) devHolding = devH.pct?.toFixed(1) + '%';
      }
    }

    // DEV SOL
    if (rug.creatorBalance !== undefined) {
      devSol = (rug.creatorBalance / 1e9).toFixed(2) + ' SOL';
    }

    // BUNDLES
    if (rug.insiderNetworks && rug.insiderNetworks.length > 0) {
      const count = rug.insiderNetworks.length;
      const boughtPct = rug.insiderNetworks.reduce(
        (a, b) => a + (b.holdingPercent || 0), 0
      );
      const nowPct = rug.insiderNetworks.reduce(
        (a, b) => a + (b.currentHoldingPercent || 0), 0
      );
      const warning = boughtPct > 20 ? ' ⚠️' : '';
      bundleInfo = `${count} bundles • ${boughtPct.toFixed(1)}% bought • ${nowPct.toFixed(1)}% now${warning}`;
    }

    // SNIPERS
    if (rug.snipers && rug.snipers.length > 0) {
      const count = rug.snipers.length;
      const boughtPct = rug.snipers.reduce(
        (a, b) => a + (b.holdingPercent || 0), 0
      );
      const nowPct = rug.snipers.reduce(
        (a, b) => a + (b.currentHoldingPercent || 0), 0
      );
      sniperInfo = `${count} snipers • ${boughtPct.toFixed(1)}% bought • ${nowPct.toFixed(1)}% now`;
    }

    // RISKS
    if (rug.risks && rug.risks.length > 0) {
      risks = '';
      rug.risks.slice(0, 4).forEach(r => {
        const icon = r.level === 'danger' ? '🔴'
          : r.level === 'warn' ? '⚠️' : '📝';
        risks += `${icon} ${r.name}\n`;
      });
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

🛒 *Buys:* ${buys} | 🔴 *Sells:* ${sells}

⚡ *Dex:* ${dexPaid}
🔗 *Socials:* ${socials}

👥 *Holders:* ${holdersCount}
├ Top 10: ${top10Pct}
└ Top 20: ${top20Pct}
🔧 *Dev:* ${devHolding} | ${devSol}

📦 *Bundles:*
└ ${bundleInfo}

🎯 *Snipers:*
└ ${sniperInfo}

🛡️ *Risk:* ${riskScore} — ${riskLevel}
⚠️ *Flags:*
${risks}
📋 \`${ca}\``;
}

async function sendAnalysis(chatId, ca) {
  const loadMsg = await bot.sendMessage(chatId, '⏳ Analyzing token...');
  try {
    const p = await getTokenData(ca);
    if (!p) {
      await bot.deleteMessage(chatId, loadMsg.message_id);
      return bot.sendMessage(chatId, '❌ Token not found!');
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
    bot.sendMessage(chatId, '❌ Error! Try again.');
    console.error(e);
  }
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `
🚀 *YakubuWeb3 Solana Bot*

Just send any *Solana CA* directly!

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

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `
📋 *Commands:*

Just send a CA directly!
/price <symbol> — Price
/start — Main Menu
  `, { parse_mode: 'Markdown' });
});

bot.onText(/\/analyze (.+)/, async (msg, match) => {
  await sendAnalysis(msg.chat.id, match[1].trim());
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  if (text.startsWith('/')) return;
  const ca = text.trim();
  if (ca.length >= 32 && ca.length <= 44 && /^[A-Za-z0-9]+$/.test(ca)) {
    await sendAnalysis(chatId, ca);
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const data = query.data;

  if (data.startsWith('refresh_')) {
    const ca = data.replace('refresh_', '');
    await bot.answerCallbackQuery(query.id, { text: '🔄 Refreshing...' });
    try {
      const p = await getTokenData(ca);
      if (!p) return;
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
  } catch (e) {
    await bot.deleteMessage(chatId, loadMsg.message_id);
    bot.sendMessage(chatId, '❌ Error!');
  }
});

console.log('✅ YakubuWeb3Bot is running!');
