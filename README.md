# ayre-mls-relay

A lightweight Express proxy that relays MLS API requests from Claude Cowork (or any client) to the Manus-hosted dashboard at `dashboard.andrewyaggie.com`, bypassing Cloudflare bot detection via server-to-server forwarding with browser-like headers.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Health check |
| `ANY` | `/api/mls/*` | Bearer token | Proxied to upstream MLS API |

## Authentication

All `/api/mls/*` requests require an `Authorization: Bearer <token>` header.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port to listen on |
| `RELAY_BEARER_TOKEN` | *(set in Railway)* | Token callers must supply |
| `UPSTREAM_BASE_URL` | `https://dashboard.andrewyaggie.com` | Upstream API base |

## Usage Example

```bash
curl -H "Authorization: Bearer dak_live_KLZAZ9DV9ACsM7-FtN6rc6LGfjgyK32qtGOvQ7gxxR8" \
     https://<railway-domain>/api/mls/listings
```
