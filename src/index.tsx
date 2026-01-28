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
  venue: string  // Original from CSV
  venue_normalized: string  // Mapped for rules
  team: string  // Original Team field
  vertical: string  // Derived from Team
  sound_requirements: string
  call_time: string
  stage_crew_needed: number
  event_group: string
  needs_manual_review: boolean
  manual_flag_reason: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

// ============================================
// MAPPINGS
// ============================================

const VENUE_MAP: Record<string, string> = {
  'JBT': 'JBT',
  'Jamshed Bhabha Theatre': 'JBT',
  'TT': 'Tata',
  'Tata Theatre': 'Tata',
  'TATA': 'Tata',
  'Tata': 'Tata',
  'TET': 'Experimental',
  'Tata Experimental Theatre': 'Experimental',
  'Experimental Theatre': 'Experimental',
  'Experimental': 'Experimental',
  'Expl': 'Experimental',
  'Expl ZCB': 'Experimental',
  'GDT': 'Godrej Dance',
  'Godrej Dance Theatre': 'Godrej Dance',
  'LT': 'Little Theatre',
  'Little Theatre': 'Little Theatre',
  'DPAG': 'Others',
  'Dilip Piramal Art Gallery': 'Others',
  'Stuart Liff': 'Others',
  'Stuart-Liff': 'Others',
  'Stuart Liff Lib': 'Others',
  'SVR': 'Others',
  'Sea View Room': 'Others',
  'Sunken': 'Others',
  'Sunken Garden': 'Others',
  'OAP': 'Others',
  'West Room': 'Others',
  'West room 1': 'Others',
  'NCPA Reference Library': 'Others',
}

const TEAM_TO_VERTICAL: Record<string, string> = {
  'Dr.Swapno/Team': 'Dance',
  'Dr.Swapno': 'Dance',
  'Dr. Swapno/Team': 'Dance',
  'Dr.Rao/Team': 'Indian Music',
  'Dr. Rao/Team': 'Indian Music',
  'Dr. Rao / Team': 'Indian Music',
  'Farrahnaz & Team': 'Intl Music',
  'Farrahnaz': 'Intl Music',
  'Nooshin/Team': 'Theatre',
  'Nooshin/ Team': 'Theatre',
  'Nooshir/Team': 'Theatre',
  'Bruce/Rajeshri': 'Theatre',
  'Bruce/Team': 'Theatre',
  'Bruce/Binaifar': 'Theatre',
  'Bruce/Deepa': 'Theatre',
  'Bruce/Ava/Binney': 'Theatre',
  'Dr.Sujata/Team': 'Library',
  'Dr. Sujata/Team': 'Library',
  'Dr.Sujata / Team': 'Library',
  'Sujata Jadhav Library NCPA': 'Library',
  'Dr.Cavas': 'Library',
  'Dr. Cavas': 'Library',
  'Bianca/Team': 'Western Music',
  'Marketing': 'Corporate',
  'DP': 'Others',
  'Lit Live': 'Others',
  'PAG': 'Others',
  'International Music': 'Intl Music',
  'Others': 'Others',
  '': 'Others',
}

const VENUE_DEFAULTS: Record<string, number> = {
  'JBT': 3,
  'Tata': 3,
  'Experimental': 2,
  'Godrej Dance': 1,
  'Little Theatre': 1,
  'Others': 1,
}

function mapVenue(raw: string): { mapped: string, isMultiVenue: boolean } {
  const trimmed = raw.trim()
  
  // Check for multi-venue patterns
  if (trimmed.includes(' & ') || trimmed.includes(',') || 
      (trimmed.includes('TT') && trimmed.includes('TET')) ||
      trimmed.toLowerCase().includes('all lawns') ||
      trimmed.toLowerCase().includes('gardens')) {
    return { mapped: 'Others', isMultiVenue: true }
  }
  
  // Try direct mapping
  if (VENUE_MAP[trimmed]) {
    return { mapped: VENUE_MAP[trimmed], isMultiVenue: false }
  }
  
  // Try partial matches
  for (const [key, value] of Object.entries(VENUE_MAP)) {
    if (trimmed.toLowerCase().includes(key.toLowerCase())) {
      return { mapped: value, isMultiVenue: false }
    }
  }
  
  return { mapped: 'Others', isMultiVenue: false }
}

function mapTeamToVertical(team: string): string {
  const trimmed = team.trim()
  
  if (TEAM_TO_VERTICAL[trimmed]) {
    return TEAM_TO_VERTICAL[trimmed]
  }
  
  // Try partial matches
  for (const [key, value] of Object.entries(TEAM_TO_VERTICAL)) {
    if (trimmed.toLowerCase().includes(key.toLowerCase())) {
      return value
    }
  }
  
  return 'Others'
}

function isManualOnlyVenue(venueRaw: string): { manual: boolean, reason: string } {
  const lower = venueRaw.toLowerCase()
  if (lower.includes('dpag') || lower.includes('piramal') || lower.includes('gallery')) {
    return { manual: true, reason: 'DPAG venue' }
  }
  if (lower.includes('stuart') || lower.includes('liff')) {
    return { manual: true, reason: 'Stuart Liff venue' }
  }
  return { manual: false, reason: '' }
}

// ============================================
// CREW API
// ============================================

