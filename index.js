require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// START
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `
🚀 *YakubuWeb3 Solana Bot*

Welcome! Choose an option:

/analyze <CA> — Analyze any token
/price <symbol> — Check price
/help — Show all commands
  `, { parse_mode: 'Markdown' });
});

// HELP
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `
📋 *Commands:*

/analyze <CA> — Token Analysis
/price <symbol> — Token Price
/start — Main Menu
  `, { parse_mode: 'Markdown' });
});

// ANALYZE TOKEN
bot.onText(/\/analyze (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const ca = match[1].trim();
  bot.sendMessage(chatId, '⏳ Analyzing token...');
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${ca}`
    );
    const pairs = res.data.pairs;
    if (!pairs || pairs.length === 0) {
      return bot.sendMessage(chatId, '❌ Token not found! Check the contract address.');
    }
    const p = pairs[0];
    const name = p.baseToken.name;
    const symbol = p.baseToken.symbol;
    const price = p.priceUsd ? `$${parseFloat(p.priceUsd).toFixed(8)}` : 'N/A';
    const mc = p.fdv ? `$${Number(p.fdv).toLocaleString()}` : 'N/A';
    const liq = p.liquidity?.usd ? `$${Number(p.liquidity.usd).toLocaleString()}` : 'N/A';
    const vol24 = p.volume?.h24 ? `$${Number(p.volume.h24).toLocaleString()}` : 'N/A';
    const vol6 = p.volume?.h6 ? `$${Number(p.volume.h6).toLocaleString()}` : 'N/A';
    const vol1 = p.volume?.h1 ? `$${Number(p.volume.h1).toLocaleString()}` : 'N/A';
    const change24 = p.priceChange?.h24 ? `${p.priceChange.h24}%` : 'N/A';
    const change1 = p.priceChange?.h1 ? `${p.priceChange.h1}%` : 'N/A';
    const created = p.pairCreatedAt
      ? new Date(p.pairCreatedAt).toUTCString()
      : 'N/A';
    const dex = p.dexId || 'N/A';
    const chain = p.chainId || 'N/A';
    const txBuy = p.txns?.h24?.buys || 'N/A';
    const txSell = p.txns?.h24?.sells || 'N/A';

    // SECURITY CHECK
    let security = '';
    if (p.liquidity?.usd < 10000) security += '⚠️ LOW LIQUIDITY — High Risk!\n';
    else security += '✅ Liquidity OK\n';
    if (p.fdv && p.liquidity?.usd && (p.fdv / p.liquidity.usd) > 100)
      security += '⚠️ High MC/Liq Ratio — Rug Risk!\n';
    else security += '✅ MC/Liq Ratio OK\n';
    if (p.txns?.h24?.buys < 10) security += '⚠️ Very Low Buy Txns!\n';
    else security += '✅ Buy Activity OK\n';

    bot.sendMessage(chatId, `
🔍 *Token Analysis*

📛 *Name:* ${name} (${symbol})
🔗 *Chain:* ${chain.toUpperCase()}
🏦 *DEX:* ${dex}

💰 *Price:* ${price}
📊 *Market Cap:* ${mc}
💧 *Liquidity:* ${liq}

📈 *Volume (24h):* ${vol24}
📈 *Volume (6h):* ${vol6}
📈 *Volume (1h):* ${vol1}

📉 *Price Change (24h):* ${change24}
📉 *Price Change (1h):* ${change1}

🛒 *Buys (24h):* ${txBuy}
🔴 *Sells (24h):* ${txSell}

⏰ *Created:* ${created}

🛡️ *Security Check:*
${security}

📋 *CA:* \`${ca}\`
    `, { parse_mode: 'Markdown' });
  } catch (e) {
    bot.sendMessage(chatId, '❌ Error analyzing token. Try again!');
  }
});

// PRICE CHECK
bot.onText(/\/price (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const symbol = match[1].trim().toLowerCase();
  try {
    const res = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${symbol}&vs_currencies=usd&include_24hr_change=true`
    );
    const data = res.data[symbol];
    if (!data) return bot.sendMessage(chatId, '❌ Coin not found!');
    const price = `$${data.usd.toLocaleString()}`;
    const change = data.usd_24h_change.toFixed(2);
    const arrow = change >= 0 ? '▲' : '▼';
    bot.sendMessage(chatId, `
💰 *${symbol.toUpperCase()} Price*

💵 Price: *${price}*
${arrow} 24h Change: *${change}%*
    `, { parse_mode: 'Markdown' });
  } catch (e) {
    bot.sendMessage(chatId, '❌ Error fetching price!');
  }
});

console.log('✅ YakubuWeb3Bot is running!');
