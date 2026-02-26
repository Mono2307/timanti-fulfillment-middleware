// ============================================================
// ADMIN ROUTES
//
// GET /admin/audit-log         → Full history of all events
// GET /admin/pending-orders    → Orders tagged 'inventory_pending'
// GET /admin/locations         → List all locations
// POST /admin/return           → Mark a piece as returned
// POST /admin/repair           → Mark a piece as in repair
// ============================================================

const express = require('express')
const router = express.Router()
const supabase = require('../supabase')

// ----------------------------------------------------------
// GET /admin/audit-log
// Full event history — shown in Retool audit log screen
// Optional query params: ?jewelcode=AC-001 or ?limit=50
// ----------------------------------------------------------
router.get('/audit-log', async (req, res) => {
  const { jewelcode, limit = 100 } = req.query

  let query = supabase
    .from('inventory_events')
    .select('*')
    .order('timestamp', { ascending: false })
    .limit(parseInt(limit))

  if (jewelcode) {
    query = query.eq('jewelcode', jewelcode)
  }

  const { data: events, error } = await query

  if (error) return res.status(500).json({ success: false, error: error.message })

  return res.json({ success: true, count: events.length, events })
})

// ----------------------------------------------------------
// GET /admin/pending-orders
// Orders that couldn't be allocated — need manual attention
// These are pieces where status never moved past order creation
// ----------------------------------------------------------
router.get('/pending-orders', async (req, res) => {
  // Find events where allocation failed
  const { data: failEvents, error } = await supabase
    .from('inventory_events')
    .select('*')
    .eq('action', 'fail')
    .order('timestamp', { ascending: false })
    .limit(50)

  if (error) return res.status(500).json({ success: false, error: error.message })

  return res.json({
    success: true,
    count: failEvents.length,
    pending: failEvents
  })
})

// ----------------------------------------------------------
// GET /admin/locations
// List all locations with inventory counts
// ----------------------------------------------------------
router.get('/locations', async (req, res) => {
  const { data: locations, error } = await supabase
    .from('locations')
    .select('*')
    .order('location_name')

  if (error) return res.status(500).json({ success: false, error: error.message })

  // Get counts per location
  const locationsWithCounts = await Promise.all(
    locations.map(async (loc) => {
      const { count: total } = await supabase
        .from('inventory_pieces')
        .select('*', { count: 'exact', head: true })
        .eq('location_id', loc.location_id)

      const { count: available } = await supabase
        .from('inventory_pieces')
        .select('*', { count: 'exact', head: true })
        .eq('location_id', loc.location_id)
        .eq('status', 'available')

      return { ...loc, total_pieces: total, available_pieces: available }
    })
  )

  return res.json({ success: true, locations: locationsWithCounts })
})

// ----------------------------------------------------------
// POST /admin/return
// Mark a piece as returned (goes back to available)
//
// Body: { jewelcode: "AC-001234", reason: "customer changed mind" }
// ----------------------------------------------------------
router.post('/return', async (req, res) => {
  const { jewelcode, reason } = req.body

  if (!jewelcode) {
    return res.status(400).json({ success: false, error: 'jewelcode is required' })
  }

  const { data: piece } = await supabase
    .from('inventory_pieces')
    .select('*')
    .eq('jewelcode', jewelcode)
    .single()

  if (!piece) {
    return res.status(404).json({ success: false, error: 'Piece not found' })
  }

  const { error } = await supabase
    .from('inventory_pieces')
    .update({
      status: 'available',
      order_id: null,
      updated_at: new Date().toISOString()
    })
    .eq('jewelcode', jewelcode)

  if (error) return res.status(500).json({ success: false, error: error.message })

  await supabase.from('inventory_events').insert({
    jewelcode,
    action: 'return',
    source: 'admin',
    metadata: { previous_status: piece.status, reason: reason || 'not provided' },
    timestamp: new Date().toISOString()
  })

  return res.json({
    success: true,
    message: `Piece ${jewelcode} marked as returned and available again`
  })
})

// ----------------------------------------------------------
// POST /admin/repair
// Mark a piece as in repair (takes it out of available pool)
//
// Body: { jewelcode: "AC-001234", reason: "clasp broken" }
// ----------------------------------------------------------
router.post('/repair', async (req, res) => {
  const { jewelcode, reason } = req.body

  if (!jewelcode) {
    return res.status(400).json({ success: false, error: 'jewelcode is required' })
  }

  const { error } = await supabase
    .from('inventory_pieces')
    .update({
      status: 'repair',
      updated_at: new Date().toISOString()
    })
    .eq('jewelcode', jewelcode)

  if (error) return res.status(500).json({ success: false, error: error.message })

  await supabase.from('inventory_events').insert({
    jewelcode,
    action: 'repair',
    source: 'admin',
    metadata: { reason: reason || 'not provided' },
    timestamp: new Date().toISOString()
  })

  return res.json({
    success: true,
    message: `Piece ${jewelcode} marked as in repair`
  })
})

module.exports = router
