import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB: D1Database
}

type CrewMember = {
  id: number
  name: string
  level: 'Senior' | 'Mid' | 'Junior' | 'Hired'
  can_stage: boolean
  stage_only_if_urgent: boolean
  venue_capabilities: Record<string, string>
  vertical_capabilities: Record<string, string>
  special_notes: string
}

type Event = {
  id: number
  batch_id: string
  name: string
  event_date: string
  venue: string
  vertical: string
  stage_crew_needed: number
  event_group: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

// ============================================
// CREW API
// ============================================

app.get('/api/crew', async (c) => {
  const { DB } = c.env
  const crew = await DB.prepare('SELECT * FROM crew ORDER BY level, name').all()
  return c.json(crew.results.map((c: any) => ({
    ...c,
    venue_capabilities: JSON.parse(c.venue_capabilities),
    vertical_capabilities: JSON.parse(c.vertical_capabilities)
  })))
})

// ============================================
// UNAVAILABILITY API
// ============================================

app.get('/api/unavailability', async (c) => {
  const { DB } = c.env
  const month = c.req.query('month') // YYYY-MM format
  
  let query = 'SELECT cu.*, c.name as crew_name FROM crew_unavailability cu JOIN crew c ON cu.crew_id = c.id'
  let results
  
  if (month) {
    query += ' WHERE unavailable_date LIKE ?'
    results = await DB.prepare(query).bind(`${month}%`).all()
  } else {
    results = await DB.prepare(query).all()
  }
  
  return c.json(results.results)
})

app.post('/api/unavailability', async (c) => {
  const { DB } = c.env
  const body = await c.req.json()
  const { crew_id, unavailable_date, reason } = body
  
  await DB.prepare(
    'INSERT OR IGNORE INTO crew_unavailability (crew_id, unavailable_date, reason) VALUES (?, ?, ?)'
  ).bind(crew_id, unavailable_date, reason || null).run()
  
  return c.json({ success: true })
})

app.delete('/api/unavailability', async (c) => {
  const { DB } = c.env
  const { crew_id, unavailable_date } = await c.req.json()
  
  await DB.prepare(
    'DELETE FROM crew_unavailability WHERE crew_id = ? AND unavailable_date = ?'
  ).bind(crew_id, unavailable_date).run()
  
  return c.json({ success: true })
})

app.post('/api/unavailability/bulk', async (c) => {
  const { DB } = c.env
  const { entries } = await c.req.json() // [{crew_id, unavailable_date, action: 'add'|'remove'}]
  
  for (const entry of entries) {
    if (entry.action === 'add') {
      await DB.prepare(
        'INSERT OR IGNORE INTO crew_unavailability (crew_id, unavailable_date) VALUES (?, ?)'
      ).bind(entry.crew_id, entry.unavailable_date).run()
    } else {
      await DB.prepare(
        'DELETE FROM crew_unavailability WHERE crew_id = ? AND unavailable_date = ?'
      ).bind(entry.crew_id, entry.unavailable_date).run()
    }
  }
  
  return c.json({ success: true })
})

// ============================================
// EVENTS API
// ============================================

app.post('/api/events/upload', async (c) => {
  const { DB } = c.env
  const { events } = await c.req.json()
  
  const batchId = `batch_${Date.now()}`
  
  // Group multi-day events by name
  const eventGroups: Record<string, any[]> = {}
  for (const event of events) {
    if (!eventGroups[event.name]) {
      eventGroups[event.name] = []
    }
    eventGroups[event.name].push(event)
  }
  
  // Venue defaults for stage crew
  const venueDefaults: Record<string, number> = {
    'JBT': 2,
    'Tata': 2,
    'Experimental': 1,
    'Little Theatre': 1,
    'Godrej Dance': 1,
    'Others': 1
  }
  
  const insertedEvents = []
  
  for (const [name, groupEvents] of Object.entries(eventGroups)) {
    const eventGroup = groupEvents.length > 1 ? `group_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : null
    
    for (const event of groupEvents) {
      const defaultStage = venueDefaults[event.venue] || 1
      
      const result = await DB.prepare(
        `INSERT INTO events (batch_id, name, event_date, venue, vertical, stage_crew_needed, event_group) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(batchId, event.name, event.date, event.venue, event.vertical, defaultStage, eventGroup).run()
      
      insertedEvents.push({
        id: result.meta.last_row_id,
        batch_id: batchId,
        name: event.name,
        event_date: event.date,
        venue: event.venue,
        vertical: event.vertical,
        stage_crew_needed: defaultStage,
        event_group: eventGroup,
        is_multi_day: groupEvents.length > 1,
        total_days: groupEvents.length
      })
    }
  }
  
  return c.json({ batch_id: batchId, events: insertedEvents })
})

app.get('/api/events', async (c) => {
  const { DB } = c.env
  const batchId = c.req.query('batch_id')
  
  let query = 'SELECT * FROM events'
  let results
  
  if (batchId) {
    query += ' WHERE batch_id = ? ORDER BY event_date, name'
    results = await DB.prepare(query).bind(batchId).all()
  } else {
    query += ' ORDER BY event_date, name'
    results = await DB.prepare(query).all()
  }
  
  return c.json(results.results)
})

app.put('/api/events/:id', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const { stage_crew_needed } = await c.req.json()
  
  await DB.prepare('UPDATE events SET stage_crew_needed = ? WHERE id = ?').bind(stage_crew_needed, id).run()
  
  return c.json({ success: true })
})

// ============================================
// ASSIGNMENT ENGINE
// ============================================

const LEVEL_ORDER = { 'Senior': 0, 'Mid': 1, 'Junior': 2, 'Hired': 3 }

function canDoFOH(crew: CrewMember, venue: string, vertical: string): { can: boolean, isSpecialist: boolean, specialCondition?: string } {
  const venueCapability = crew.venue_capabilities[venue]
  const verticalCapability = crew.vertical_capabilities[vertical]
  
  // Check venue capability
  if (!venueCapability || venueCapability === 'N') {
    return { can: false, isSpecialist: false }
  }
  
  // Check vertical capability
  if (!verticalCapability || verticalCapability === 'N') {
    return { can: false, isSpecialist: false }
  }
  
  // Special case: "Exp only" for Int'l Music
  if (verticalCapability === 'Exp only') {
    if (venue === 'Experimental') {
      return { can: true, isSpecialist: false, specialCondition: 'Exp only' }
    }
    return { can: false, isSpecialist: false }
  }
  
  // Check if specialist (Y*)
  const isVenueSpecialist = venueCapability === 'Y*'
  const isVerticalSpecialist = verticalCapability === 'Y*'
  
  return { 
    can: true, 
    isSpecialist: isVenueSpecialist || isVerticalSpecialist 
  }
}

function canDoStage(crew: CrewMember): boolean {
  return crew.can_stage
}

