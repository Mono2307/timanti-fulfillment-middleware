// ============================================================
// WEBHOOK ROUTES
//
// POST /webhooks/order-paid
// Shopify calls this automatically every time a customer pays
// We then try to allocate physical pieces to that order
// ============================================================

const express = require('express')
const router = express.Router()
const crypto = require('crypto')
const supabase = require('./supabase')

// ----------------------------------------------------------
// POST /webhooks/order-paid
// Shopify fires this when an order is paid
// ----------------------------------------------------------
router.post('/order-paid', async (req, res) => {

  // --- Step 1: Verify this actually came from Shopify ---
  const hmacHeader = req.headers['x-shopify-hmac-sha256']
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET

  if (!hmacHeader || !secret) {
    console.error('Missing HMAC header or webhook secret')
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const generatedHmac = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody, 'utf8')
    .digest('base64')

  if (generatedHmac !== hmacHeader) {
    console.error('HMAC verification failed — request not from Shopify')
    return res.status(401).json({ error: 'HMAC verification failed' })
  }

  // --- Step 2: Extract order details ---
  const order = req.body
  const shopifyOrderId = order.id?.toString()
  const lineItems = order.line_items || []

  if (!shopifyOrderId) {
    return res.status(400).json({ error: 'Invalid order payload' })
  }

  console.log(`New paid order received: ${shopifyOrderId}`)

  // --- Step 3: Respond to Shopify immediately ---
  res.status(200).json({ received: true })

  // --- Step 4: Process allocation in background ---
  try {
    const itemsToAllocate = lineItems.map(item => ({
      variant_id: item.variant_id?.toString(),
      quantity: item.quantity || 1,
      sku: item.sku || '',
      title: item.title
    }))

    const allocationResult = await allocateOrder(shopifyOrderId, itemsToAllocate)

    console.log(`Allocation result for order ${shopifyOrderId}:`, allocationResult)

    await supabase.from('inventory_events').insert({
      jewelcode: 'WEBHOOK',
      action: 'webhook_received',
      source: 'online',
      metadata: {
        order_id: shopifyOrderId,
        line_items_count: lineItems.length,
        allocation_success: allocationResult.success
      },
      timestamp: new Date().toISOString()
    })

  } catch (err) {
    console.error(`Error processing order ${shopifyOrderId}:`, err.message)
  }
})

// ----------------------------------------------------------
// INTERNAL: Allocation logic
// ----------------------------------------------------------
async function allocateOrder(order_id, line_items) {
  const results = []
  const failures = []

  for (const item of line_items) {
    const { variant_id, sku, quantity = 1 } = item

    if (!sku || sku === '') {
      console.log(`Skipping item with no SKU, variant_id: ${variant_id}`)
      continue
    }

    const { data: locations } = await supabase
      .from('locations')
      .select('location_id')
      .eq('is_active', true)
      .eq('fulfils_online', true)
      .order('location_id')

    if (!locations || locations.length === 0) {
      failures.push({ sku, reason: 'no_fulfilling_locations' })
      continue
    }

    const locationIds = locations.map(l => l.location_id)

    const { data: availablePieces } = await supabase
      .from('inventory_pieces')
      .select('jewelcode, location_id')
      .eq('variant_sku', sku)
      .eq('status', 'available')
      .in('location_id', locationIds)
      .limit(quantity)

    if (!availablePieces || availablePieces.length < quantity) {
      failures.push({
        sku,
        needed: quantity,
        found: availablePieces?.length || 0,
        reason: 'insufficient_inventory'
      })
      await tagShopifyOrder(order_id, 'inventory_pending')
      continue
    }

    for (const piece of availablePieces) {
      const { data: updated } = await supabase
        .from('inventory_pieces')
        .update({
          status: 'allocated',
          order_id,
          updated_at: new Date().toISOString()
        })
        .eq('jewelcode', piece.jewelcode)
        .eq('status', 'available')
        .select()
        .single()

      if (!updated) {
        failures.push({ sku, jewelcode: piece.jewelcode, reason: 'race_condition' })
        continue
      }

      await supabase.from('inventory_events').insert({
        jewelcode: piece.jewelcode,
        action: 'allocate',
        source: 'online',
        metadata: { order_id, sku },
        timestamp: new Date().toISOString()
      })

      results.push({ jewelcode: piece.jewelcode, sku, order_id })
    }
  }

  return {
    success: failures.length === 0,
    allocated: results,
    failed: failures
  }
}

async function tagShopifyOrder(shopifyOrderId, tag) {
  try {
    await fetch(
      `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders/${shopifyOrderId}.json`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
        },
        body: JSON.stringify({ order: { id: shopifyOrderId, tags: tag } })
      }
    )
  } catch (err) {
    console.error('Shopify tag error:', err.message)
  }
}

module.exports = router