app.get('/api/crew', async (c) => {
  const { DB } = c.env
  const crew = await DB.prepare('SELECT * FROM crew ORDER BY CASE level WHEN \'Senior\' THEN 1 WHEN \'Mid\' THEN 2 WHEN \'Junior\' THEN 3 WHEN \'Hired\' THEN 4 END, name').all()
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
  const month = c.req.query('month')
  
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
  const { crew_id, unavailable_date, reason } = await c.req.json()
  
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
  const { entries } = await c.req.json()
  
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
  
  const insertedEvents = []
  
  for (const [name, groupEvents] of Object.entries(eventGroups)) {
    const eventGroup = groupEvents.length > 1 ? `group_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : null
    
    for (const event of groupEvents) {
      // Map venue
      const { mapped: venue, isMultiVenue } = mapVenue(event.venue || '')
      
      // Map team to vertical
      const vertical = mapTeamToVertical(event.team || '')
      
      // Check manual-only conditions
      const manualCheck = isManualOnlyVenue(event.venue || '')
      let manualOnly = manualCheck.manual || isMultiVenue
      let manualReason = manualCheck.reason || (isMultiVenue ? 'Multi-venue event' : '')
      
      // No special-casing for any crew member name in sound requirements
      // Assignment follows standard rules based on venue/vertical capabilities
      
      // Default crew count
      const defaultCrew = manualOnly ? 0 : (VENUE_DEFAULTS[venue] || 1)
      
      const result = await DB.prepare(
        `INSERT INTO events (batch_id, name, event_date, venue, venue_normalized, team, vertical, sound_requirements, call_time, stage_crew_needed, event_group, needs_manual_review, manual_flag_reason) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        batchId, 
        event.name, 
        event.date, 
        event.venue || '',  // Original venue
        venue,  // Normalized venue for rules
        event.team || '',
        vertical,
        event.sound_requirements || '',
        event.call_time || '',
        defaultCrew, 
        eventGroup,
        manualOnly ? 1 : 0,
        manualReason
      ).run()
      
      insertedEvents.push({
        id: result.meta.last_row_id,
        batch_id: batchId,
        name: event.name,
        event_date: event.date,
        venue: event.venue || '',  // Original
        venue_normalized: venue,  // For rules
        team: event.team || '',
        vertical,
        sound_requirements: event.sound_requirements || '',
        call_time: event.call_time || '',
        stage_crew_needed: defaultCrew,
        event_group: eventGroup,
        is_multi_day: groupEvents.length > 1,
        total_days: groupEvents.length,
        needs_manual_review: manualOnly,
        manual_flag_reason: manualReason
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
  const updates = await c.req.json()
  
  if (updates.stage_crew_needed !== undefined) {
    await DB.prepare('UPDATE events SET stage_crew_needed = ? WHERE id = ?').bind(updates.stage_crew_needed, id).run()
  }
  if (updates.needs_manual_review !== undefined) {
    await DB.prepare('UPDATE events SET needs_manual_review = ? WHERE id = ?').bind(updates.needs_manual_review ? 1 : 0, id).run()
  }
  
  return c.json({ success: true })
})

// ============================================
// ASSIGNMENT ENGINE
// ============================================

const LEVEL_ORDER: Record<string, number> = { 'Senior': 0, 'Mid': 1, 'Junior': 2, 'Hired': 3 }

function canDoFOH(crew: CrewMember, venue: string, vertical: string): { can: boolean, isSpecialist: boolean } {
  const venueCapability = crew.venue_capabilities[venue]
  const verticalCapability = crew.vertical_capabilities[vertical]
  
  if (!venueCapability || venueCapability === 'N') {
    return { can: false, isSpecialist: false }
  }
  
  if (!verticalCapability || verticalCapability === 'N') {
    return { can: false, isSpecialist: false }
  }
  
  // Special case: "Exp only" for Int'l Music
  if (verticalCapability === 'Exp only') {
    if (venue === 'Experimental') {
      return { can: true, isSpecialist: false }
    }
    return { can: false, isSpecialist: false }
  }
  
  const isVenueSpecialist = venueCapability === 'Y*'
  const isVerticalSpecialist = verticalCapability === 'Y*'
  
  return { can: true, isSpecialist: isVenueSpecialist || isVerticalSpecialist }
}

app.post('/api/assignments/run', async (c) => {
  const { DB } = c.env
  const { batch_id } = await c.req.json()
  
  // Get all events
  const eventsResult = await DB.prepare(
    'SELECT * FROM events WHERE batch_id = ? ORDER BY event_date, name'
  ).bind(batch_id).all()
  const events = eventsResult.results as any[]
  
  // Get all crew (exclude Hired from FOH)
  const crewResult = await DB.prepare('SELECT * FROM crew').all()
  const crew = crewResult.results.map((c: any) => ({
    ...c,
    venue_capabilities: JSON.parse(c.venue_capabilities),
    vertical_capabilities: JSON.parse(c.vertical_capabilities)
  })) as CrewMember[]
  
  // Get current month for specialist rotation
  const currentMonth = events[0]?.event_date?.substring(0, 7) || new Date().toISOString().substring(0, 7)
  
  // ========== TWO-TIER WORKLOAD SYSTEM ==========
  
  // 1. Get 3-month rolling workload for OVERALL balancing
  const [year, monthNum] = currentMonth.split('-').map(Number)
  const threeMonthsAgo = new Date(year, monthNum - 4, 1)  // 3 months back
  const threeMonthStart = `${threeMonthsAgo.getFullYear()}-${String(threeMonthsAgo.getMonth() + 1).padStart(2, '0')}`
  
  const workload3MonthResult = await DB.prepare(
    `SELECT crew_id, SUM(assignment_count) as total FROM workload_history 
     WHERE month >= ? AND month <= ? GROUP BY crew_id`
  ).bind(threeMonthStart, currentMonth).all()
  
  const workload3Month: Record<number, number> = {}
  for (const w of workload3MonthResult.results as any[]) {
    workload3Month[w.crew_id] = w.total
  }
  
  // 2. Track same-month specialist rotation per vertical (for FOH specialist cycling)
  // Key: vertical name, Value: array of specialist crew IDs in rotation order
  const verticalSpecialistRotation: Record<string, number[]> = {}
  const verticalRotationIndex: Record<string, number> = {}  // Current index in rotation
  
  // Build specialist lists per vertical
  for (const c of crew) {
    if (c.level === 'Hired') continue
    for (const [vertical, cap] of Object.entries(c.vertical_capabilities)) {
      if (cap === 'Y*') {
        if (!verticalSpecialistRotation[vertical]) {
          verticalSpecialistRotation[vertical] = []
          verticalRotationIndex[vertical] = 0
        }
        verticalSpecialistRotation[vertical].push(c.id)
      }
    }
  }
  
  // Sort specialists by level (Senior first, then Mid) for initial order
  for (const vertical of Object.keys(verticalSpecialistRotation)) {
    verticalSpecialistRotation[vertical].sort((a, b) => {
      const crewA = crew.find(c => c.id === a)!
      const crewB = crew.find(c => c.id === b)!
      return LEVEL_ORDER[crewA.level] - LEVEL_ORDER[crewB.level]
    })
  }
  
  // Track current month workload (for updating at end)
  const currentMonthWorkload: Record<number, number> = {}
  
  // Get unavailability
  const unavailResult = await DB.prepare('SELECT crew_id, unavailable_date FROM crew_unavailability').all()
  const unavailMap: Record<string, Set<number>> = {}
  for (const u of unavailResult.results as any[]) {
    if (!unavailMap[u.unavailable_date]) {
      unavailMap[u.unavailable_date] = new Set()
    }
    unavailMap[u.unavailable_date].add(u.crew_id)
  }
  
  // Track daily assignments
  const dailyAssignments: Record<string, Set<number>> = {}
  const multiDayAssignments: Record<string, { foh: number | null, stage: number[] }> = {}
  
  // Clear existing assignments
  const eventIds = events.map(e => e.id)
  if (eventIds.length > 0) {
    await DB.prepare(`DELETE FROM assignments WHERE event_id IN (${eventIds.join(',')})`).run()
  }
  
  const assignments: any[] = []
  const conflicts: any[] = []
  
  // Sort: multi-day first, then by date
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
      venue_normalized: event.venue_normalized,
      team: event.team,
      vertical: event.vertical,
      sound_requirements: event.sound_requirements,
      call_time: event.call_time,
      foh: null,
      foh_name: null,
      stage: [],
      stage_names: [],
      foh_conflict: false,
      stage_conflict: false,
      needs_manual_review: event.needs_manual_review,
      manual_flag_reason: event.manual_flag_reason
    }
    
    // Skip auto-assignment for manual-only events
    if (event.needs_manual_review) {
      eventAssignment.foh_conflict = true
      eventAssignment.needs_manual_review = true
      conflicts.push({
        event_id: event.id,
        event_name: event.name,
        type: 'Manual',
        reason: event.manual_flag_reason || 'Manual assignment required'
      })
      assignments.push(eventAssignment)
      continue
    }
    
    // Get all dates for multi-day events
    let eventDates: string[] = [event.event_date]
    if (event.event_group) {
      const groupEvents = events.filter(e => e.event_group === event.event_group)
      eventDates = groupEvents.map(e => e.event_date)
      
      // Reuse existing assignments for multi-day
      if (multiDayAssignments[event.event_group]) {
        const existing = multiDayAssignments[event.event_group]
        eventAssignment.foh = existing.foh
        eventAssignment.foh_name = crew.find(c => c.id === existing.foh)?.name
        eventAssignment.stage = [...existing.stage]
        eventAssignment.stage_names = existing.stage.map(id => crew.find(c => c.id === id)?.name).filter(Boolean)
        
        if (existing.foh) {
          await DB.prepare('INSERT INTO assignments (event_id, crew_id, role) VALUES (?, ?, ?)').bind(event.id, existing.foh, 'FOH').run()
        }
        for (const stageId of existing.stage) {
          await DB.prepare('INSERT INTO assignments (event_id, crew_id, role) VALUES (?, ?, ?)').bind(event.id, stageId, 'Stage').run()
        }
        
        assignments.push(eventAssignment)
        continue
      }
    }
    
    // Initialize daily tracking
    for (const date of eventDates) {
      if (!dailyAssignments[date]) dailyAssignments[date] = new Set()
    }
    
    const isAvailable = (crewId: number): boolean => {
      for (const date of eventDates) {
        if (unavailMap[date]?.has(crewId)) return false
        if (dailyAssignments[date]?.has(crewId)) return false
      }
      return true
    }
    
    // ========== FOH ASSIGNMENT (Two-tier workload) ==========
    let selectedFOH: CrewMember | null = null
    let isSpecialistAssignment = false
    
    // Get specialists for this vertical
    const specialistIds = verticalSpecialistRotation[event.vertical] || []
    const availableSpecialists = specialistIds.filter(id => {
      const c = crew.find(cr => cr.id === id)!
      if (!isAvailable(id)) return false
      const venueCapability = c.venue_capabilities[event.venue_normalized]
      return venueCapability && venueCapability !== 'N'
    })
    
    // Try specialist rotation first (same-month cycling)
    if (availableSpecialists.length > 0) {
      // Get current rotation index for this vertical
      const rotationIdx = verticalRotationIndex[event.vertical] || 0
      
      // Find next available specialist in rotation
      for (let i = 0; i < availableSpecialists.length; i++) {
        const idx = (rotationIdx + i) % availableSpecialists.length
        const candidateId = availableSpecialists[idx]
        const candidate = crew.find(c => c.id === candidateId)!
        
        selectedFOH = candidate
        isSpecialistAssignment = true
        
        // Advance rotation index for next specialist event of same vertical
        verticalRotationIndex[event.vertical] = (idx + 1) % availableSpecialists.length
        break
      }
    }
    
    // If no specialist available, fall back to capable crew (use 3-month workload)
    if (!selectedFOH) {
      const capableCandidates: { crew: CrewMember, score: number }[] = []
      
      for (const c of crew) {
        if (c.level === 'Hired') continue
        if (!isAvailable(c.id)) continue
        
        const capability = canDoFOH(c, event.venue_normalized, event.vertical)
        if (!capability.can) continue
        
        // Score based on seniority and 3-month workload
        const workload = workload3Month[c.id] || 0
        let score = (3 - LEVEL_ORDER[c.level]) * 100  // Senior=300, Mid=200, Junior=100
        score -= workload * 5  // Penalize based on 3-month history
        
        capableCandidates.push({ crew: c, score })
      }
      
      capableCandidates.sort((a, b) => b.score - a.score)
      
      if (capableCandidates.length > 0) {
        selectedFOH = capableCandidates[0].crew
      }
    }
    
    if (selectedFOH) {
      eventAssignment.foh = selectedFOH.id
      eventAssignment.foh_name = selectedFOH.name
      eventAssignment.foh_level = selectedFOH.level
      eventAssignment.foh_specialist = isSpecialistAssignment
      
      for (const date of eventDates) {
        dailyAssignments[date].add(selectedFOH.id)
      }
      currentMonthWorkload[selectedFOH.id] = (currentMonthWorkload[selectedFOH.id] || 0) + eventDates.length
      workload3Month[selectedFOH.id] = (workload3Month[selectedFOH.id] || 0) + eventDates.length
      
      await DB.prepare('INSERT INTO assignments (event_id, crew_id, role) VALUES (?, ?, ?)').bind(event.id, selectedFOH.id, 'FOH').run()
    } else {
      eventAssignment.foh_conflict = true
      conflicts.push({
        event_id: event.id,
        event_name: event.name,
        type: 'FOH',
        reason: 'No qualified FOH available'
      })
    }
    
    // ========== STAGE ASSIGNMENT (3-month workload balancing) ==========
    // Key principle: Workload is PRIMARY driver - everyone shares Stage work fairly
    // Seniors do Stage when their total workload is lower than others
    const stageNeeded = event.stage_crew_needed - 1  // -1 because total includes FOH
    if (stageNeeded > 0) {
      const stageCandidates: { crew: CrewMember, score: number }[] = []
      
      for (const c of crew) {
        if (!c.can_stage) continue
        if (c.id === eventAssignment.foh) continue
        if (!isAvailable(c.id)) continue
        
        // Score: WORKLOAD is the primary factor for fair distribution
        // Lower workload = higher score = more likely to be assigned
        const workload = workload3Month[c.id] || 0
        
        // Start with base score, subtract workload heavily
        // This ensures lowest-workload crew gets picked regardless of level
        let score = 500 - (workload * 20)  // Workload dominates
        
        // Small bonus for non-seniors to slightly prefer them when workload is equal
        // But this is overridden if a senior has significantly lower workload
        if (!c.stage_only_if_urgent) score += 10  // Slight preference for non-seniors
        
        // Outside crew only when internal exhausted (big penalty)
        if (c.level === 'Hired') score -= 300
        
        stageCandidates.push({ crew: c, score })
      }
      
      stageCandidates.sort((a, b) => b.score - a.score)
      
      const selectedStage: number[] = []
      const stageNames: string[] = []
      
      for (let i = 0; i < Math.min(stageNeeded, stageCandidates.length); i++) {
        const stageCrew = stageCandidates[i].crew
        selectedStage.push(stageCrew.id)
        stageNames.push(stageCrew.name)
        
        for (const date of eventDates) {
          dailyAssignments[date].add(stageCrew.id)
        }
        currentMonthWorkload[stageCrew.id] = (currentMonthWorkload[stageCrew.id] || 0) + eventDates.length
        workload3Month[stageCrew.id] = (workload3Month[stageCrew.id] || 0) + eventDates.length
        
        await DB.prepare('INSERT INTO assignments (event_id, crew_id, role) VALUES (?, ?, ?)').bind(event.id, stageCrew.id, 'Stage').run()
      }
      
      eventAssignment.stage = selectedStage
      eventAssignment.stage_names = stageNames
      
      if (selectedStage.length < stageNeeded) {
        eventAssignment.stage_conflict = true
        conflicts.push({
          event_id: event.id,
          event_name: event.name,
          type: 'Stage',
          reason: `Only ${selectedStage.length + 1}/${event.stage_crew_needed} crew available`
        })
      }
    }
    
    // Track multi-day
    if (event.event_group) {
      multiDayAssignments[event.event_group] = {
        foh: eventAssignment.foh,
        stage: eventAssignment.stage
      }
    }
    
    assignments.push(eventAssignment)
  }
  
  // Update current month workload history
  for (const [crewId, count] of Object.entries(currentMonthWorkload)) {
    await DB.prepare(
      `INSERT INTO workload_history (crew_id, month, assignment_count) VALUES (?, ?, ?)
       ON CONFLICT(crew_id, month) DO UPDATE SET assignment_count = assignment_count + ?`
    ).bind(parseInt(crewId), currentMonth, count, count).run()
  }
  
  return c.json({ assignments, conflicts })
})