app.post('/api/assignments/run', async (c) => {
  const { DB } = c.env
  const { batch_id } = await c.req.json()
  
  // Get all events for this batch
  const eventsResult = await DB.prepare(
    'SELECT * FROM events WHERE batch_id = ? ORDER BY event_date, name'
  ).bind(batch_id).all()
  const events = eventsResult.results as Event[]
  
  // Get all crew
  const crewResult = await DB.prepare('SELECT * FROM crew').all()
  const crew = crewResult.results.map((c: any) => ({
    ...c,
    venue_capabilities: JSON.parse(c.venue_capabilities),
    vertical_capabilities: JSON.parse(c.vertical_capabilities)
  })) as CrewMember[]
  
  // Get month for workload tracking (from first event)
  const month = events[0]?.event_date?.substring(0, 7) || new Date().toISOString().substring(0, 7)
  
  // Get current month workload
  const workloadResult = await DB.prepare(
    'SELECT crew_id, assignment_count FROM workload_history WHERE month = ?'
  ).bind(month).all()
  const workloadMap: Record<number, number> = {}
  for (const w of workloadResult.results as any[]) {
    workloadMap[w.crew_id] = w.assignment_count
  }
  
  // Get unavailability
  const unavailResult = await DB.prepare(
    'SELECT crew_id, unavailable_date FROM crew_unavailability'
  ).all()
  const unavailMap: Record<string, Set<number>> = {} // date -> Set of crew_ids
  for (const u of unavailResult.results as any[]) {
    if (!unavailMap[u.unavailable_date]) {
      unavailMap[u.unavailable_date] = new Set()
    }
    unavailMap[u.unavailable_date].add(u.crew_id)
  }
  
  // Track assignments during this run
  const dailyAssignments: Record<string, Set<number>> = {} // date -> Set of crew_ids assigned
  const multiDayAssignments: Record<string, { foh: number | null, stage: number[] }> = {} // event_group -> {foh, stage}
  
  // Clear existing assignments for this batch
  const eventIds = events.map(e => e.id)
  if (eventIds.length > 0) {
    await DB.prepare(
      `DELETE FROM assignments WHERE event_id IN (${eventIds.join(',')})`
    ).run()
  }
  
  const assignments: any[] = []
  const conflicts: any[] = []
  
  // Sort events: multi-day first, then by date
  const sortedEvents = [...events].sort((a, b) => {
    if (a.event_group && !b.event_group) return -1
    if (!a.event_group && b.event_group) return 1
    return a.event_date.localeCompare(b.event_date)
  })
  
  for (const event of sortedEvents) {
    const eventAssignment: any = {
      event_id: event.id,
      event_name: event.name,
      event_date: event.event_date,
      venue: event.venue,
      vertical: event.vertical,
      foh: null,
      stage: [],
      foh_conflict: false,
      stage_conflict: false
    }
    
    // Get all dates for this event (multi-day support)
    let eventDates: string[] = [event.event_date]
    if (event.event_group) {
      const groupEvents = events.filter(e => e.event_group === event.event_group)
      eventDates = groupEvents.map(e => e.event_date)
      
      // If already assigned for this group, use same crew
      if (multiDayAssignments[event.event_group]) {
        const existing = multiDayAssignments[event.event_group]
        eventAssignment.foh = existing.foh
        eventAssignment.stage = [...existing.stage]
        
        // Save assignments
        if (existing.foh) {
          await DB.prepare(
            'INSERT INTO assignments (event_id, crew_id, role) VALUES (?, ?, ?)'
          ).bind(event.id, existing.foh, 'FOH').run()
        }
        for (const stageCrewId of existing.stage) {
          await DB.prepare(
            'INSERT INTO assignments (event_id, crew_id, role) VALUES (?, ?, ?)'
          ).bind(event.id, stageCrewId, 'Stage').run()
        }
        
        assignments.push(eventAssignment)
        continue
      }
    }
    
    // Initialize daily assignments tracking for all event dates
    for (const date of eventDates) {
      if (!dailyAssignments[date]) {
        dailyAssignments[date] = new Set()
      }
    }
    
    // Helper to check if crew is available for all event dates
    const isAvailableForAllDates = (crewId: number): boolean => {
      for (const date of eventDates) {
        // Check unavailability
        if (unavailMap[date]?.has(crewId)) return false
        // Check already assigned
        if (dailyAssignments[date]?.has(crewId)) return false
      }
      return true
    }
    
    // ========== FOH ASSIGNMENT ==========
    // Build candidate list with scoring
    const fohCandidates: { crew: CrewMember, score: number, isSpecialist: boolean }[] = []
    
    for (const c of crew) {
      if (c.level === 'Hired') continue // Hired crew can't do FOH
      if (!isAvailableForAllDates(c.id)) continue
      
      const capability = canDoFOH(c, event.venue, event.vertical)
      if (!capability.can) continue
      
      const workload = workloadMap[c.id] || 0
      
      // Score: level priority + specialist bonus - workload
      let score = (3 - LEVEL_ORDER[c.level]) * 100 // Senior=300, Mid=200, Junior=100
      if (capability.isSpecialist) score += 50
      score -= workload * 10
      
      fohCandidates.push({ crew: c, score, isSpecialist: capability.isSpecialist })
    }
    
    // Sort by score descending
    fohCandidates.sort((a, b) => b.score - a.score)
    
    if (fohCandidates.length > 0) {
      const selectedFOH = fohCandidates[0].crew
      eventAssignment.foh = selectedFOH.id
      eventAssignment.foh_name = selectedFOH.name
      eventAssignment.foh_level = selectedFOH.level
      eventAssignment.foh_specialist = fohCandidates[0].isSpecialist
      
      // Mark as assigned for all event dates
      for (const date of eventDates) {
        dailyAssignments[date].add(selectedFOH.id)
      }
      
      // Update workload tracking
      workloadMap[selectedFOH.id] = (workloadMap[selectedFOH.id] || 0) + eventDates.length
      
      // Save to DB
      await DB.prepare(
        'INSERT INTO assignments (event_id, crew_id, role) VALUES (?, ?, ?)'
      ).bind(event.id, selectedFOH.id, 'FOH').run()
    } else {
      eventAssignment.foh_conflict = true
      conflicts.push({
        event_id: event.id,
        event_name: event.name,
        type: 'FOH',
        reason: 'No qualified FOH crew available'
      })
    }
    
    // ========== STAGE ASSIGNMENT ==========
    const stageCandidates: { crew: CrewMember, score: number }[] = []
    
    for (const c of crew) {
      if (!canDoStage(c)) continue
      if (c.id === eventAssignment.foh) continue // FOH can't also do stage
      if (!isAvailableForAllDates(c.id)) continue
      
      // For stage, seniors with stage_only_if_urgent should be lower priority
      const workload = workloadMap[c.id] || 0
      
      let score = (3 - LEVEL_ORDER[c.level]) * 50
      if (c.stage_only_if_urgent) score -= 200 // Penalize seniors for stage work
      score -= workload * 10
      
      stageCandidates.push({ crew: c, score })
    }
    
    // Sort by score descending
    stageCandidates.sort((a, b) => b.score - a.score)
    
    // Select required number of stage crew
    const stageNeeded = event.stage_crew_needed
    const selectedStage: number[] = []
    
    for (let i = 0; i < Math.min(stageNeeded, stageCandidates.length); i++) {
      const stageCrew = stageCandidates[i].crew
      selectedStage.push(stageCrew.id)
      
      // Mark as assigned for all event dates
      for (const date of eventDates) {
        dailyAssignments[date].add(stageCrew.id)
      }
      
      // Update workload
      workloadMap[stageCrew.id] = (workloadMap[stageCrew.id] || 0) + eventDates.length
      
      // Save to DB
      await DB.prepare(
        'INSERT INTO assignments (event_id, crew_id, role) VALUES (?, ?, ?)'
      ).bind(event.id, stageCrew.id, 'Stage').run()
    }
    
    eventAssignment.stage = selectedStage
    eventAssignment.stage_names = selectedStage.map(id => crew.find(c => c.id === id)?.name).filter(Boolean)
    
    if (selectedStage.length < stageNeeded) {
      eventAssignment.stage_conflict = true
      conflicts.push({
        event_id: event.id,
        event_name: event.name,
        type: 'Stage',
        reason: `Only ${selectedStage.length}/${stageNeeded} stage crew available`
      })
    }
    
    // Track multi-day assignments
    if (event.event_group) {
      multiDayAssignments[event.event_group] = {
        foh: eventAssignment.foh,
        stage: selectedStage
      }
    }
    
    assignments.push(eventAssignment)
  }
  
  // Update workload history in DB
  for (const [crewId, count] of Object.entries(workloadMap)) {
    await DB.prepare(
      `INSERT INTO workload_history (crew_id, month, assignment_count) VALUES (?, ?, ?)
       ON CONFLICT(crew_id, month) DO UPDATE SET assignment_count = ?`
    ).bind(parseInt(crewId), month, count, count).run()
  }
  
  return c.json({ assignments, conflicts })
})

