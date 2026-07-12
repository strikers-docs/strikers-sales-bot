// ============================================================
// Strikers Sales Bot v2.0 (GitHub Actions edition)
// Runs on a schedule (every ~10 min), checks OpenSea for new
// sales, posts them to Discord, then exits. $0/month.
//
// How it avoids missing or double-posting sales:
//   - Every run looks back 72 HOURS (way more than one cycle),
//     so late/skipped scheduled runs can't create gaps.
//   - state.json remembers which sales were already posted,
//     so the overlap never causes duplicates.
//   - state.json also carries a daily "keepalive" stamp; the
//     workflow commits it, which keeps the repo active so
//     GitHub never auto-disables the schedule.
// ============================================================

import { readFileSync, writeFileSync } from 'node:fs';

const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const COLLECTION_SLUG = process.env.COLLECTION_SLUG || 'wrapped-strikers';
const LOOKBACK_HOURS = 72;
const STATE_FILE = new URL('./state.json', import.meta.url);

if (!OPENSEA_API_KEY || !DISCORD_WEBHOOK_URL) {
  console.error('Missing OPENSEA_API_KEY or DISCORD_WEBHOOK_URL. Exiting.');
  process.exit(1);
}

// ---------- STATE ----------
let state = { posted: [], keepalive: '' };
try {
  state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
} catch {
  console.log('No state.json yet, starting fresh.');
}
const postedSet = new Set(state.posted);

// ---------- HELPERS ----------
const short = (addr) =>
  addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : 'unknown';

async function getEthUsd() {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd'
    );
    if (!res.ok) return null;
    return (await res.json())?.ethereum?.usd ?? null;
  } catch {
    return null; // USD is nice-to-have; never fail the run over it
  }
}

function formatPrice(rawAmount, decimals, symbol, ethUsd) {
  const amount = Number(rawAmount) / 10 ** Number(decimals ?? 18);
  const base = `${amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${symbol || 'ETH'}`;
  const isEthLike = !symbol || symbol === 'ETH' || symbol === 'WETH';
  if (ethUsd && isEthLike) {
    const usd = amount * ethUsd;
    return `${base} ($${usd.toLocaleString(undefined, { maximumFractionDigits: 2 })} USD)`;
  }
  return base;
}

async function postToDiscord(sale) {
  const embed = {
    title: `${sale.name} — SOLD`,
    url: sale.permalink,
    description: `**${sale.priceText}**`,
    color: 0x2081e2,
    fields: [
      { name: 'From', value: short(sale.seller), inline: true },
      { name: 'To', value: short(sale.buyer), inline: true },
      {
        name: 'Links',
        value: `[OpenSea](${sale.permalink}) • [Etherscan](https://etherscan.io/tx/${sale.txHash})`,
        inline: false,
      },
    ],
    image: sale.imageUrl ? { url: sale.imageUrl } : undefined,
    footer: { text: 'Strikers Sales Bot' },
    timestamp: sale.timestamp || new Date().toISOString(),
  };

  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook failed: ${res.status} ${await res.text()}`);
  }
  console.log(`Posted: ${sale.name} for ${sale.priceText}`);
}

// ---------- MAIN ----------
const after = Math.floor(Date.now() / 1000) - LOOKBACK_HOURS * 3600;
const url = `https://api.opensea.io/api/v2/events/collection/${COLLECTION_SLUG}?event_type=sale&after=${after}&limit=50`;

const res = await fetch(url, {
  headers: { accept: 'application/json', 'x-api-key': OPENSEA_API_KEY },
});
if (!res.ok) {
  console.error(`OpenSea request failed: ${res.status}`);
  process.exit(1);
}
const data = await res.json();
const events = (data.asset_events || []).reverse(); // oldest first, so Discord shows them in order

const fresh = events.filter(
  (ev) => !postedSet.has(`${ev.transaction}-${ev.nft?.identifier}`)
);
console.log(`${events.length} sale(s) in window, ${fresh.length} new.`);

const ethUsd = fresh.length ? await getEthUsd() : null;

for (const ev of fresh) {
  const key = `${ev.transaction}-${ev.nft?.identifier}`;
  await postToDiscord({
    name: ev.nft?.name || 'Unknown item',
    imageUrl: ev.nft?.display_image_url,
    permalink: ev.nft?.opensea_url,
    priceText: formatPrice(
      ev.payment?.quantity,
      ev.payment?.decimals,
      ev.payment?.symbol,
      ethUsd
    ),
    seller: ev.seller,
    buyer: ev.buyer,
    txHash: ev.transaction,
    timestamp: ev.closing_date
      ? new Date(ev.closing_date * 1000).toISOString()
      : undefined,
  });
  postedSet.add(key); // only mark posted after Discord accepted it
}

// ---------- SAVE STATE ----------
state.posted = [...postedSet].slice(-500); // remember the last 500
state.keepalive = new Date().toISOString().slice(0, 10); // changes daily -> daily commit keeps repo active
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
console.log('Done.');