app.get('/api/assignments', async (c) => {
  const { DB } = c.env
  const batchId = c.req.query('batch_id')
  
  const results = await DB.prepare(`
    SELECT a.*, e.name as event_name, e.event_date, e.venue, e.venue_normalized, e.vertical, e.team,
           e.sound_requirements, e.call_time, e.stage_crew_needed, e.event_group, e.needs_manual_review, e.manual_flag_reason,
           c.name as crew_name, c.level as crew_level
    FROM assignments a
    JOIN events e ON a.event_id = e.id
    JOIN crew c ON a.crew_id = c.id
    WHERE e.batch_id = ?
    ORDER BY e.event_date, e.name, a.role DESC
  `).bind(batchId).all()
  
  return c.json(results.results)
})

app.put('/api/assignments/:eventId', async (c) => {
  const { DB } = c.env
  const eventId = c.req.param('eventId')
  const { foh_id, stage_ids } = await c.req.json()
  
  await DB.prepare('DELETE FROM assignments WHERE event_id = ?').bind(eventId).run()
  
  if (foh_id) {
    await DB.prepare('INSERT INTO assignments (event_id, crew_id, role, was_manually_overridden) VALUES (?, ?, ?, 1)').bind(eventId, foh_id, 'FOH').run()
  }
  
  for (const stageId of stage_ids || []) {
    await DB.prepare('INSERT INTO assignments (event_id, crew_id, role, was_manually_overridden) VALUES (?, ?, ?, 1)').bind(eventId, stageId, 'Stage').run()
  }
  
  return c.json({ success: true })
})

// ============================================
// EXPORT API - Preserves original format
// ============================================