// Get assignments for a batch
app.get('/api/assignments', async (c) => {
  const { DB } = c.env
  const batchId = c.req.query('batch_id')
  
  const query = `
    SELECT 
      a.*, 
      e.name as event_name, 
      e.event_date, 
      e.venue, 
      e.vertical,
      e.stage_crew_needed,
      e.event_group,
      c.name as crew_name,
      c.level as crew_level
    FROM assignments a
    JOIN events e ON a.event_id = e.id
    JOIN crew c ON a.crew_id = c.id
    WHERE e.batch_id = ?
    ORDER BY e.event_date, e.name, a.role DESC
  `
  
  const results = await DB.prepare(query).bind(batchId).all()
  return c.json(results.results)
})

// Update single assignment
app.put('/api/assignments/:eventId', async (c) => {
  const { DB } = c.env
  const eventId = c.req.param('eventId')
  const { foh_id, stage_ids } = await c.req.json()
  
  // Delete existing assignments for this event
  await DB.prepare('DELETE FROM assignments WHERE event_id = ?').bind(eventId).run()
  
  // Insert new FOH
  if (foh_id) {
    await DB.prepare(
      'INSERT INTO assignments (event_id, crew_id, role, was_manually_overridden) VALUES (?, ?, ?, 1)'
    ).bind(eventId, foh_id, 'FOH').run()
  }
  
  // Insert new stage crew
  for (const stageId of stage_ids || []) {
    await DB.prepare(
      'INSERT INTO assignments (event_id, crew_id, role, was_manually_overridden) VALUES (?, ?, ?, 1)'
    ).bind(eventId, stageId, 'Stage').run()
  }
  
  return c.json({ success: true })
})

// ============================================
// EXPORT API
// ============================================

app.get('/api/export/csv', async (c) => {
  const { DB } = c.env
  const batchId = c.req.query('batch_id')
  
  const events = await DB.prepare(
    'SELECT * FROM events WHERE batch_id = ? ORDER BY event_date, name'
  ).bind(batchId).all()
  
  const assignments = await DB.prepare(`
    SELECT a.event_id, a.role, c.name as crew_name
    FROM assignments a
    JOIN events e ON a.event_id = e.id
    JOIN crew c ON a.crew_id = c.id
    WHERE e.batch_id = ?
  `).bind(batchId).all()
  
  // Group assignments by event
  const assignmentMap: Record<number, { foh: string, stage: string[] }> = {}
  for (const a of assignments.results as any[]) {
    if (!assignmentMap[a.event_id]) {
      assignmentMap[a.event_id] = { foh: '', stage: [] }
    }
    if (a.role === 'FOH') {
      assignmentMap[a.event_id].foh = a.crew_name
    } else {
      assignmentMap[a.event_id].stage.push(a.crew_name)
    }
  }
  
  // Build CSV
  let csv = 'Event Name,Date,Venue,Vertical,FOH,Stage Crew\n'
  for (const e of events.results as any[]) {
    const assignment = assignmentMap[e.id] || { foh: '', stage: [] }
    csv += `"${e.name}","${e.event_date}","${e.venue}","${e.vertical}","${assignment.foh}","${assignment.stage.join(', ')}"\n`
  }
  
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="crew_assignments_${batchId}.csv"`
    }
  })
})

app.get('/api/export/calendar', async (c) => {
  const { DB } = c.env
  const batchId = c.req.query('batch_id')
  
  const events = await DB.prepare(
    'SELECT * FROM events WHERE batch_id = ? ORDER BY event_date, name'
  ).bind(batchId).all()
  
  const assignments = await DB.prepare(`
    SELECT a.event_id, a.role, c.name as crew_name
    FROM assignments a
    JOIN events e ON a.event_id = e.id
    JOIN crew c ON a.crew_id = c.id
    WHERE e.batch_id = ?
  `).bind(batchId).all()
  
  // Group assignments by event
  const assignmentMap: Record<number, { foh: string, stage: string[] }> = {}
  for (const a of assignments.results as any[]) {
    if (!assignmentMap[a.event_id]) {
      assignmentMap[a.event_id] = { foh: '', stage: [] }
    }
    if (a.role === 'FOH') {
      assignmentMap[a.event_id].foh = a.crew_name
    } else {
      assignmentMap[a.event_id].stage.push(a.crew_name)
    }
  }
  
  // Group multi-day events
  const eventGroups: Record<string, any[]> = {}
  for (const e of events.results as any[]) {
    const key = e.event_group || `single_${e.id}`
    if (!eventGroups[key]) {
      eventGroups[key] = []
    }
    eventGroups[key].push(e)
  }
  
  // Build calendar CSV
  let csv = 'Subject,Start Date,End Date,Description\n'
  for (const [, groupEvents] of Object.entries(eventGroups)) {
    groupEvents.sort((a, b) => a.event_date.localeCompare(b.event_date))
    const firstEvent = groupEvents[0]
    const lastEvent = groupEvents[groupEvents.length - 1]
    const assignment = assignmentMap[firstEvent.id] || { foh: '', stage: [] }
    
    const description = `Venue: ${firstEvent.venue} | Vertical: ${firstEvent.vertical} | FOH: ${assignment.foh} | Stage: ${assignment.stage.join(', ')}`
    csv += `"${firstEvent.name}","${firstEvent.event_date}","${lastEvent.event_date}","${description}"\n`
  }
  
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="calendar_import_${batchId}.csv"`
    }
  })
})

