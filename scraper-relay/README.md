# ayre-scraper-relay

A small Node.js relay service that proxies scraping requests through
[Bright Data Scraping Browser (SBR)](https://brightdata.com/products/scraping-browser).

The dashboard at `dashboard.andrewyaggie.com` previously connected to Bright Data
SBR directly, but the upstream IP changes frequently and gets blocked by
Bright Data's IP whitelist. This service runs on Railway with a stable
egress IP, performs the SBR navigation, and returns normalized JSON.

## Endpoints

| Method | Path                | Auth                    | Description                                          |
| ------ | ------------------- | ----------------------- | ---------------------------------------------------- |
| GET    | `/`                 | none                    | Service info                                         |
| GET    | `/health`           | none                    | Liveness probe (used by Railway healthcheck)         |
| GET    | `/whoami`           | none                    | Returns the relay's outbound public IP               |
| POST   | `/scrape/flexmls`   | `Authorization: Bearer` | Scrapes a FlexMLS listing URL and returns property JSON |

### `POST /scrape/flexmls`

```bash
curl -X POST https://<service>.up.railway.app/scrape/flexmls \
  -H "Authorization: Bearer $RELAY_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://flexmls.com/cgi-bin/mainmenu.cgi?cmd=url+other/run_public_link.html&public_link_tech_id=..."}'
```

Response:

```json
{
  "ok": true,
  "duration_ms": 12345,
  "data": {
    "url": "...",
    "title": "...",
    "price": 425000,
    "price_text": "$425,000",
    "address": "123 Main St, ...",
    "description": "...",
    "mls_id": "...",
    "specs": { "beds": 3, "baths": 2, "sqft": 1850, "year_built": 1998 },
    "photos": ["https://...", "..."],
    "og_image": "https://...",
    "ld_json": { ... }
  }
}
```

## Environment variables

| Variable             | Default                                                                                         | Notes                                            |
| -------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `PORT`               | `3000`                                                                                          | Set by Railway automatically                     |
| `RELAY_AUTH_TOKEN`   | (baked default for dashboard compatibility)                                                     | Bearer token expected in `Authorization` header  |
| `SBR_WS_ENDPOINT`    | `wss://brd-customer-hl_ebc27cb0-zone-crexi:m6yo5yksj0py@brd.superproxy.io:9222`                  | Bright Data Scraping Browser WS URL              |

## Local dev

```bash
npm install
npm start
```