app.get('/api/export/csv', async (c) => {
  const { DB } = c.env
  const batchId = c.req.query('batch_id')
  
  const events = await DB.prepare(
    'SELECT * FROM events WHERE batch_id = ? ORDER BY event_date, name'
  ).bind(batchId).all()
  
  const assignments = await DB.prepare(`
    SELECT a.event_id, a.role, c.name as crew_name, c.level
    FROM assignments a
    JOIN events e ON a.event_id = e.id
    JOIN crew c ON a.crew_id = c.id
    WHERE e.batch_id = ?
    ORDER BY a.role DESC
  `).bind(batchId).all()
  
  // Group assignments
  const assignmentMap: Record<number, { foh: string, stage: string[] }> = {}
  const hiredCount: Record<number, number> = {}
  
  for (const a of assignments.results as any[]) {
    if (!assignmentMap[a.event_id]) {
      assignmentMap[a.event_id] = { foh: '', stage: [] }
      hiredCount[a.event_id] = 0
    }
    
    let name = a.crew_name
    if (a.level === 'Hired') {
      hiredCount[a.event_id]++
      name = `OC${hiredCount[a.event_id]}`
    }
    
    if (a.role === 'FOH') {
      assignmentMap[a.event_id].foh = name
    } else {
      assignmentMap[a.event_id].stage.push(name)
    }
  }
  
  // Build CSV with original format
  let csv = 'Date,Program,Venue,Team,Sound Requirements,Call Time,Crew\n'
  
  for (const e of events.results as any[]) {
    const assignment = assignmentMap[e.id] || { foh: '', stage: [] }
    const crewList = [assignment.foh, ...assignment.stage].filter(Boolean).join(', ')
    
    // Escape fields properly
    const escapeField = (val: string) => {
      if (!val) return '""'
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return '"' + val.replace(/"/g, '""') + '"'
      }
      return '"' + val + '"'
    }
    
    // Convert yyyy-mm-dd to dd-mm-yyyy for output
    let dateOut = e.event_date
    if (dateOut && /^\d{4}-\d{2}-\d{2}$/.test(dateOut)) {
      const [yyyy, mm, dd] = dateOut.split('-')
      dateOut = dd + '-' + mm + '-' + yyyy
    }
    csv += `${dateOut},${escapeField(e.name)},${escapeField(e.venue)},${escapeField(e.team)},${escapeField(e.sound_requirements)},${escapeField(e.call_time)},${escapeField(crewList)}\n`
  }
  
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="crew_assignments_${batchId}.csv"`
    }
  })
})

app.get('/api/export/calendar', async (c) => {
  const { DB } = c.env
  const batchId = c.req.query('batch_id')
  
  const events = await DB.prepare('SELECT * FROM events WHERE batch_id = ? ORDER BY event_date, name').bind(batchId).all()
  const assignments = await DB.prepare(`
    SELECT a.event_id, a.role, c.name, c.level FROM assignments a
    JOIN events e ON a.event_id = e.id JOIN crew c ON a.crew_id = c.id
    WHERE e.batch_id = ?
  `).bind(batchId).all()
  
  const assignmentMap: Record<number, { foh: string, stage: string[] }> = {}
  const hiredCount: Record<number, number> = {}
  
  for (const a of assignments.results as any[]) {
    if (!assignmentMap[a.event_id]) {
      assignmentMap[a.event_id] = { foh: '', stage: [] }
      hiredCount[a.event_id] = 0
    }
    let name = a.name
    if (a.level === 'Hired') {
      hiredCount[a.event_id]++
      name = `OC${hiredCount[a.event_id]}`
    }
    if (a.role === 'FOH') assignmentMap[a.event_id].foh = name
    else assignmentMap[a.event_id].stage.push(name)
  }
  
  const eventGroups: Record<string, any[]> = {}
  for (const e of events.results as any[]) {
    const key = e.event_group || `single_${e.id}`
    if (!eventGroups[key]) eventGroups[key] = []
    eventGroups[key].push(e)
  }
  
  // Helper to convert yyyy-mm-dd to dd-mm-yyyy
  const formatDate = (d: string) => {
    if (d && d.match(/^\d{4}-\d{2}-\d{2}$/)) {
      const [yyyy, mm, dd] = d.split('-')
      return `${dd}-${mm}-${yyyy}`
    }
    return d
  }
  
  let csv = 'Subject,Start Date,End Date,Description\n'
  for (const [, groupEvents] of Object.entries(eventGroups)) {
    groupEvents.sort((a, b) => a.event_date.localeCompare(b.event_date))
    const first = groupEvents[0]
    const last = groupEvents[groupEvents.length - 1]
    const a = assignmentMap[first.id] || { foh: '', stage: [] }
    const desc = `Venue: ${first.venue} | Team: ${first.team} | FOH: ${a.foh} | Stage: ${a.stage.join(', ')}`
    csv += `"${first.name}","${formatDate(first.event_date)}","${formatDate(last.event_date)}","${desc.replace(/"/g, '""')}"\n`
  }
  
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="calendar_${batchId}.csv"`
    }
  })
})

app.get('/api/export/workload', async (c) => {
  const { DB } = c.env
  const month = c.req.query('month')
  
  const workload = await DB.prepare(`
    SELECT c.name, c.level, COALESCE(w.assignment_count, 0) as assignments
    FROM crew c LEFT JOIN workload_history w ON c.id = w.crew_id AND w.month = ?
    ORDER BY CASE c.level WHEN 'Senior' THEN 1 WHEN 'Mid' THEN 2 WHEN 'Junior' THEN 3 WHEN 'Hired' THEN 4 END, c.name
  `).bind(month).all()
  
  let csv = 'Crew Name,Level,Assignments\n'
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
      body { background: linear-gradient(135deg, #0f1419 0%, #1a2332 50%, #0f1419 100%); min-height: 100vh; }
      .glass-card { background: rgba(255,255,255,0.03); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.08); border-radius: 20px; }
      .glass-card-light { background: rgba(255,255,255,0.05); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; }
      .text-cream { color: #f5f0e8; }
      .text-muted { color: #9ca3af; }
      .btn-primary { background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); transition: all 0.3s ease; }
      .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 4px 20px rgba(59,130,246,0.4); }
      .btn-secondary { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); transition: all 0.3s ease; }
      .btn-secondary:hover { background: rgba(255,255,255,0.12); }
      .step-indicator { transition: all 0.3s ease; }
      .step-indicator.active { background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); transform: scale(1.1); }
      .step-indicator.completed { background: #5eead4; }
      .day-cell { width: 36px; height: 36px; border-radius: 10px; transition: all 0.2s ease; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 12px; }
      .day-cell:hover { background: rgba(96,165,250,0.2); }
      .day-cell.unavailable { background: rgba(248,113,113,0.3); color: #f87171; }
      .day-cell.weekend { background: rgba(251,191,36,0.1); }
      .upload-zone { border: 2px dashed rgba(96,165,250,0.3); border-radius: 16px; transition: all 0.3s ease; }
      .upload-zone:hover, .upload-zone.dragover { border-color: rgba(96,165,250,0.6); background: rgba(96,165,250,0.05); }
      .fade-in { animation: fadeIn 0.3s ease-out; }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      .slide-up { animation: slideUp 0.4s ease-out; }
      @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
      input, select { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; color: #f5f0e8; padding: 8px 12px; }
      input:focus, select:focus { outline: none; border-color: rgba(96,165,250,0.5); }
      .conflict-badge { background: rgba(248,113,113,0.2); color: #f87171; padding: 2px 8px; border-radius: 6px; font-size: 11px; }
      .manual-badge { background: rgba(251,191,36,0.2); color: #fbbf24; padding: 2px 8px; border-radius: 6px; font-size: 11px; }
      .specialist-badge { background: rgba(94,234,212,0.2); color: #5eead4; padding: 2px 8px; border-radius: 6px; font-size: 11px; }
      .modal-overlay { background: rgba(0,0,0,0.7); backdrop-filter: blur(4px); }
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: rgba(255,255,255,0.05); border-radius: 4px; }
      ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }
    </style>
</head>
<body class="text-cream">
    <div id="app" class="min-h-screen p-6">
      <header class="max-w-6xl mx-auto mb-8 fade-in">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="text-2xl font-semibold tracking-tight">
              <i class="fas fa-sliders-h text-blue-400 mr-3"></i>NCPA Crew Assignment Helper
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
      
      <main class="max-w-6xl mx-auto">
        <!-- Step 1: Availability -->
        <section id="step1" class="glass-card p-8 mb-6 slide-up">
          <div class="flex items-center justify-between mb-6">
            <div>
              <h2 class="text-xl font-semibold flex items-center gap-3"><i class="fas fa-calendar-alt text-blue-400"></i>Crew Availability</h2>
              <p class="text-muted text-sm mt-1">Mark day-offs for all crew members</p>
            </div>
            <div class="flex items-center gap-3">
              <button id="prev-month" class="btn-secondary px-4 py-2 rounded-xl text-sm"><i class="fas fa-chevron-left"></i></button>
              <span id="current-month" class="text-lg font-medium px-4">February 2026</span>
              <button id="next-month" class="btn-secondary px-4 py-2 rounded-xl text-sm"><i class="fas fa-chevron-right"></i></button>
            </div>
          </div>
          <div class="flex gap-3 mb-4">
            <button id="mark-weekends" class="btn-secondary px-4 py-2 rounded-xl text-sm"><i class="fas fa-calendar-week mr-2"></i>Mark All Weekends</button>
            <button id="clear-month" class="btn-secondary px-4 py-2 rounded-xl text-sm"><i class="fas fa-eraser mr-2"></i>Clear Month</button>
          </div>
          <div id="availability-grid" class="glass-card-light p-4 overflow-x-auto"></div>
          <div class="flex justify-between items-center mt-6">
            <div class="flex items-center gap-4 text-sm text-muted">
              <span><span class="inline-block w-4 h-4 rounded bg-red-400/30 mr-2"></span>Day Off</span>
              <span><span class="inline-block w-4 h-4 rounded bg-amber-400/10 mr-2"></span>Weekend</span>
            </div>
            <button id="step1-next" class="btn-primary px-6 py-3 rounded-xl font-medium">Continue <i class="fas fa-arrow-right ml-2"></i></button>
          </div>
        </section>
        
        <!-- Step 2: Upload -->
        <section id="step2" class="glass-card p-8 mb-6 hidden">
          <h2 class="text-xl font-semibold flex items-center gap-3 mb-6"><i class="fas fa-upload text-blue-400"></i>Upload Events</h2>
          <div id="upload-zone" class="upload-zone p-12 text-center cursor-pointer">
            <i class="fas fa-cloud-upload-alt text-4xl text-blue-400 mb-4"></i>
            <p class="text-lg mb-2">Drop CSV file here or click to browse</p>
            <p class="text-muted text-sm">Format: Date (dd-mm-yyyy), Program, Venue, Team, Sound Requirements, Call Time, Crew</p>
            <input type="file" id="csv-input" accept=".csv" class="hidden">
          </div>
          <div id="upload-preview" class="hidden mt-6">
            <div class="glass-card-light p-4">
              <div class="flex items-center justify-between mb-4">
                <span class="font-medium"><i class="fas fa-check-circle text-teal-400 mr-2"></i><span id="event-count">0</span> events loaded</span>
                <div class="flex gap-4 text-sm">
                  <span id="multiday-count" class="text-blue-400"></span>
                  <span id="manual-count" class="text-amber-400"></span>
                </div>
              </div>
              <div id="preview-table" class="max-h-64 overflow-y-auto"></div>
            </div>
          </div>
          <div class="flex justify-between mt-6">
            <button id="step2-back" class="btn-secondary px-6 py-3 rounded-xl font-medium"><i class="fas fa-arrow-left mr-2"></i> Back</button>
            <button id="step2-next" class="btn-primary px-6 py-3 rounded-xl font-medium hidden">Continue <i class="fas fa-arrow-right ml-2"></i></button>
          </div>
        </section>
        
        <!-- Step 3: Crew Count -->
        <section id="step3" class="glass-card p-8 mb-6 hidden">
          <h2 class="text-xl font-semibold flex items-center gap-3 mb-6"><i class="fas fa-users text-blue-400"></i>Crew Requirements</h2>
          <p class="text-muted text-sm mb-4">Total crew count (FOH + Stage). <span class="manual-badge">Manual</span> events require your direct assignment.</p>
          <div id="stage-requirements" class="glass-card-light p-4 max-h-96 overflow-y-auto"></div>
          <div class="flex justify-between mt-6">
            <button id="step3-back" class="btn-secondary px-6 py-3 rounded-xl font-medium"><i class="fas fa-arrow-left mr-2"></i> Back</button>
            <button id="step3-run" class="btn-primary px-6 py-3 rounded-xl font-medium"><i class="fas fa-magic mr-2"></i>Run Assignment Engine</button>
          </div>
        </section>
        
        <!-- Step 4: Review -->
        <section id="step4" class="glass-card p-8 mb-6 hidden">
          <h2 class="text-xl font-semibold flex items-center gap-3 mb-2"><i class="fas fa-clipboard-check text-blue-400"></i>Review Assignments</h2>
          <p class="text-muted text-sm mb-6" id="conflict-summary"></p>
          <div id="conflicts-section" class="hidden mb-6">
            <h3 class="font-medium text-amber-400 mb-3"><i class="fas fa-exclamation-triangle mr-2"></i>Requires Attention</h3>
            <div id="conflicts-list" class="space-y-3"></div>
          </div>
          <div id="assignments-table" class="glass-card-light p-4 max-h-96 overflow-y-auto"></div>
          <div class="flex justify-between mt-6">
            <button id="step4-back" class="btn-secondary px-6 py-3 rounded-xl font-medium"><i class="fas fa-arrow-left mr-2"></i> Back</button>
            <button id="step4-next" class="btn-primary px-6 py-3 rounded-xl font-medium">Finalize <i class="fas fa-arrow-right ml-2"></i></button>
          </div>
        </section>
        
        <!-- Step 5: Export -->
        <section id="step5" class="glass-card p-8 mb-6 hidden">
          <h2 class="text-xl font-semibold flex items-center gap-3 mb-6"><i class="fas fa-download text-blue-400"></i>Export Assignments</h2>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div class="glass-card-light p-6 text-center hover:border-blue-400/50 transition-all cursor-pointer" id="export-csv">
              <i class="fas fa-file-csv text-4xl text-blue-400 mb-4"></i>
              <h3 class="font-medium mb-2">NCPA Format CSV</h3>
              <p class="text-muted text-sm">Import back to ncpa-sound.pages.dev</p>
            </div>
            <div class="glass-card-light p-6 text-center hover:border-teal-400/50 transition-all cursor-pointer" id="export-calendar">
              <i class="fas fa-calendar-plus text-4xl text-teal-400 mb-4"></i>
              <h3 class="font-medium mb-2">Calendar Import</h3>
              <p class="text-muted text-sm">Google Calendar format</p>
            </div>
            <div class="glass-card-light p-6 text-center hover:border-amber-400/50 transition-all cursor-pointer" id="export-workload">
              <i class="fas fa-chart-bar text-4xl text-amber-400 mb-4"></i>
              <h3 class="font-medium mb-2">Workload Report</h3>
              <p class="text-muted text-sm">Crew assignment summary</p>
            </div>
          </div>
          <div class="flex justify-between mt-6">
            <button id="step5-back" class="btn-secondary px-6 py-3 rounded-xl font-medium"><i class="fas fa-arrow-left mr-2"></i> Back to Edit</button>
            <button id="start-new" class="btn-primary px-6 py-3 rounded-xl font-medium"><i class="fas fa-plus mr-2"></i>Start New Batch</button>
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
            <button id="modal-close" class="text-gray-400 hover:text-white"><i class="fas fa-times text-xl"></i></button>
          </div>
          <div class="space-y-4">
            <div id="modal-venue-section" class="hidden">
              <label class="block text-sm font-medium mb-2">Venue <span class="manual-badge ml-2">Multi-venue</span></label>
              <select id="modal-venue" class="w-full py-3">
                <option value="JBT">JBT (Jamshed Bhabha Theatre)</option>
                <option value="Tata">TT (Tata Theatre)</option>
                <option value="Experimental">TET (Experimental Theatre)</option>
                <option value="Godrej Dance">GDT (Godrej Dance Theatre)</option>
                <option value="Little Theatre">LT (Little Theatre)</option>
                <option value="Others">Others</option>
              </select>
              <p class="text-muted text-xs mt-1">Select primary venue for crew assignment rules</p>
            </div>
            <div>
              <label class="block text-sm font-medium mb-2">FOH Engineer</label>
              <select id="modal-foh" class="w-full py-3"></select>
            </div>
            <div>
              <label class="block text-sm font-medium mb-2">Stage Crew <span id="modal-stage-count" class="text-muted"></span></label>
              <div id="modal-stage" class="glass-card-light p-3 max-h-48 overflow-y-auto space-y-2"></div>
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
      let currentStep = 1;
      let currentMonth = new Date();
      currentMonth.setMonth(currentMonth.getMonth() + 1);
      let crew = [];
      let unavailability = {};
      let uploadedEvents = [];
      let rawEventData = [];
      let batchId = null;
      let assignments = [];
      let conflicts = [];
      
      // Helper: Convert yyyy-mm-dd to dd-mm-yyyy for display
      function formatDateDisplay(dateStr) {
        if (!dateStr) return '';
        if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
          const [yyyy, mm, dd] = dateStr.split('-');
          return dd + '-' + mm + '-' + yyyy;
        }
        return dateStr;
      }
      
      async function init() {
        await loadCrew();
        renderAvailabilityGrid();
        setupEventListeners();
      }
      
      async function loadCrew() {
        const res = await fetch('/api/crew');
        crew = await res.json();
        const month = formatMonth(currentMonth);
        const unavailRes = await fetch('/api/unavailability?month=' + month);
        const unavailData = await unavailRes.json();
        unavailability = {};
        for (const u of unavailData) {
          if (!unavailability[u.crew_id]) unavailability[u.crew_id] = new Set();
          unavailability[u.crew_id].add(u.unavailable_date);
        }
      }
      
      function renderAvailabilityGrid() {
        const grid = document.getElementById('availability-grid');
        const year = currentMonth.getFullYear();
        const month = currentMonth.getMonth();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        document.getElementById('current-month').textContent = currentMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        
        let html = '<table class="w-full text-sm"><thead><tr><th class="text-left py-2 px-3 text-muted font-medium sticky left-0 bg-gray-900/80">Crew</th>';
        for (let d = 1; d <= daysInMonth; d++) {
          const date = new Date(year, month, d);
          const isWeekend = date.getDay() === 0 || date.getDay() === 6;
          const dayName = date.toLocaleDateString('en-US', { weekday: 'short' }).charAt(0);
          html += '<th class="text-center py-2 ' + (isWeekend ? 'text-amber-400' : 'text-muted') + ' font-medium">' + dayName + '<br>' + d + '</th>';
        }
        html += '</tr></thead><tbody>';
        
        for (const c of crew) {
          if (c.level === 'Hired') continue;
          const levelColor = c.level === 'Senior' ? 'text-blue-400' : c.level === 'Mid' ? 'text-teal-400' : 'text-amber-400';
          html += '<tr><td class="py-2 px-3 whitespace-nowrap sticky left-0 bg-gray-900/80"><span class="' + levelColor + ' text-xs mr-2">' + c.level.charAt(0) + '</span>' + c.name + '</td>';
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
        grid.querySelectorAll('.day-cell').forEach(cell => cell.addEventListener('click', () => toggleUnavailability(cell)));
      }
      
      async function toggleUnavailability(cell) {
        const crewId = parseInt(cell.dataset.crew);
        const date = cell.dataset.date;
        if (!unavailability[crewId]) unavailability[crewId] = new Set();
        const isUnavail = unavailability[crewId].has(date);
        if (isUnavail) {
          unavailability[crewId].delete(date);
          cell.classList.remove('unavailable');
          cell.textContent = '';
          await fetch('/api/unavailability', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ crew_id: crewId, unavailable_date: date }) });
        } else {
          unavailability[crewId].add(date);
          cell.classList.add('unavailable');
          cell.textContent = '✕';
          await fetch('/api/unavailability', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ crew_id: crewId, unavailable_date: date }) });
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
              if (c.level === 'Hired') continue;
              if (!unavailability[c.id]?.has(dateStr)) {
                entries.push({ crew_id: c.id, unavailable_date: dateStr, action: 'add' });
                if (!unavailability[c.id]) unavailability[c.id] = new Set();
                unavailability[c.id].add(dateStr);
              }
            }
          }
        }
        if (entries.length > 0) await fetch('/api/unavailability/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries }) });
        renderAvailabilityGrid();
      }
      
      async function clearMonth() {
        const month = formatMonth(currentMonth);
        const entries = [];
        for (const crewId in unavailability) {
          for (const date of [...unavailability[crewId]]) {
            if (date.startsWith(month)) {
              entries.push({ crew_id: parseInt(crewId), unavailable_date: date, action: 'remove' });
              unavailability[crewId].delete(date);
            }
          }
        }
        if (entries.length > 0) await fetch('/api/unavailability/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries }) });
        renderAvailabilityGrid();
      }
      
      function handleFileUpload(file) {
        // Show upload progress
        const uploadZone = document.getElementById('upload-zone');
        uploadZone.innerHTML = '<div class="text-center"><div class="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-400 mx-auto mb-4"></div><p class="text-lg">Reading CSV file...</p><p class="text-muted text-sm" id="upload-progress">0%</p></div>';
        
        const reader = new FileReader();
        reader.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 50);
            document.getElementById('upload-progress').textContent = pct + '% - Reading file';
          }
        };
        reader.onload = async (e) => {
          document.getElementById('upload-progress').textContent = '50% - Parsing events';
          const text = e.target.result;
          const lines = text.split(new RegExp('\\r?\\n')).filter(l => l.trim());
          const events = [];
          rawEventData = [];
          
          const totalLines = lines.length - 1;
          for (let i = 1; i < lines.length; i++) {
            const parts = parseCSVLine(lines[i]);
            if (parts.length >= 4) {
              let dateStr = parts[0]?.trim() || '';
              // Convert dd-mm-yyyy to yyyy-mm-dd for storage
              if (dateStr.match(/^\d{2}-\d{2}-\d{4}$/)) {
                const [dd, mm, yyyy] = dateStr.split('-');
                dateStr = yyyy + '-' + mm + '-' + dd;
              }
              const evt = {
                date: dateStr,
                name: parts[1]?.trim() || '',
                venue: parts[2]?.trim() || '',
                team: parts[3]?.trim() || '',
                sound_requirements: parts[4]?.trim() || '',
                call_time: parts[5]?.trim() || ''
              };
              if (evt.date && evt.name) {
                events.push(evt);
                rawEventData.push(evt);
              }
            }
            if (i % 10 === 0) {
              const pct = 50 + Math.round((i / totalLines) * 25);
              document.getElementById('upload-progress').textContent = pct + '% - Parsed ' + i + '/' + totalLines + ' events';
            }
          }
          
          document.getElementById('upload-progress').textContent = '75% - Uploading to server';
          const res = await fetch('/api/events/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events }) });
          document.getElementById('upload-progress').textContent = '90% - Processing response';
          const data = await res.json();
          batchId = data.batch_id;
          uploadedEvents = data.events;
          
          // Restore upload zone
          uploadZone.innerHTML = '<i class="fas fa-cloud-upload-alt text-4xl text-blue-400 mb-4"></i><p class="text-lg mb-2">Drop CSV file here or click to browse</p><p class="text-muted text-sm">Format: Date (dd-mm-yyyy), Program, Venue, Team, Sound Requirements, Call Time, Crew</p><input type="file" id="csv-input" accept=".csv" class="hidden">';
          document.getElementById('csv-input').addEventListener('change', (ev) => { if (ev.target.files.length > 0) handleFileUpload(ev.target.files[0]); });
          
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
          if (char === '"') inQuotes = !inQuotes;
          else if (char === ',' && !inQuotes) { result.push(current); current = ''; }
          else current += char;
        }
        result.push(current);
        return result;
      }
      
      function renderUploadPreview() {
        document.getElementById('upload-preview').classList.remove('hidden');
        document.getElementById('step2-next').classList.remove('hidden');
        
        const groups = {};
        uploadedEvents.forEach(e => {
          const key = e.event_group || e.id;
          if (!groups[key]) groups[key] = [];
          groups[key].push(e);
        });
        const multiDayCount = Object.values(groups).filter(g => g.length > 1).length;
        const manualCount = uploadedEvents.filter(e => e.needs_manual_review).length;
        
        document.getElementById('event-count').textContent = uploadedEvents.length;
        document.getElementById('multiday-count').textContent = multiDayCount > 0 ? multiDayCount + ' multi-day' : '';
        document.getElementById('manual-count').textContent = manualCount > 0 ? manualCount + ' manual' : '';
        
        let html = '<table class="w-full text-sm"><thead><tr class="text-muted"><th class="text-left py-2">Event</th><th class="text-left py-2">Date</th><th class="text-left py-2">Venue</th><th class="text-left py-2">Team→Vertical</th><th class="py-2"></th></tr></thead><tbody>';
        const shown = new Set();
        for (const e of uploadedEvents) {
          const key = e.event_group || e.id;
          if (shown.has(key)) continue;
          shown.add(key);
          const group = groups[key];
          const dateDisplay = group.length > 1 ? formatDateDisplay(e.event_date) + ' <span class="text-blue-400">(' + group.length + 'd)</span>' : formatDateDisplay(e.event_date);
          const manualBadge = e.needs_manual_review ? '<span class="manual-badge ml-2">' + e.manual_flag_reason + '</span>' : '';
          html += '<tr class="border-t border-white/5"><td class="py-2">' + e.name.substring(0, 40) + (e.name.length > 40 ? '...' : '') + '</td><td class="py-2">' + dateDisplay + '</td><td class="py-2">' + e.venue + '</td><td class="py-2">' + e.vertical + manualBadge + '</td></tr>';
        }
        html += '</tbody></table>';
        document.getElementById('preview-table').innerHTML = html;
      }
      
      function renderStageRequirements() {
        const groups = {};
        uploadedEvents.forEach(e => {
          const key = e.event_group || 'single_' + e.id;
          if (!groups[key]) groups[key] = { events: [], firstEvent: e };
          groups[key].events.push(e);
        });
        
        let html = '<table class="w-full text-sm"><thead><tr class="text-muted"><th class="text-left py-2">Event</th><th class="text-left py-2">Venue</th><th class="text-left py-2">Crew #</th><th class="py-2"></th></tr></thead><tbody>';
        for (const [key, group] of Object.entries(groups)) {
          const e = group.firstEvent;
          const daysLabel = group.events.length > 1 ? ' <span class="text-blue-400">(' + group.events.length + 'd)</span>' : '';
          const manualBadge = e.needs_manual_review ? '<span class="manual-badge">' + (e.manual_flag_reason || 'Manual') + '</span>' : '';
          
          html += '<tr class="border-t border-white/5">';
          html += '<td class="py-3">' + e.name.substring(0, 35) + (e.name.length > 35 ? '...' : '') + daysLabel + '</td>';
          html += '<td class="py-3">' + e.venue + '</td>';
          html += '<td class="py-3">';
          html += '<select class="stage-select w-16" data-group="' + key + '" data-event-ids="' + group.events.map(ev => ev.id).join(',') + '">';
          for (let i = 0; i <= 5; i++) {
            const selected = i === e.stage_crew_needed ? 'selected' : '';
            html += '<option value="' + i + '" ' + selected + '>' + i + '</option>';
          }
          html += '</select>';
          html += '</td>';
          html += '<td class="py-3">' + manualBadge + '</td>';
          html += '</tr>';
        }
        html += '</tbody></table>';
        document.getElementById('stage-requirements').innerHTML = html;
        
        document.querySelectorAll('.stage-select').forEach(select => {
          select.addEventListener('change', async (e) => {
            const eventIds = e.target.dataset.eventIds.split(',');
            const value = parseInt(e.target.value);
            for (const id of eventIds) {
              await fetch('/api/events/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage_crew_needed: value }) });
              const evt = uploadedEvents.find(ev => ev.id == id);
              if (evt) evt.stage_crew_needed = value;
            }
          });
        });
      }
      
      async function runAssignmentEngine() {
        // Show progress
        const btn = document.getElementById('step3-run');
        const originalText = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<div class="flex items-center"><div class="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2"></div>Running engine...</div>';
        
        // Progress overlay
        const reqContainer = document.getElementById('stage-requirements');
        const progressHtml = '<div class="flex flex-col items-center justify-center py-8"><div class="animate-spin rounded-full h-16 w-16 border-b-2 border-blue-400 mb-4"></div><p class="text-lg font-medium" id="engine-progress">Initializing assignment engine...</p><p class="text-muted text-sm mt-2">Processing ' + uploadedEvents.length + ' events</p></div>';
        const savedContent = reqContainer.innerHTML;
        reqContainer.innerHTML = progressHtml;
        
        // Simulate progress updates
        const steps = ['Loading crew data...', 'Checking availability...', 'Running FOH assignments...', 'Running Stage assignments...', 'Finalizing...'];
        let stepIdx = 0;
        const progressInterval = setInterval(() => {
          if (stepIdx < steps.length) {
            document.getElementById('engine-progress').textContent = steps[stepIdx];
            stepIdx++;
          }
        }, 400);
        
        const res = await fetch('/api/assignments/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batch_id: batchId }) });
        clearInterval(progressInterval);
        
        const data = await res.json();
        assignments = data.assignments;
        conflicts = data.conflicts;
        
        // Restore button
        btn.disabled = false;
        btn.innerHTML = originalText;
        reqContainer.innerHTML = savedContent;
        
        renderAssignments();
        goToStep(4);
      }
      
      function renderAssignments() {
        const manualConflicts = conflicts.filter(c => c.type === 'Manual').length;
        const fohConflicts = conflicts.filter(c => c.type === 'FOH').length;
        const stageConflicts = conflicts.filter(c => c.type === 'Stage').length;
        const totalConflicts = conflicts.length;
        
        if (totalConflicts > 0) {
          let summary = '<span class="text-amber-400"><i class="fas fa-exclamation-triangle mr-2"></i>';
          const parts = [];
          if (manualConflicts > 0) parts.push(manualConflicts + ' manual');
          if (fohConflicts > 0) parts.push(fohConflicts + ' FOH');
          if (stageConflicts > 0) parts.push(stageConflicts + ' stage');
          summary += parts.join(', ') + ' conflicts</span>';
          document.getElementById('conflict-summary').innerHTML = summary;
          document.getElementById('conflicts-section').classList.remove('hidden');
          
          let conflictHtml = '';
          for (const c of conflicts) {
            const a = assignments.find(x => x.event_id === c.event_id);
            const badge = c.type === 'Manual' ? 'manual-badge' : 'conflict-badge';
            conflictHtml += '<div class="glass-card-light p-4"><div class="flex justify-between items-start">';
            conflictHtml += '<div><span class="font-medium">' + c.event_name.substring(0, 40) + '</span><br><span class="text-muted text-sm">' + (a?.venue || '') + ' | ' + c.reason + '</span></div>';
            conflictHtml += '<button class="btn-secondary px-3 py-1 rounded-lg text-sm edit-btn" data-event-id="' + c.event_id + '"><i class="fas fa-edit mr-1"></i>Edit</button>';
            conflictHtml += '</div></div>';
          }
          document.getElementById('conflicts-list').innerHTML = conflictHtml;
        } else {
          document.getElementById('conflict-summary').textContent = 'All events assigned successfully';
          document.getElementById('conflicts-section').classList.add('hidden');
        }
        
        let html = '<table class="w-full text-sm"><thead><tr class="text-muted"><th class="text-left py-2">Event</th><th class="text-left py-2">Date</th><th class="text-left py-2">Venue</th><th class="text-left py-2">Crew</th><th class="py-2"></th></tr></thead><tbody>';
        for (const a of assignments) {
          const crewList = [a.foh_name, ...(a.stage_names || [])].filter(Boolean).join(', ');
          let crewDisplay = crewList || '<span class="conflict-badge">Unassigned</span>';
          if (a.foh_specialist) crewDisplay = '<span class="specialist-badge mr-1">★</span>' + crewDisplay;
          if (a.needs_manual_review && !crewList) crewDisplay = '<span class="manual-badge">Manual</span>';
          
          html += '<tr class="border-t border-white/5">';
          html += '<td class="py-3">' + a.event_name.substring(0, 30) + (a.event_name.length > 30 ? '...' : '') + '</td>';
          html += '<td class="py-3">' + formatDateDisplay(a.event_date) + '</td>';
          html += '<td class="py-3">' + a.venue + '</td>';
          html += '<td class="py-3">' + crewDisplay + '</td>';
          html += '<td class="py-3"><button class="text-blue-400 hover:text-blue-300 edit-btn" data-event-id="' + a.event_id + '"><i class="fas fa-edit"></i></button></td>';
          html += '</tr>';
        }
        html += '</tbody></table>';
        document.getElementById('assignments-table').innerHTML = html;
        document.querySelectorAll('.edit-btn').forEach(btn => btn.addEventListener('click', () => openEditModal(parseInt(btn.dataset.eventId))));
      }
      
      function openEditModal(eventId) {
        const a = assignments.find(x => x.event_id === eventId);
        if (!a) return;
        
        document.getElementById('modal-title').textContent = a.event_name.substring(0, 50);
        document.getElementById('modal-subtitle').textContent = a.venue + ' | ' + a.vertical + ' | ' + formatDateDisplay(a.event_date);
        
        // Show venue dropdown for multi-venue events
        const venueSection = document.getElementById('modal-venue-section');
        const isMultiVenue = a.manual_flag_reason && a.manual_flag_reason.includes('Multi-venue');
        if (isMultiVenue) {
          venueSection.classList.remove('hidden');
          document.getElementById('modal-venue').value = a.venue_normalized || 'Others';
        } else {
          venueSection.classList.add('hidden');
        }
        const needed = uploadedEvents.find(e => e.id === eventId)?.stage_crew_needed || 1;
        document.getElementById('modal-stage-count').textContent = '(total crew: ' + needed + ')';
        
        let fohHtml = '<option value="">-- Select FOH --</option>';
        for (const c of crew) {
          if (c.level === 'Hired') continue;
          const selected = c.id === a.foh ? 'selected' : '';
          const badge = c.level === 'Senior' ? '⭐' : c.level === 'Mid' ? '●' : '○';
          fohHtml += '<option value="' + c.id + '" ' + selected + '>' + badge + ' ' + c.name + '</option>';
        }
        document.getElementById('modal-foh').innerHTML = fohHtml;
        
        let stageHtml = '';
        for (const c of crew) {
          if (!c.can_stage) continue;
          const checked = a.stage?.includes(c.id) ? 'checked' : '';
          const levelColor = c.level === 'Senior' ? 'text-blue-400' : c.level === 'Mid' ? 'text-teal-400' : c.level === 'Junior' ? 'text-amber-400' : 'text-gray-400';
          const label = c.name;  // OC1, OC2, OC3 names already correct
          stageHtml += '<label class="flex items-center gap-2 cursor-pointer p-2 hover:bg-white/5 rounded-lg">';
          stageHtml += '<input type="checkbox" class="stage-checkbox" value="' + c.id + '" ' + checked + '>';
          stageHtml += '<span class="' + levelColor + ' text-xs">' + c.level.charAt(0) + '</span><span>' + label + '</span></label>';
        }
        document.getElementById('modal-stage').innerHTML = stageHtml;
        document.getElementById('edit-modal').dataset.eventId = eventId;
        document.getElementById('edit-modal').classList.remove('hidden');
        document.getElementById('edit-modal').classList.add('flex');
      }
      
      async function saveModalChanges() {
        const eventId = parseInt(document.getElementById('edit-modal').dataset.eventId);
        const fohId = parseInt(document.getElementById('modal-foh').value) || null;
        const stageIds = [...document.querySelectorAll('.stage-checkbox:checked')].map(cb => parseInt(cb.value));
        
        await fetch('/api/assignments/' + eventId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ foh_id: fohId, stage_ids: stageIds }) });
        
        const a = assignments.find(x => x.event_id === eventId);
        if (a) {
          a.foh = fohId;
          a.foh_name = crew.find(c => c.id === fohId)?.name || null;
          a.foh_conflict = !fohId;
          a.stage = stageIds;
          a.stage_names = stageIds.map(id => {
            const c = crew.find(x => x.id === id);
            return c?.name;  // OC1, OC2, OC3 names already correct
          }).filter(Boolean);
        }
        
        conflicts = conflicts.filter(c => !(c.event_id === eventId && fohId));
        closeModal();
        renderAssignments();
      }
      
      function closeModal() {
        document.getElementById('edit-modal').classList.add('hidden');
        document.getElementById('edit-modal').classList.remove('flex');
      }
      
      function exportCSV() { window.location.href = '/api/export/csv?batch_id=' + batchId; }
      function exportCalendar() { window.location.href = '/api/export/calendar?batch_id=' + batchId; }
      function exportWorkload() { window.location.href = '/api/export/workload?month=' + formatMonth(currentMonth); }
      
      function goToStep(step) {
        for (let i = 1; i <= 5; i++) {
          document.getElementById('step' + i).classList.add('hidden');
          document.querySelector('.step-indicator[data-step="' + i + '"]').classList.remove('active', 'completed');
          if (i < step) document.querySelector('.step-indicator[data-step="' + i + '"]').classList.add('completed');
        }
        document.getElementById('step' + step).classList.remove('hidden');
        document.querySelector('.step-indicator[data-step="' + step + '"]').classList.add('active');
        currentStep = step;
        if (step === 3) renderStageRequirements();
      }
      
      function formatMonth(date) { return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0'); }
      
      function setupEventListeners() {
        document.getElementById('prev-month').addEventListener('click', () => { currentMonth.setMonth(currentMonth.getMonth() - 1); loadCrew().then(() => renderAvailabilityGrid()); });
        document.getElementById('next-month').addEventListener('click', () => { currentMonth.setMonth(currentMonth.getMonth() + 1); loadCrew().then(() => renderAvailabilityGrid()); });
        document.getElementById('mark-weekends').addEventListener('click', markAllWeekends);
        document.getElementById('clear-month').addEventListener('click', clearMonth);
        document.getElementById('step1-next').addEventListener('click', () => goToStep(2));
        document.getElementById('step2-back').addEventListener('click', () => goToStep(1));
        document.getElementById('step2-next').addEventListener('click', () => goToStep(3));
        document.getElementById('step3-back').addEventListener('click', () => goToStep(2));
        document.getElementById('step3-run').addEventListener('click', runAssignmentEngine);
        document.getElementById('step4-back').addEventListener('click', () => goToStep(3));
        document.getElementById('step4-next').addEventListener('click', () => goToStep(5));
        document.getElementById('step5-back').addEventListener('click', () => goToStep(4));
        document.getElementById('start-new').addEventListener('click', () => { uploadedEvents = []; batchId = null; assignments = []; conflicts = []; document.getElementById('upload-preview').classList.add('hidden'); document.getElementById('step2-next').classList.add('hidden'); document.getElementById('csv-input').value = ''; goToStep(1); });
        
        const uploadZone = document.getElementById('upload-zone');
        const csvInput = document.getElementById('csv-input');
        uploadZone.addEventListener('click', () => csvInput.click());
        uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('dragover'); });
        uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
        uploadZone.addEventListener('drop', (e) => { e.preventDefault(); uploadZone.classList.remove('dragover'); if (e.dataTransfer.files.length > 0) handleFileUpload(e.dataTransfer.files[0]); });
        csvInput.addEventListener('change', (e) => { if (e.target.files.length > 0) handleFileUpload(e.target.files[0]); });
        
        document.getElementById('modal-close').addEventListener('click', closeModal);
        document.getElementById('modal-cancel').addEventListener('click', closeModal);
        document.getElementById('modal-save').addEventListener('click', saveModalChanges);
        document.getElementById('edit-modal').addEventListener('click', (e) => { if (e.target.id === 'edit-modal') closeModal(); });
        
        document.getElementById('export-csv').addEventListener('click', exportCSV);
        document.getElementById('export-calendar').addEventListener('click', exportCalendar);
        document.getElementById('export-workload').addEventListener('click', exportWorkload);
      }
      
      init();
    </script>
</body>
</html>
  `)
})

export default app
