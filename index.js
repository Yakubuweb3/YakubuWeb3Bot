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

function formatMsg(p, ca) {
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
  const ath = p.ath ? fmtPrice(p.ath) : 'N/A';
  const athChange = p.athChangePercentage ? `(${parseFloat(p.athChangePercentage).toFixed(0)}%)` : '';
  const created = p.pairCreatedAt
    ? Math.floor((Date.now() - p.pairCreatedAt) / 86400000) + 'd ago'
    : 'N/A';
  const chain = (p.chainId || '').toUpperCase();
  const dex = p.dexId || 'N/A';
  const buys = p.txns?.h24?.buys || 0;
  const sells = p.txns?.h24?.sells || 0;

  let socials = '';
  if (p.info?.websites?.length > 0) {
    socials += `🌐 [Website](${p.info.websites[0].url}) `;
  }
  if (p.info?.socials?.length > 0) {
    p.info.socials.forEach(s => {
      if (s.type === 'twitter') socials += `🐦 [Twitter](${s.url}) `;
      if (s.type === 'telegram') socials += `✈️ [Telegram](${s.url}) `;
      if (s.type === 'discord') socials += `💬 [Discord](${s.url}) `;
    });
  }
  if (!socials) socials = '❌ No socials found';

  let security = '';
  if (!p.liquidity?.usd || p.liquidity.usd < 10000) {
    security += '🔴 LOW LIQUIDITY — High Risk!\n';
  } else {
    security += '✅ Liquidity OK\n';
  }
  if (p.fdv && p.liquidity?.usd && (p.fdv / p.liquidity.usd) > 100) {
    security += '⚠️ High MC/Liq Ratio — Rug Risk!\n';
  } else {
    security += '✅ MC/Liq Ratio OK\n';
  }
  if (buys < 10) {
    security += '⚠️ Very Low Buy Activity!\n';
  } else {
    security += '✅ Buy Activity OK\n';
  }

  return `🔍 *${name}* (${symbol})
🔗 ${chain} | 🏦 ${dex} | ⏰ ${created}

💰 *Price:* ${price}
📊 *MC:* ${mc} | 💧 *Liq:* ${liq}

📈 *Volume:*
├ 24h: ${vol24}
├ 6h: ${vol6}
└ 1h: ${vol1}

📉 *Price Change:*
├ 24h: ${ch24}
├ 6h: ${ch6}
└ 1h: ${ch1}

🏆 *ATH:* ${ath} ${athChange}

🛒 *Buys (24h):* ${buys} | 🔴 *Sells:* ${sells}

🔗 *Socials:*
${socials}

🛡️ *Security:*
${security}
📋 \`${ca}\``;
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `
🚀 *YakubuWeb3 Solana Bot*

*Welcome!* Choose an option:

/analyze <CA> — Analyze any token
/price <symbol> — Check price
/help — Show all commands

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

/analyze <CA> — Token Analysis
/price <symbol> — Token Price
/start — Main Menu

_Example:_
\`/analyze DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263\`
\`/price bitcoin\`
  `, { parse_mode: 'Markdown' });
});

bot.onText(/\/analyze (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const ca = match[1].trim();
  const loadMsg = await bot.sendMessage(chatId, '⏳ Analyzing token...');
  try {
    const p = await getTokenData(ca);
    if (!p) {
      await bot.deleteMessage(chatId, loadMsg.message_id);
      return bot.sendMessage(chatId, '❌ Token not found! Check the contract address.');
    }
    const text = formatMsg(p, ca);
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
    await bot.deleteMessage(chatId, loadMsg.message_id);
    bot.sendMessage(chatId, '❌ Error analyzing token. Try again!');
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
      if (!p) return bot.answerCallbackQuery(query.id, { text: '❌ Token not found!' });
      const text = formatMsg(p, ca);
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
      bot.answerCallbackQuery(query.id, { text: '❌ Error refreshing!' });
    }
  }

  if (data === 'delete') {
    await bot.deleteMessage(chatId, msgId);
    await bot.answerCallbackQuery(query.id, { text: '🗑️ Deleted!' });
  }

  if (data === 'prompt_analyze') {
    await bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, '📋 Send the contract address:\n\n`/analyze <CA>`', { parse_mode: 'Markdown' });
  }

  if (data === 'prompt_price') {
    await bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, '💰 Send coin name:\n\n`/price bitcoin`', { parse_mode: 'Markdown' });
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
      return bot.sendMessage(chatId, '❌ Coin not found!', { parse_mode: 'Markdown' });
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
    bot.sendMessage(chatId, '❌ Error fetching price!');
  }
});

console.log('✅ YakubuWeb3Bot is running!');
