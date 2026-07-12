# Strikers Sales Bot v1.0

Posts every Wrapped Strikers sale on OpenSea to a Discord channel.

Two layers of coverage:
- **Live** — OpenSea Stream API (websocket) pushes sales instantly
- **Backfill** — every 10 min, a REST check catches anything the socket missed

Duplicates are automatically filtered, so a sale is only ever posted once.

## What you need

1. **OpenSea API key** — free. Log in at opensea.io, go to your profile
   → Settings → Developer (or docs.opensea.io → request API key).
2. **Discord webhook URL** — in your server: #sales channel → Edit Channel
   → Integrations → Webhooks → New Webhook → Copy Webhook URL.

## Run locally (testing)

```
cp .env.example .env      # then paste your two values into .env
npm install
npm start
```

You should see:
```
Live listener started for collection: wrapped-strikers
Backfill poller running every 10 minutes
```

No errors after that = connected and waiting for sales.

## Deploy to Railway (runs 24/7)

1. Push this folder to a GitHub repo
2. railway.com → New Project → Deploy from GitHub repo
3. Add the two environment variables (Variables tab):
   `OPENSEA_API_KEY`, `DISCORD_WEBHOOK_URL`
4. Deploy. Check the logs for the two startup lines above.

## Config (optional)

| Env var | Default | What it does |
|---|---|---|
| `COLLECTION_SLUG` | `wrapped-strikers` | Track a different collection |
| `BACKFILL_MINUTES` | `10` | How often the safety-net check runs |
