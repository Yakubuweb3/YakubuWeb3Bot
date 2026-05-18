
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
  return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtChange(c) {
  if (c === undefined || c === null) return 'N/A';
  const arrow = c >= 0 ? '🟢' : '🔴';
  return `${arrow} ${c >= 0 ? '+' : ''}${parseFloat(c).toFixed(2)}%`;
}

// FILTER LP AND PROGRAM ADDRESSES
function isLpOrProgram(holder) {
  const addr = holder.address || '';

  if (holder.insider) return true;
  if (holder.isPool) return true;
  if (holder.isLp) return true;

  const known = [
    '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    '11111111111111111111111111111111',
    'So11111111111111111111111111111111111111112',
    'GThUX1Atko4tqhN2NaiTazFAcaPBQ',
    'FEESngU3neckdwib9X3KWqdL',
  ];

  if (known.some(k => addr.startsWith(k))) return true;
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
  const name = p.baseToken?.name || 'Unknown';
  const symbol = p.baseToken?.symbol || 'N/A';

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

  let socials = '';
  if (p.info?.websites?.length > 0) {
    socials += `🌐 ${p.info.websites[0].url}\n`;
  }
  if (p.info?.socials?.length > 0) {
    p.info.socials.forEach(s => {
      socials += `🔗 ${s.url}\n`;
    });
  }
  if (!socials) socials = '❌ No socials';

  const rug = await getRugcheckData(ca);

  let riskScore = 0;
  let riskLevel = 'N/A';
  let holdersCount = 'N/A';
  let top10Pct = 'N/A';
  let top20Pct = 'N/A';
  let devHolding = '0%';
  let devSol = 'N/A';

  if (rug) {
    riskScore = rug.score || 0;

    if (riskScore >= 800) riskLevel = '🔴 HIGH';
    else if (riskScore >= 500) riskLevel = '🟡 MEDIUM';
    else riskLevel = '🟢 LOW';

    // HOLDERS FIXED
    if (rug.topHolders && Array.isArray(rug.topHolders)) {

      const holders = rug.topHolders
        .map(h => ({
          address: h.address || '',
          pct: Number(h.pct || h.percentage || 0),
          insider: h.insider || false,
          isLp: h.isLp || false,
          isPool: h.isPool || false
        }))
        .filter(h => !isLpOrProgram(h))
        .sort((a, b) => b.pct - a.pct);

      holdersCount =
        rug.tokenMeta?.holderCount ||
        holders.length ||
        'N/A';

      const top10 = holders.slice(0, 10);
      const top20 = holders.slice(0, 20);

      top10Pct = Math.min(
        top10.reduce((a, b) => a + (b.pct || 0), 0),
        100
      ).toFixed(1) + '%';

      top20Pct = Math.min(
        top20.reduce((a, b) => a + (b.pct || 0), 0),
        100
      ).toFixed(1) + '%';

      if (rug.creator) {
        const dev = holders.find(h => h.address === rug.creator);
        devHolding = dev ? dev.pct.toFixed(1) + '%' : '0%';
      }
    }

    if (rug.creatorBalance !== undefined) {
      devSol = (rug.creatorBalance / 1e9).toFixed(2) + ' SOL';
    }
  }

  return `
🔍 *${name} (${symbol})*

💰 Price: ${price}
💊 MC: ${mc}
💧 Liquidity: ${liq}

📊 Volume:
- 24h: ${vol24}
- 6h: ${vol6}
- 1h: ${vol1}

📉 Change:
- 24h: ${ch24}
- 6h: ${ch6}
- 1h: ${ch1}

🛒 Buys: ${buys} | Sells: ${sells}

👥 Holders: ${holdersCount}
- Top 10: ${top10Pct}
- Top 20: ${top20Pct}

🔧 Dev Holding: ${devHolding} | ${devSol}

🛡 Risk: ${riskScore} (${riskLevel})

🔗 Socials:
${socials}

📋 CA: \`${ca}\`
  `;
}

async function sendAnalysis(chatId, ca) {
  const load = await bot.sendMessage(chatId, '⏳ Analyzing...');

  try {
    const p = await getTokenData(ca);
    if (!p) {
      await bot.deleteMessage(chatId, load.message_id);
      return bot.sendMessage(chatId, '❌ Not found');
    }

    const text = await formatMsg(p, ca);

    await bot.deleteMessage(chatId, load.message_id);

    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown'
    });

  } catch (e) {
    console.log(e);
    bot.sendMessage(chatId, '❌ Error');
  }
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, '🚀 Send any Solana CA');
});

bot.on('message', async (msg) => {
  const text = msg.text || '';
  if (text.startsWith('/')) return;

  const ca = text.trim();

  if (ca.length >= 32 && ca.length <= 44) {
    await sendAnalysis(msg.chat.id, ca);
  }
});

console.log('🚀 Bot running...');