app.get('/api/export/workload', async (c) => {
  const { DB } = c.env
  const month = c.req.query('month')
  
  const workload = await DB.prepare(`
    SELECT c.name, c.level, COALESCE(w.assignment_count, 0) as assignments
    FROM crew c
    LEFT JOIN workload_history w ON c.id = w.crew_id AND w.month = ?
    ORDER BY c.level, c.name
  `).bind(month).all()
  
  let csv = 'Crew Name,Level,Assignments This Month\n'
  for (const w of workload.results as any[]) {
    csv += `"${w.name}","${w.level}",${w.assignments}\n`
  }
  
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="workload_${month}.csv"`
    }
  })
})

// ============================================
// MAIN PAGE
// ============================================

app.get('/', (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NCPA Crew Assignment Helper</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
      
      * { font-family: 'Inter', sans-serif; }
      
      body {
        background: linear-gradient(135deg, #0f1419 0%, #1a2332 50%, #0f1419 100%);
        min-height: 100vh;
      }
      
      .glass-card {
        background: rgba(255, 255, 255, 0.03);
        backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 20px;
      }
      
      .glass-card-light {
        background: rgba(255, 255, 255, 0.05);
        backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 16px;
      }
      
      .glow-blue {
        box-shadow: 0 0 20px rgba(96, 165, 250, 0.15);
      }
      
      .text-cream { color: #f5f0e8; }
      .text-muted { color: #9ca3af; }
      .bg-accent { background: rgba(96, 165, 250, 0.15); }
      
      .btn-primary {
        background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
        transition: all 0.3s ease;
      }
      .btn-primary:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 20px rgba(59, 130, 246, 0.4);
      }
      
      .btn-secondary {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.15);
        transition: all 0.3s ease;
      }
      .btn-secondary:hover {
        background: rgba(255, 255, 255, 0.12);
      }
      
      .step-indicator {
        transition: all 0.3s ease;
      }
      .step-indicator.active {
        background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
        transform: scale(1.1);
      }
      .step-indicator.completed {
        background: #5eead4;
      }
      
      .day-cell {
        width: 36px;
        height: 36px;
        border-radius: 10px;
        transition: all 0.2s ease;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
      }
      .day-cell:hover { background: rgba(96, 165, 250, 0.2); }
      .day-cell.unavailable { background: rgba(248, 113, 113, 0.3); color: #f87171; }
      .day-cell.weekend { background: rgba(251, 191, 36, 0.1); }
      
      .upload-zone {
        border: 2px dashed rgba(96, 165, 250, 0.3);
        border-radius: 16px;
        transition: all 0.3s ease;
      }
      .upload-zone:hover, .upload-zone.dragover {
        border-color: rgba(96, 165, 250, 0.6);
        background: rgba(96, 165, 250, 0.05);
      }
      
      .fade-in {
        animation: fadeIn 0.3s ease-out;
      }
      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
      }
      
      .slide-up {
        animation: slideUp 0.4s ease-out;
      }
      @keyframes slideUp {
        from { opacity: 0; transform: translateY(20px); }
        to { opacity: 1; transform: translateY(0); }
      }
      
      input, select {
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 10px;
        color: #f5f0e8;
        padding: 8px 12px;
      }
      input:focus, select:focus {
        outline: none;
        border-color: rgba(96, 165, 250, 0.5);
      }
      
      .conflict-badge {
        background: rgba(248, 113, 113, 0.2);
        color: #f87171;
        padding: 2px 8px;
        border-radius: 6px;
        font-size: 11px;
      }
      
      .specialist-badge {
        background: rgba(251, 191, 36, 0.2);
        color: #fbbf24;
        padding: 2px 8px;
        border-radius: 6px;
        font-size: 11px;
      }
      
      .modal-overlay {
        background: rgba(0, 0, 0, 0.7);
        backdrop-filter: blur(4px);
      }
      
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: rgba(255,255,255,0.05); border-radius: 4px; }
      ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
    </style>
</head>
<body class="text-cream">
    <div id="app" class="min-h-screen p-6">
      <!-- Header -->
      <header class="max-w-6xl mx-auto mb-8 fade-in">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="text-2xl font-semibold tracking-tight">
              <i class="fas fa-sliders-h text-blue-400 mr-3"></i>
              NCPA Crew Assignment Helper
            </h1>
            <p class="text-muted text-sm mt-1">Bulk assignment co-pilot for sound crew scheduling</p>
          </div>
          <div id="step-indicators" class="flex items-center gap-3">
            <div class="step-indicator w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium active" data-step="1">1</div>
            <div class="w-8 h-0.5 bg-gray-700"></div>
            <div class="step-indicator w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium bg-gray-700" data-step="2">2</div>
            <div class="w-8 h-0.5 bg-gray-700"></div>
            <div class="step-indicator w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium bg-gray-700" data-step="3">3</div>
            <div class="w-8 h-0.5 bg-gray-700"></div>
            <div class="step-indicator w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium bg-gray-700" data-step="4">4</div>
            <div class="w-8 h-0.5 bg-gray-700"></div>
            <div class="step-indicator w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium bg-gray-700" data-step="5">5</div>
          </div>
        </div>
      </header>
      
      <!-- Main Content -->
      <main class="max-w-6xl mx-auto">
        <!-- Step 1: Crew Day-Offs -->
        <section id="step1" class="glass-card p-8 mb-6 slide-up">
          <div class="flex items-center justify-between mb-6">
            <div>
              <h2 class="text-xl font-semibold flex items-center gap-3">
                <i class="fas fa-calendar-alt text-blue-400"></i>
                Crew Availability
              </h2>
              <p class="text-muted text-sm mt-1">Mark day-offs for all crew members</p>
            </div>
            <div class="flex items-center gap-3">
              <button id="prev-month" class="btn-secondary px-4 py-2 rounded-xl text-sm">
                <i class="fas fa-chevron-left"></i>
              </button>
              <span id="current-month" class="text-lg font-medium px-4">February 2026</span>
              <button id="next-month" class="btn-secondary px-4 py-2 rounded-xl text-sm">
                <i class="fas fa-chevron-right"></i>
              </button>
            </div>
          </div>
          
          <div class="flex gap-3 mb-4">
            <button id="mark-weekends" class="btn-secondary px-4 py-2 rounded-xl text-sm">
              <i class="fas fa-calendar-week mr-2"></i>Mark All Weekends
            </button>
            <button id="clear-month" class="btn-secondary px-4 py-2 rounded-xl text-sm">
              <i class="fas fa-eraser mr-2"></i>Clear Month
            </button>
          </div>
          
          <div id="availability-grid" class="glass-card-light p-4 overflow-x-auto">
            <!-- Calendar grid will be rendered here -->
          </div>
          
          <div class="flex justify-between items-center mt-6">
            <div class="flex items-center gap-4 text-sm text-muted">
              <span><span class="inline-block w-4 h-4 rounded bg-red-400/30 mr-2"></span>Day Off</span>
              <span><span class="inline-block w-4 h-4 rounded bg-amber-400/10 mr-2"></span>Weekend</span>
            </div>
            <button id="step1-next" class="btn-primary px-6 py-3 rounded-xl font-medium">
              Continue <i class="fas fa-arrow-right ml-2"></i>
            </button>
          </div>
        </section>
        
        <!-- Step 2: Upload Events -->
        <section id="step2" class="glass-card p-8 mb-6 hidden">
          <h2 class="text-xl font-semibold flex items-center gap-3 mb-6">
            <i class="fas fa-upload text-blue-400"></i>
            Upload Events
          </h2>
          
          <div id="upload-zone" class="upload-zone p-12 text-center cursor-pointer">
            <i class="fas fa-cloud-upload-alt text-4xl text-blue-400 mb-4"></i>
            <p class="text-lg mb-2">Drop CSV file here or click to browse</p>
            <p class="text-muted text-sm">Format: Event Name, Date (YYYY-MM-DD), Venue, Vertical</p>
            <input type="file" id="csv-input" accept=".csv" class="hidden">
          </div>
          
          <div id="upload-preview" class="hidden mt-6">
            <div class="glass-card-light p-4">
              <div class="flex items-center justify-between mb-4">
                <span class="font-medium"><i class="fas fa-check-circle text-teal-400 mr-2"></i><span id="event-count">0</span> events loaded</span>
                <span class="text-muted text-sm" id="multiday-count"></span>
              </div>
              <div id="preview-table" class="max-h-64 overflow-y-auto">
                <!-- Preview table will be rendered here -->
              </div>
            </div>
          </div>
          
          <div class="flex justify-between mt-6">
            <button id="step2-back" class="btn-secondary px-6 py-3 rounded-xl font-medium">
              <i class="fas fa-arrow-left mr-2"></i> Back
            </button>
            <button id="step2-next" class="btn-primary px-6 py-3 rounded-xl font-medium hidden">
              Continue <i class="fas fa-arrow-right ml-2"></i>
            </button>
          </div>
        </section>
        
        <!-- Step 3: Stage Crew Requirements -->
        <section id="step3" class="glass-card p-8 mb-6 hidden">
          <h2 class="text-xl font-semibold flex items-center gap-3 mb-6">
            <i class="fas fa-users text-blue-400"></i>
            Stage Crew Requirements
          </h2>
          
          <div id="stage-requirements" class="glass-card-light p-4 max-h-96 overflow-y-auto">
            <!-- Stage crew input table will be rendered here -->
          </div>
          
          <div class="flex justify-between mt-6">
            <button id="step3-back" class="btn-secondary px-6 py-3 rounded-xl font-medium">
              <i class="fas fa-arrow-left mr-2"></i> Back
            </button>
            <button id="step3-run" class="btn-primary px-6 py-3 rounded-xl font-medium">
              <i class="fas fa-magic mr-2"></i> Run Assignment Engine
            </button>
          </div>
        </section>
        
        <!-- Step 4: Review & Edit -->
        <section id="step4" class="glass-card p-8 mb-6 hidden">
          <h2 class="text-xl font-semibold flex items-center gap-3 mb-2">
            <i class="fas fa-clipboard-check text-blue-400"></i>
            Review Assignments
          </h2>
          <p class="text-muted text-sm mb-6" id="conflict-summary"></p>
          
          <!-- Conflicts Section -->
          <div id="conflicts-section" class="hidden mb-6">
            <h3 class="font-medium text-amber-400 mb-3"><i class="fas fa-exclamation-triangle mr-2"></i>Conflicts Requiring Attention</h3>
            <div id="conflicts-list" class="space-y-3">
              <!-- Conflicts will be rendered here -->
            </div>
          </div>
          
          <!-- All Assignments -->
          <div id="assignments-table" class="glass-card-light p-4 max-h-96 overflow-y-auto">
            <!-- Assignments table will be rendered here -->
          </div>
          
          <div class="flex justify-between mt-6">
            <button id="step4-back" class="btn-secondary px-6 py-3 rounded-xl font-medium">
              <i class="fas fa-arrow-left mr-2"></i> Back
            </button>
            <button id="step4-next" class="btn-primary px-6 py-3 rounded-xl font-medium">
              Finalize <i class="fas fa-arrow-right ml-2"></i>
            </button>
          </div>
        </section>
        
        <!-- Step 5: Export -->
        <section id="step5" class="glass-card p-8 mb-6 hidden">
          <h2 class="text-xl font-semibold flex items-center gap-3 mb-6">
            <i class="fas fa-download text-blue-400"></i>
            Export Assignments
          </h2>
          
          <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div class="glass-card-light p-6 text-center hover:glow-blue transition-all cursor-pointer" id="export-csv">
              <i class="fas fa-file-csv text-4xl text-blue-400 mb-4"></i>
              <h3 class="font-medium mb-2">Standard CSV</h3>
              <p class="text-muted text-sm">Excel / Google Sheets compatible</p>
            </div>
            <div class="glass-card-light p-6 text-center hover:glow-blue transition-all cursor-pointer" id="export-calendar">
              <i class="fas fa-calendar-plus text-4xl text-teal-400 mb-4"></i>
              <h3 class="font-medium mb-2">Calendar Import</h3>
              <p class="text-muted text-sm">Google Calendar format</p>
            </div>
            <div class="glass-card-light p-6 text-center hover:glow-blue transition-all cursor-pointer" id="export-workload">
              <i class="fas fa-chart-bar text-4xl text-amber-400 mb-4"></i>
              <h3 class="font-medium mb-2">Workload Report</h3>
              <p class="text-muted text-sm">Crew assignment summary</p>
            </div>
          </div>
          
          <div class="flex justify-between mt-6">
            <button id="step5-back" class="btn-secondary px-6 py-3 rounded-xl font-medium">
              <i class="fas fa-arrow-left mr-2"></i> Back to Edit
            </button>
            <button id="start-new" class="btn-primary px-6 py-3 rounded-xl font-medium">
              <i class="fas fa-plus mr-2"></i> Start New Batch
            </button>
          </div>
        </section>
      </main>
      
      <!-- Edit Modal -->
      <div id="edit-modal" class="fixed inset-0 modal-overlay hidden items-center justify-center z-50">
        <div class="glass-card p-6 w-full max-w-lg mx-4 slide-up">
          <div class="flex justify-between items-start mb-6">
            <div>
              <h3 class="text-lg font-semibold" id="modal-title">Edit Assignment</h3>
              <p class="text-muted text-sm" id="modal-subtitle"></p>
            </div>
            <button id="modal-close" class="text-gray-400 hover:text-white">
              <i class="fas fa-times text-xl"></i>
            </button>
          </div>
          
          <div class="space-y-4">
            <div>
              <label class="block text-sm font-medium mb-2">FOH Engineer</label>
              <select id="modal-foh" class="w-full py-3"></select>
            </div>
            <div>
              <label class="block text-sm font-medium mb-2">Stage Crew <span id="modal-stage-count" class="text-muted">(select 2)</span></label>
              <div id="modal-stage" class="glass-card-light p-3 max-h-48 overflow-y-auto space-y-2">
                <!-- Stage checkboxes will be rendered here -->
              </div>
            </div>
          </div>
          
          <div class="flex justify-end gap-3 mt-6">
            <button id="modal-cancel" class="btn-secondary px-4 py-2 rounded-xl">Cancel</button>
            <button id="modal-save" class="btn-primary px-4 py-2 rounded-xl">Save Changes</button>
          </div>
        </div>
      </div>
    </div>
    
    <script>
      // ============================================
      // STATE
      // ============================================
      let currentStep = 1;
      let currentMonth = new Date();
      currentMonth.setMonth(currentMonth.getMonth() + 1); // Default to next month
      
      let crew = [];
      let unavailability = {};  // {crew_id: Set of dates}
      let uploadedEvents = [];
      let batchId = null;
      let assignments = [];
      let conflicts = [];
      
      // ============================================
      // INITIALIZATION
      // ============================================
      async function init() {
        await loadCrew();
        renderAvailabilityGrid();
        setupEventListeners();
      }
      
      async function loadCrew() {
        const res = await fetch('/api/crew');
        crew = await res.json();
        
        // Load existing unavailability
        const month = formatMonth(currentMonth);
        const unavailRes = await fetch('/api/unavailability?month=' + month);
        const unavailData = await unavailRes.json();
        
        unavailability = {};
        for (const u of unavailData) {
          if (!unavailability[u.crew_id]) {
            unavailability[u.crew_id] = new Set();
          }
          unavailability[u.crew_id].add(u.unavailable_date);
        }
      }
      
      // ============================================
      // STEP 1: AVAILABILITY
      // ============================================
      function renderAvailabilityGrid() {
        const grid = document.getElementById('availability-grid');
        const year = currentMonth.getFullYear();
        const month = currentMonth.getMonth();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        
        document.getElementById('current-month').textContent = 
          currentMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        
        let html = '<table class="w-full text-sm"><thead><tr><th class="text-left py-2 px-3 text-muted font-medium">Crew</th>';
        
        // Day headers
        for (let d = 1; d <= daysInMonth; d++) {
          const date = new Date(year, month, d);
          const isWeekend = date.getDay() === 0 || date.getDay() === 6;
          const dayName = date.toLocaleDateString('en-US', { weekday: 'short' }).charAt(0);
          html += '<th class="text-center py-2 ' + (isWeekend ? 'text-amber-400' : 'text-muted') + ' font-medium">' + dayName + '<br>' + d + '</th>';
        }
        html += '</tr></thead><tbody>';
        
        // Crew rows
        for (const c of crew) {
          const levelColor = c.level === 'Senior' ? 'text-blue-400' : c.level === 'Mid' ? 'text-teal-400' : c.level === 'Junior' ? 'text-amber-400' : 'text-gray-400';
          html += '<tr><td class="py-2 px-3 whitespace-nowrap"><span class="' + levelColor + ' text-xs mr-2">' + c.level.charAt(0) + '</span>' + c.name + '</td>';
          
          for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
            const date = new Date(year, month, d);
            const isWeekend = date.getDay() === 0 || date.getDay() === 6;
            const isUnavailable = unavailability[c.id]?.has(dateStr);
            
            let cellClass = 'day-cell';
            if (isUnavailable) cellClass += ' unavailable';
            else if (isWeekend) cellClass += ' weekend';
            
            html += '<td class="p-0.5"><div class="' + cellClass + '" data-crew="' + c.id + '" data-date="' + dateStr + '">' + (isUnavailable ? '✕' : '') + '</div></td>';
          }
          html += '</tr>';
        }
        
        html += '</tbody></table>';
        grid.innerHTML = html;
        
        // Add click handlers
        grid.querySelectorAll('.day-cell').forEach(cell => {
          cell.addEventListener('click', () => toggleUnavailability(cell));
        });
      }
      
      async function toggleUnavailability(cell) {
        const crewId = parseInt(cell.dataset.crew);
        const date = cell.dataset.date;
        
        if (!unavailability[crewId]) {
          unavailability[crewId] = new Set();
        }
        
        const isCurrentlyUnavailable = unavailability[crewId].has(date);
        
        if (isCurrentlyUnavailable) {
          unavailability[crewId].delete(date);
          cell.classList.remove('unavailable');
          cell.textContent = '';
          await fetch('/api/unavailability', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ crew_id: crewId, unavailable_date: date })
          });
        } else {
          unavailability[crewId].add(date);
          cell.classList.add('unavailable');
          cell.textContent = '✕';
          await fetch('/api/unavailability', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ crew_id: crewId, unavailable_date: date })
          });
        }
      }
      
      async function markAllWeekends() {
        const year = currentMonth.getFullYear();
        const month = currentMonth.getMonth();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        
        const entries = [];
        
        for (let d = 1; d <= daysInMonth; d++) {
          const date = new Date(year, month, d);
          if (date.getDay() === 0 || date.getDay() === 6) {
            const dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
            for (const c of crew) {
              if (!unavailability[c.id]?.has(dateStr)) {
                entries.push({ crew_id: c.id, unavailable_date: dateStr, action: 'add' });
                if (!unavailability[c.id]) unavailability[c.id] = new Set();
                unavailability[c.id].add(dateStr);
              }
            }
          }
        }
        
        if (entries.length > 0) {
          await fetch('/api/unavailability/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries })
          });
        }
        
        renderAvailabilityGrid();
      }
      
      async function clearMonth() {
        const month = formatMonth(currentMonth);
        const entries = [];
        
        for (const crewId in unavailability) {
          for (const date of unavailability[crewId]) {
            if (date.startsWith(month)) {
              entries.push({ crew_id: parseInt(crewId), unavailable_date: date, action: 'remove' });
            }
          }
        }
        
        if (entries.length > 0) {
          await fetch('/api/unavailability/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries })
          });
        }
        
        // Clear local state
        for (const crewId in unavailability) {
          for (const date of [...unavailability[crewId]]) {
            if (date.startsWith(month)) {
              unavailability[crewId].delete(date);
            }
          }
        }
        
        renderAvailabilityGrid();
      }
      
      // ============================================
      // STEP 2: UPLOAD
      // ============================================
      function handleFileUpload(file) {
        const reader = new FileReader();
        reader.onload = async (e) => {
          const text = e.target.result;
          const lines = text.split('\\n').filter(l => l.trim());
          
          // Skip header row
          const events = [];
          for (let i = 1; i < lines.length; i++) {
            const parts = parseCSVLine(lines[i]);
            if (parts.length >= 4) {
              events.push({
                name: parts[0].trim(),
                date: parts[1].trim(),
                venue: parts[2].trim(),
                vertical: parts[3].trim()
              });
            }
          }
          
          // Upload to server
          const res = await fetch('/api/events/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ events })
          });
          
          const data = await res.json();
          batchId = data.batch_id;
          uploadedEvents = data.events;
          
          renderUploadPreview();
        };
        reader.readAsText(file);
      }
      
      function parseCSVLine(line) {
        const result = [];
        let current = '';
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
          const char = line[i];
          if (char === '"') {
            inQuotes = !inQuotes;
          } else if (char === ',' && !inQuotes) {
            result.push(current);
            current = '';
          } else {
            current += char;
          }
        }
        result.push(current);
        return result;
      }
      
      function renderUploadPreview() {
        document.getElementById('upload-preview').classList.remove('hidden');
        document.getElementById('step2-next').classList.remove('hidden');
        
        // Count multi-day events
        const groups = {};
        uploadedEvents.forEach(e => {
          const key = e.event_group || e.id;
          if (!groups[key]) groups[key] = [];
          groups[key].push(e);
        });
        const multiDayCount = Object.values(groups).filter(g => g.length > 1).length;
        
        document.getElementById('event-count').textContent = uploadedEvents.length;
        document.getElementById('multiday-count').textContent = multiDayCount > 0 ? '(' + multiDayCount + ' multi-day events detected)' : '';
        
        let html = '<table class="w-full text-sm"><thead><tr class="text-muted"><th class="text-left py-2">Event</th><th class="text-left py-2">Date</th><th class="text-left py-2">Venue</th><th class="text-left py-2">Vertical</th></tr></thead><tbody>';
        
        // Show unique events (group multi-day)
        const shown = new Set();
        for (const e of uploadedEvents) {
          const key = e.event_group || e.id;
          if (shown.has(key)) continue;
          shown.add(key);
          
          const group = groups[key];
          const dateDisplay = group.length > 1 ? group[0].event_date + ' (' + group.length + ' days)' : e.event_date;
          
          html += '<tr class="border-t border-white/5"><td class="py-2">' + e.name + '</td><td class="py-2">' + dateDisplay + '</td><td class="py-2">' + e.venue + '</td><td class="py-2">' + e.vertical + '</td></tr>';
        }
        
        html += '</tbody></table>';
        document.getElementById('preview-table').innerHTML = html;
      }
      
      // ============================================
      // STEP 3: STAGE CREW
      // ============================================
      function renderStageRequirements() {
        // Group by event_group or id
        const groups = {};
        uploadedEvents.forEach(e => {
          const key = e.event_group || 'single_' + e.id;
          if (!groups[key]) groups[key] = { events: [], firstEvent: e };
          groups[key].events.push(e);
        });
        
        let html = '<table class="w-full text-sm"><thead><tr class="text-muted"><th class="text-left py-2">Event</th><th class="text-left py-2">Venue</th><th class="text-left py-2">Stage Crew #</th></tr></thead><tbody>';
        
        for (const [key, group] of Object.entries(groups)) {
          const e = group.firstEvent;
          const daysLabel = group.events.length > 1 ? ' <span class="text-blue-400">(' + group.events.length + ' days)</span>' : '';
          
          html += '<tr class="border-t border-white/5">';
          html += '<td class="py-3">' + e.name + daysLabel + '</td>';
          html += '<td class="py-3">' + e.venue + '</td>';
          html += '<td class="py-3"><select class="stage-select" data-group="' + key + '" data-event-ids="' + group.events.map(ev => ev.id).join(',') + '">';
          for (let i = 1; i <= 5; i++) {
            const selected = i === e.stage_crew_needed ? 'selected' : '';
            html += '<option value="' + i + '" ' + selected + '>' + i + '</option>';
          }
          html += '</select></td></tr>';
        }
        
        html += '</tbody></table>';
        document.getElementById('stage-requirements').innerHTML = html;
        
        // Add change handlers
        document.querySelectorAll('.stage-select').forEach(select => {
          select.addEventListener('change', async (e) => {
            const eventIds = e.target.dataset.eventIds.split(',');
            const value = parseInt(e.target.value);
            
            for (const id of eventIds) {
              await fetch('/api/events/' + id, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ stage_crew_needed: value })
              });
              
              // Update local state
              const evt = uploadedEvents.find(ev => ev.id == id);
              if (evt) evt.stage_crew_needed = value;
            }
          });
        });
      }
      
      // ============================================
      // STEP 4: REVIEW
      // ============================================
      async function runAssignmentEngine() {
        const res = await fetch('/api/assignments/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batch_id: batchId })
        });
        
        const data = await res.json();
        assignments = data.assignments;
        conflicts = data.conflicts;
        
        renderAssignments();
        goToStep(4);
      }
      
      function renderAssignments() {
        // Conflict summary
        const fohConflicts = conflicts.filter(c => c.type === 'FOH').length;
        const stageConflicts = conflicts.filter(c => c.type === 'Stage').length;
        
        if (fohConflicts > 0 || stageConflicts > 0) {
          document.getElementById('conflict-summary').innerHTML = 
            '<span class="text-amber-400"><i class="fas fa-exclamation-triangle mr-2"></i>' + 
            (fohConflicts > 0 ? fohConflicts + ' FOH conflicts' : '') +
            (fohConflicts > 0 && stageConflicts > 0 ? ', ' : '') +
            (stageConflicts > 0 ? stageConflicts + ' Stage conflicts' : '') +
            ' require attention</span>';
          
          document.getElementById('conflicts-section').classList.remove('hidden');
          
          let conflictHtml = '';
          for (const c of conflicts.filter(cf => cf.type === 'FOH')) {
            const assignment = assignments.find(a => a.event_id === c.event_id);
            conflictHtml += '<div class="glass-card-light p-4">';
            conflictHtml += '<div class="flex justify-between items-start">';
            conflictHtml += '<div><span class="font-medium">' + c.event_name + '</span><br><span class="text-muted text-sm">' + assignment.venue + ' | ' + assignment.vertical + '</span></div>';
            conflictHtml += '<button class="btn-secondary px-3 py-1 rounded-lg text-sm edit-btn" data-event-id="' + c.event_id + '"><i class="fas fa-edit mr-1"></i>Assign FOH</button>';
            conflictHtml += '</div></div>';
          }
          document.getElementById('conflicts-list').innerHTML = conflictHtml;
        } else {
          document.getElementById('conflict-summary').textContent = 'All events assigned successfully';
          document.getElementById('conflicts-section').classList.add('hidden');
        }
        
        // All assignments table
        let html = '<table class="w-full text-sm"><thead><tr class="text-muted"><th class="text-left py-2">Event</th><th class="text-left py-2">Date</th><th class="text-left py-2">Venue</th><th class="text-left py-2">FOH</th><th class="text-left py-2">Stage</th><th class="py-2"></th></tr></thead><tbody>';
        
        for (const a of assignments) {
          const fohDisplay = a.foh_name ? 
            (a.foh_specialist ? '<span class="specialist-badge mr-1">★</span>' : '') + a.foh_name + ' <span class="text-muted text-xs">(' + a.foh_level + ')</span>' : 
            '<span class="conflict-badge">Unassigned</span>';
          
          const stageDisplay = a.stage_names?.length > 0 ? 
            a.stage_names.join(', ') : 
            (a.stage_conflict ? '<span class="conflict-badge">Incomplete</span>' : '-');
          
          html += '<tr class="border-t border-white/5">';
          html += '<td class="py-3">' + a.event_name + '</td>';
          html += '<td class="py-3">' + a.event_date + '</td>';
          html += '<td class="py-3">' + a.venue + '</td>';
          html += '<td class="py-3">' + fohDisplay + '</td>';
          html += '<td class="py-3">' + stageDisplay + '</td>';
          html += '<td class="py-3"><button class="text-blue-400 hover:text-blue-300 edit-btn" data-event-id="' + a.event_id + '"><i class="fas fa-edit"></i></button></td>';
          html += '</tr>';
        }
        
        html += '</tbody></table>';
        document.getElementById('assignments-table').innerHTML = html;
        
        // Add edit handlers
        document.querySelectorAll('.edit-btn').forEach(btn => {
          btn.addEventListener('click', () => openEditModal(parseInt(btn.dataset.eventId)));
        });
      }
      
      // ============================================
      // EDIT MODAL
      // ============================================
      function openEditModal(eventId) {
        const assignment = assignments.find(a => a.event_id === eventId);
        if (!assignment) return;
        
        document.getElementById('modal-title').textContent = assignment.event_name;
        document.getElementById('modal-subtitle').textContent = assignment.venue + ' | ' + assignment.vertical + ' | ' + assignment.event_date;
        document.getElementById('modal-stage-count').textContent = '(select ' + (uploadedEvents.find(e => e.id === eventId)?.stage_crew_needed || 1) + ')';
        
        // FOH dropdown
        let fohHtml = '<option value="">-- Select FOH --</option>';
        const sortedCrew = [...crew].sort((a, b) => {
          const levelOrder = { Senior: 0, Mid: 1, Junior: 2, Hired: 3 };
          return levelOrder[a.level] - levelOrder[b.level];
        });
        
        for (const c of sortedCrew) {
          if (c.level === 'Hired') continue;
          const selected = c.id === assignment.foh ? 'selected' : '';
          const levelBadge = c.level === 'Senior' ? '⭐ ' : c.level === 'Mid' ? '● ' : '○ ';
          fohHtml += '<option value="' + c.id + '" ' + selected + '>' + levelBadge + c.name + ' (' + c.level + ')</option>';
        }
        document.getElementById('modal-foh').innerHTML = fohHtml;
        
        // Stage checkboxes
        let stageHtml = '';
        for (const c of sortedCrew) {
          if (!c.can_stage) continue;
          const checked = assignment.stage?.includes(c.id) ? 'checked' : '';
          const levelColor = c.level === 'Senior' ? 'text-blue-400' : c.level === 'Mid' ? 'text-teal-400' : c.level === 'Junior' ? 'text-amber-400' : 'text-gray-400';
          stageHtml += '<label class="flex items-center gap-2 cursor-pointer p-2 hover:bg-white/5 rounded-lg">';
          stageHtml += '<input type="checkbox" class="stage-checkbox" value="' + c.id + '" ' + checked + '>';
          stageHtml += '<span class="' + levelColor + ' text-xs">' + c.level.charAt(0) + '</span>';
          stageHtml += '<span>' + c.name + '</span>';
          stageHtml += '</label>';
        }
        document.getElementById('modal-stage').innerHTML = stageHtml;
        
        // Store current event id
        document.getElementById('edit-modal').dataset.eventId = eventId;
        
        // Show modal
        document.getElementById('edit-modal').classList.remove('hidden');
        document.getElementById('edit-modal').classList.add('flex');
      }
      
      async function saveModalChanges() {
        const eventId = parseInt(document.getElementById('edit-modal').dataset.eventId);
        const fohId = parseInt(document.getElementById('modal-foh').value) || null;
        const stageIds = [...document.querySelectorAll('.stage-checkbox:checked')].map(cb => parseInt(cb.value));
        
        await fetch('/api/assignments/' + eventId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ foh_id: fohId, stage_ids: stageIds })
        });
        
        // Update local state
        const assignment = assignments.find(a => a.event_id === eventId);
        if (assignment) {
          assignment.foh = fohId;
          assignment.foh_name = crew.find(c => c.id === fohId)?.name || null;
          assignment.foh_level = crew.find(c => c.id === fohId)?.level || null;
          assignment.foh_conflict = !fohId;
          assignment.stage = stageIds;
          assignment.stage_names = stageIds.map(id => crew.find(c => c.id === id)?.name).filter(Boolean);
        }
        
        // Update conflicts
        conflicts = conflicts.filter(c => !(c.event_id === eventId && c.type === 'FOH' && fohId));
        
        closeModal();
        renderAssignments();
      }
      
      function closeModal() {
        document.getElementById('edit-modal').classList.add('hidden');
        document.getElementById('edit-modal').classList.remove('flex');
      }
      
      // ============================================
      // STEP 5: EXPORT
      // ============================================
      function exportCSV() {
        window.location.href = '/api/export/csv?batch_id=' + batchId;
      }
      
      function exportCalendar() {
        window.location.href = '/api/export/calendar?batch_id=' + batchId;
      }
      
      function exportWorkload() {
        const month = formatMonth(currentMonth);
        window.location.href = '/api/export/workload?month=' + month;
      }
      
      // ============================================
      // NAVIGATION
      // ============================================
      function goToStep(step) {
        // Hide all steps
        for (let i = 1; i <= 5; i++) {
          document.getElementById('step' + i).classList.add('hidden');
          document.querySelector('.step-indicator[data-step="' + i + '"]').classList.remove('active');
          if (i < step) {
            document.querySelector('.step-indicator[data-step="' + i + '"]').classList.add('completed');
          } else {
            document.querySelector('.step-indicator[data-step="' + i + '"]').classList.remove('completed');
          }
        }
        
        // Show current step
        document.getElementById('step' + step).classList.remove('hidden');
        document.querySelector('.step-indicator[data-step="' + step + '"]').classList.add('active');
        
        currentStep = step;
        
        // Step-specific setup
        if (step === 3) renderStageRequirements();
      }
      
      function formatMonth(date) {
        return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
      }
      
      // ============================================
      // EVENT LISTENERS
      // ============================================
      function setupEventListeners() {
        // Month navigation
        document.getElementById('prev-month').addEventListener('click', () => {
          currentMonth.setMonth(currentMonth.getMonth() - 1);
          loadCrew().then(() => renderAvailabilityGrid());
        });
        
        document.getElementById('next-month').addEventListener('click', () => {
          currentMonth.setMonth(currentMonth.getMonth() + 1);
          loadCrew().then(() => renderAvailabilityGrid());
        });
        
        document.getElementById('mark-weekends').addEventListener('click', markAllWeekends);
        document.getElementById('clear-month').addEventListener('click', clearMonth);
        
        // Step navigation
        document.getElementById('step1-next').addEventListener('click', () => goToStep(2));
        document.getElementById('step2-back').addEventListener('click', () => goToStep(1));
        document.getElementById('step2-next').addEventListener('click', () => goToStep(3));
        document.getElementById('step3-back').addEventListener('click', () => goToStep(2));
        document.getElementById('step3-run').addEventListener('click', runAssignmentEngine);
        document.getElementById('step4-back').addEventListener('click', () => goToStep(3));
        document.getElementById('step4-next').addEventListener('click', () => goToStep(5));
        document.getElementById('step5-back').addEventListener('click', () => goToStep(4));
        document.getElementById('start-new').addEventListener('click', () => {
          uploadedEvents = [];
          batchId = null;
          assignments = [];
          conflicts = [];
          document.getElementById('upload-preview').classList.add('hidden');
          document.getElementById('step2-next').classList.add('hidden');
          document.getElementById('csv-input').value = '';
          goToStep(1);
        });
        
        // File upload
        const uploadZone = document.getElementById('upload-zone');
        const csvInput = document.getElementById('csv-input');
        
        uploadZone.addEventListener('click', () => csvInput.click());
        uploadZone.addEventListener('dragover', (e) => {
          e.preventDefault();
          uploadZone.classList.add('dragover');
        });
        uploadZone.addEventListener('dragleave', () => {
          uploadZone.classList.remove('dragover');
        });
        uploadZone.addEventListener('drop', (e) => {
          e.preventDefault();
          uploadZone.classList.remove('dragover');
          if (e.dataTransfer.files.length > 0) {
            handleFileUpload(e.dataTransfer.files[0]);
          }
        });
        csvInput.addEventListener('change', (e) => {
          if (e.target.files.length > 0) {
            handleFileUpload(e.target.files[0]);
          }
        });
        
        // Modal
        document.getElementById('modal-close').addEventListener('click', closeModal);
        document.getElementById('modal-cancel').addEventListener('click', closeModal);
        document.getElementById('modal-save').addEventListener('click', saveModalChanges);
        document.getElementById('edit-modal').addEventListener('click', (e) => {
          if (e.target.id === 'edit-modal') closeModal();
        });
        
        // Export
        document.getElementById('export-csv').addEventListener('click', exportCSV);
        document.getElementById('export-calendar').addEventListener('click', exportCalendar);
        document.getElementById('export-workload').addEventListener('click', exportWorkload);
      }
      
      // Initialize
      init();
    </script>
</body>
</html>
  `)
})

export default app
