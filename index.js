require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

function fmt(num) {
  if (!num) return 'N/A';
  if (num >= 1e9) return '$' + (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return '$' + (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return '$' + (num / 1e3).toFixed(1) + 'K';
  return '$' + Number(num).toFixed(2);
}

function fmtPrice(p) {
  if (!p) return 'N/A';
  const n = parseFloat(p);
  if (n < 0.000001) return '$' + n.toExponential(2);
  if (n < 0.01) return '$' + n.toFixed(8);
  if (n < 1) return '$' + n.toFixed(4);
  return '$' + n.toLocaleString();
}

function fmtChange(c) {
  if (c === undefined || c === null) return 'N/A';
  return `${c >= 0 ? '🟢' : '🔴'} ${c >= 0 ? '+' : ''}${c.toFixed(2)}%`;
}

// FILTER SAFE ADDRESSES
function isLpOrProgram(h) {
  const addr = h.address || '';
  if (h.insider || h.isLp || h.isPool) return true;

  const bad = [
    'So11111111111111111111111111111111111111112',
    '11111111111111111111111111111111',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
  ];

  if (bad.some(x => addr.includes(x))) return true;
  return false;
}

async function getTokenData(ca) {
  const res = await axios.get(
    `https://api.dexscreener.com/latest/dex/tokens/${ca}`
  );

  const pairs = res.data.pairs;
  if (!pairs?.length) return null;

  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  return pairs[0];
}

async function getRug(ca) {
  try {
    const res = await axios.get(
      `https://api.rugcheck.xyz/v1/tokens/${ca}/report`
    );
    return res.data;
  } catch {
    return null;
  }
}

async function formatMsg(p, ca) {

  const name = p.baseToken?.name || 'Unknown';
  const symbol = p.baseToken?.symbol || 'N/A';

  const rug = await getRug(ca);

  let holders = 'N/A';
  let top10 = 'N/A';
  let top20 = 'N/A';
  let risk = 'N/A';

  if (rug) {

    risk = rug.score || 0;

    // HOLDERS FIX (IMPORTANT PART)
    if (rug.topHolders?.length) {

      const list = rug.topHolders
        .map(h => ({
          address: h.address || '',
          pct: Number(h.pct || h.percentage || 0),
          insider: h.insider
        }))
        .filter(h => !isLpOrProgram(h))
        .sort((a, b) => b.pct - a.pct);

      holders = rug.tokenMeta?.holderCount || list.length;

      const t10 = list.slice(0, 10).reduce((a, b) => a + b.pct, 0);
      const t20 = list.slice(0, 20).reduce((a, b) => a + b.pct, 0);

      top10 = Math.min(t10, 100).toFixed(1) + '%';
      top20 = Math.min(t20, 100).toFixed(1) + '%';
    }
  }

  return `
🔍 *${name} (${symbol})*

💰 Price: ${fmtPrice(p.priceUsd)}
💊 MC: ${fmt(p.fdv)}
💧 Liquidity: ${fmt(p.liquidity?.usd)}

📊 Volume:
24h: ${fmt(p.volume?.h24)}

👥 Holders: ${holders}
Top 10: ${top10}
Top 20: ${top20}

🛡 Risk: ${risk}

📍 CA:
\`${ca}\`
  `;
}

// MAIN SEND WITH BUTTONS (RESTORED)
async function sendAnalysis(chatId, ca) {

  const load = await bot.sendMessage(chatId, '⏳ Analyzing...');

  try {

    const p = await getTokenData(ca);
    if (!p) return bot.sendMessage(chatId, '❌ Not found');

    const text = await formatMsg(p, ca);

    await bot.deleteMessage(chatId, load.message_id);

    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🔄 Refresh', callback_data: `refresh_${ca}` },
          { text: '📈 DexScreener', url: `https://dexscreener.com/solana/${ca}` }
        ]]
      }
    });

  } catch (e) {
    console.log(e);
    bot.sendMessage(chatId, '❌ Error');
  }
}

// COMMANDS
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, '🚀 Send Solana CA');
});

bot.on('message', async (msg) => {
  const text = msg.text || '';
  if (text.startsWith('/')) return;

  const ca = text.trim();
  if (ca.length >= 32 && ca.length <= 44) {
    await sendAnalysis(msg.chat.id, ca);
  }
});

// CALLBACK (REFRESH FIXED)
bot.on('callback_query', async (q) => {

  const chatId = q.message.chat.id;
  const ca = q.data.replace('refresh_', '');

  if (q.data.startsWith('refresh_')) {
    await bot.answerCallbackQuery(q.id, { text: '🔄 Refreshing...' });
    await sendAnalysis(chatId, ca);
  }
});

console.log('🚀 Bot running...');
