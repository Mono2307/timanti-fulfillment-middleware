// ============================================================
// ORDER ROUTES
//
// POST /orders/allocate  → Allocate a physical piece to an online order
// GET  /orders/:order_id → See which pieces are allocated to an order
// ============================================================

const express = require('express')
const router = express.Router()
const supabase = require('../supabase')

// ----------------------------------------------------------
// POST /orders/allocate
// Finds available pieces for each line item in an order
// and reserves them.
//
// Body: {
//   order_id: "12345678901234",
//   line_items: [
//     { variant_id: "12345678901234", quantity: 1 }
//   ]
// }
// ----------------------------------------------------------
router.post('/allocate', async (req, res) => {
  const { order_id, line_items } = req.body

  if (!order_id || !line_items || line_items.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'order_id and line_items are required'
    })
  }

  const results = []
  const failures = []

  for (const item of line_items) {
    const { variant_id, quantity = 1 } = item

    // --- Find available pieces for this variant ---
    // Priority: HSR store first (fulfils_online = true), then others
    // This is built to scale — just update fulfils_online flag per location
    const { data: locations } = await supabase
      .from('locations')
      .select('location_id')
      .eq('is_active', true)
      .eq('fulfils_online', true)
      .order('location_id') // deterministic ordering

    if (!locations || locations.length === 0) {
      failures.push({ variant_id, reason: 'no_fulfilling_locations' })
      continue
    }

    const locationIds = locations.map(l => l.location_id)

    const { data: availablePieces } = await supabase
      .from('inventory_pieces')
      .select('jewelcode, location_id')
      .eq('variant_id', variant_id)
      .eq('status', 'available')
      .in('location_id', locationIds)
      .limit(quantity)

    if (!availablePieces || availablePieces.length < quantity) {
      // Not enough pieces — tag order for manual intervention
      failures.push({
        variant_id,
        needed: quantity,
        found: availablePieces ? availablePieces.length : 0,
        reason: 'insufficient_inventory'
      })
      continue
    }

    // --- Allocate each piece atomically ---
    for (const piece of availablePieces) {
      // Atomic update: only succeeds if status is still 'available'
      // This prevents race conditions (online + offline at same time)
      const { data: updated, error } = await supabase
        .from('inventory_pieces')
        .update({
          status: 'allocated',
          order_id,
          updated_at: new Date().toISOString()
        })
        .eq('jewelcode', piece.jewelcode)
        .eq('status', 'available') // ← This is the lock
        .select()
        .single()

      if (!updated || error) {
        // Someone else grabbed this piece between our query and update
        failures.push({
          variant_id,
          jewelcode: piece.jewelcode,
          reason: 'race_condition_lost'
        })
        continue
      }

      // --- Log allocation ---
      await supabase.from('inventory_events').insert({
        jewelcode: piece.jewelcode,
        action: 'allocate',
        source: 'online',
        metadata: { order_id, variant_id },
        timestamp: new Date().toISOString()
      })

      results.push({
        jewelcode: piece.jewelcode,
        variant_id,
        location_id: piece.location_id,
        order_id
      })
    }
  }

  // --- Tag Shopify order if any items failed ---
  if (failures.length > 0) {
    await tagShopifyOrder(order_id, 'inventory_pending')
  }

  return res.json({
    success: failures.length === 0,
    order_id,
    allocated: results,
    failed: failures,
    message: failures.length === 0
      ? `All pieces allocated successfully`
      : `${results.length} pieces allocated, ${failures.length} items pending manual intervention`
  })
})

// ----------------------------------------------------------
// GET /orders/:order_id
// See allocation status for an order — useful for Retool
// ----------------------------------------------------------
router.get('/:order_id', async (req, res) => {
  const { data: pieces, error } = await supabase
    .from('inventory_pieces')
    .select('jewelcode, variant_id, sku, location_id, status, updated_at')
    .eq('order_id', req.params.order_id)

  if (error) return res.status(500).json({ success: false, error: error.message })

  return res.json({
    success: true,
    order_id: req.params.order_id,
    pieces
  })
})

// ----------------------------------------------------------
// HELPER: Add a tag to a Shopify order
// ----------------------------------------------------------
async function tagShopifyOrder(shopifyOrderId, tag) {
  try {
    const response = await fetch(
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
    if (!response.ok) {
      console.error('Failed to tag Shopify order:', shopifyOrderId)
    }
  } catch (err) {
    console.error('Shopify tag error:', err.message)
  }
}

module.exports = router
