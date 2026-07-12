// ============================================================
// Strikers Sales Bot v1.0
// Listens for OpenSea sales of a collection and posts them
// to a Discord channel via webhook.
//
// How it works (two layers, so nothing gets missed):
//   1. LIVE:     OpenSea Stream API (websocket) pushes each sale
//                to us the moment it happens.
//   2. BACKFILL: Every 10 minutes we also ask OpenSea's regular
//                REST API "any sales since last check?" — this
//                catches anything the websocket dropped.
// A shared "already posted" list makes sure the same sale is
// never posted twice.
// ============================================================

import { OpenSeaStreamClient, Network } from '@opensea/stream-js';
import { WebSocket } from 'ws';

// ---------- CONFIG (comes from environment variables) ----------
const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const COLLECTION_SLUG = process.env.COLLECTION_SLUG || 'wrapped-strikers';
const BACKFILL_MINUTES = Number(process.env.BACKFILL_MINUTES || 10);

if (!OPENSEA_API_KEY || !DISCORD_WEBHOOK_URL) {
  console.error('Missing OPENSEA_API_KEY or DISCORD_WEBHOOK_URL env var. Exiting.');
  process.exit(1);
}

// ---------- DEDUPE ----------
// Remembers the last 500 sales we've posted (by tx hash + token id)
// so the live feed and the backfill never double-post.
const posted = new Set();
function alreadyPosted(key) {
  if (posted.has(key)) return true;
  posted.add(key);
  if (posted.size > 500) {
    // trim oldest entries so memory never grows forever
    const oldest = posted.values().next().value;
    posted.delete(oldest);
  }
  return false;
}

// ---------- HELPERS ----------
const short = (addr) =>
  addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : 'unknown';

function formatPrice(rawAmount, decimals, symbol, usdPerToken) {
  const amount = Number(rawAmount) / 10 ** Number(decimals ?? 18);
  const eth = `${amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${symbol || 'ETH'}`;
  if (usdPerToken) {
    const usd = amount * Number(usdPerToken);
    return `${eth} ($${usd.toLocaleString(undefined, { maximumFractionDigits: 2 })} USD)`;
  }
  return eth;
}

// ---------- DISCORD ----------
async function postToDiscord(sale) {
  const embed = {
    title: `${sale.name} — SOLD`,
    url: sale.permalink,
    description: `**${sale.priceText}**`,
    color: 0x2081e2, // OpenSea blue
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
    console.error(`Discord webhook failed: ${res.status} ${await res.text()}`);
  } else {
    console.log(`Posted: ${sale.name} for ${sale.priceText}`);
  }
}

// ---------- LAYER 1: LIVE WEBSOCKET ----------
const client = new OpenSeaStreamClient({
  token: OPENSEA_API_KEY,
  network: Network.MAINNET,
  connectOptions: { transport: WebSocket },
  onError: (err) => console.error('Stream error:', err?.message || err),
});

client.onItemSold(COLLECTION_SLUG, async (event) => {
  try {
    const p = event.payload;
    const key = `${p?.transaction?.hash}-${p?.item?.nft_id}`;
    if (alreadyPosted(key)) return;

    await postToDiscord({
      name: p?.item?.metadata?.name || 'Unknown item',
      imageUrl: p?.item?.metadata?.image_url,
      permalink: p?.item?.permalink,
      priceText: formatPrice(
        p?.sale_price,
        p?.payment_token?.decimals,
        p?.payment_token?.symbol,
        p?.payment_token?.usd_price
      ),
      seller: p?.maker?.address,
      buyer: p?.taker?.address,
      txHash: p?.transaction?.hash,
      timestamp: p?.transaction?.timestamp,
    });
  } catch (err) {
    console.error('Error handling live sale event:', err);
  }
});

console.log(`Live listener started for collection: ${COLLECTION_SLUG}`);

// ---------- LAYER 2: BACKFILL POLLER ----------
// Asks the REST API for recent sales, in case the websocket
// dropped one. Overlaps 2 minutes into the past to be safe.
let lastCheck = Math.floor(Date.now() / 1000);

async function backfill() {
  const after = lastCheck - 120; // 2-minute overlap
  lastCheck = Math.floor(Date.now() / 1000);
  try {
    const url = `https://api.opensea.io/api/v2/events/collection/${COLLECTION_SLUG}?event_type=sale&after=${after}&limit=50`;
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'x-api-key': OPENSEA_API_KEY },
    });
    if (!res.ok) {
      console.error(`Backfill request failed: ${res.status}`);
      return;
    }
    const data = await res.json();
    for (const ev of data.asset_events || []) {
      const key = `${ev.transaction}-${ev.nft?.identifier}`;
      if (alreadyPosted(key)) continue;

      console.log('Backfill caught a missed sale!');
      await postToDiscord({
        name: ev.nft?.name || 'Unknown item',
        imageUrl: ev.nft?.display_image_url,
        permalink: ev.nft?.opensea_url,
        priceText: formatPrice(
          ev.payment?.quantity,
          ev.payment?.decimals,
          ev.payment?.symbol,
          null // REST payload has no USD price; ETH-only is fine here
        ),
        seller: ev.seller,
        buyer: ev.buyer,
        txHash: ev.transaction,
        timestamp: ev.closing_date
          ? new Date(ev.closing_date * 1000).toISOString()
          : undefined,
      });
    }
  } catch (err) {
    console.error('Backfill error:', err);
  }
}

setInterval(backfill, BACKFILL_MINUTES * 60 * 1000);
console.log(`Backfill poller running every ${BACKFILL_MINUTES} minutes`);

// ---------- KEEPALIVE ----------
process.on('unhandledRejection', (err) =>
  console.error('Unhandled rejection:', err)
);
