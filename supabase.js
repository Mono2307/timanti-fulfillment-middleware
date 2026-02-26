# SIAS API — Auracarat
Serialized Inventory Allocation & Fulfilment System

## What this does
Tracks individual jewellery pieces by barcode (jewelcode) so you never double-sell.
Connects Shopify orders → Supabase database → Retool dashboard.

---

## API Endpoints

| Method | Endpoint | What it does |
|--------|----------|--------------|
| GET | / | Health check |
| POST | /inventory/receive | Scan a new piece into stock |
| POST | /inventory/scan-sale | Scan a piece for a walk-in customer |
| POST | /inventory/confirm-sale | Mark a piece as sold after POS payment |
| GET | /inventory/piece/:jewelcode | Look up any piece |
| GET | /inventory/location/:location_id | See all pieces at a location |
| POST | /orders/allocate | Allocate pieces to an online order |
| GET | /orders/:order_id | See allocations for an order |
| POST | /webhooks/order-paid | Shopify calls this when order is paid |
| GET | /admin/audit-log | Full event history |
| GET | /admin/pending-orders | Orders needing manual attention |
| GET | /admin/locations | All locations with inventory counts |
| POST | /admin/return | Mark a piece as returned |
| POST | /admin/repair | Mark a piece as in repair |

---

## Setup & Deployment

### 1. Clone and install
```bash
git clone your-repo
cd sias-api
npm install
```

### 2. Set environment variables
```bash
cp .env.example .env
# Edit .env with your values
```

### 3. Deploy to Fly.io
```bash
# Install Fly CLI: https://fly.io/docs/hands-on/install-flyctl/
fly auth login
fly launch        # First time only — creates app
fly secrets set SUPABASE_URL=your-url
fly secrets set SUPABASE_SERVICE_KEY=your-key
fly secrets set SHOPIFY_STORE_DOMAIN=auracarat.myshopify.com
fly secrets set SHOPIFY_ACCESS_TOKEN=your-token
fly secrets set SHOPIFY_WEBHOOK_SECRET=your-secret
fly deploy
```

### 4. Register Shopify webhook
In Shopify admin → Settings → Notifications → Webhooks:
- Event: Order payment
- URL: https://your-fly-app.fly.dev/webhooks/order-paid
- Format: JSON

---

## Locations
- `HSR-BLR-STORE` = HSR Layout Bangalore store (fulfils online orders)
- `SHOP-LOCATION` = Shopify's default location (HQ/warehouse)

To add a new store, just add a row to the `locations` table in Supabase.
