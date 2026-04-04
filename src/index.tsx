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
  is_outside_crew: boolean
  venue_capabilities: Record<string, string>
  vertical_capabilities: Record<string, string>
  special_notes: string
  monthly_assignment_cap: number | null
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
  'Little': 'Little Theatre',
  'Lib': 'Others',
  'Library': 'Others',
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

// ============================================
// CONFIG SYSTEM
// ============================================

type AppConfig = {
  workloadWeightMonthly: number
  workloadWeightSeniority: number
  workloadWeightHistorical: number
  workloadHistoryMonths: number
  scoreBase: number
  scoreStageNonurgentBonus: number
  scoreOcPenalty: number
  scorePreferredFohPenalty: number
  venueDefaults: Record<string, number>
  venueMap: Record<string, string>
  teamVerticalMap: Record<string, string>
}

async function loadConfig(DB: D1Database): Promise<AppConfig> {
  try {
    const rows = await DB.prepare('SELECT key, value FROM system_config').all()
    const raw: Record<string, string> = {}
    for (const r of rows.results as any[]) raw[r.key] = r.value
    const num = (k: string, fb: number) => raw[k] !== undefined ? parseFloat(raw[k]) : fb
    const jsn = (k: string, fb: any) => {
      try { return raw[k] ? JSON.parse(raw[k]) : fb }
      catch { return fb }
    }
    return {
      workloadWeightMonthly:    num('workload_weight_monthly', 1000),
      workloadWeightSeniority:  num('workload_weight_seniority', 100),
      workloadWeightHistorical: num('workload_weight_historical', 1),
      workloadHistoryMonths:    num('workload_history_months', 3),
      scoreBase:                num('score_base', 10000),
      scoreStageNonurgentBonus: num('score_stage_nonurgent_bonus', 50),
      scoreOcPenalty:           num('score_oc_penalty', 5000),
      scorePreferredFohPenalty: num('score_preferred_foh_penalty', 8000),
      venueDefaults:            jsn('venue_defaults', VENUE_DEFAULTS),
      venueMap:                 jsn('venue_map', VENUE_MAP),
      teamVerticalMap:          jsn('team_vertical_map', TEAM_TO_VERTICAL),
    }
  } catch {
    // system_config table not yet created (migration pending) — use hardcoded defaults
    return {
      workloadWeightMonthly: 1000,
      workloadWeightSeniority: 100,
      workloadWeightHistorical: 1,
      workloadHistoryMonths: 3,
      scoreBase: 10000,
      scoreStageNonurgentBonus: 50,
      scoreOcPenalty: 5000,
      scorePreferredFohPenalty: 8000,
      venueDefaults: { ...VENUE_DEFAULTS },
      venueMap: { ...VENUE_MAP },
      teamVerticalMap: { ...TEAM_TO_VERTICAL },
    }
  }
}

function mapVenue(raw: string, venueMap?: Record<string, string>): { mapped: string, isMultiVenue: boolean } {
  const trimmed = raw.trim()
  const map = venueMap || VENUE_MAP

  // Check for multi-venue patterns
  if (trimmed.includes(' & ') || trimmed.includes(',') ||
      (trimmed.includes('TT') && trimmed.includes('TET')) ||
      trimmed.toLowerCase().includes('all lawns') ||
      trimmed.toLowerCase().includes('gardens')) {
    return { mapped: 'Others', isMultiVenue: true }
  }

  // Try direct mapping
  if (map[trimmed]) {
    return { mapped: map[trimmed], isMultiVenue: false }
  }

  // Try partial matches
  for (const [key, value] of Object.entries(map)) {
    if (trimmed.toLowerCase().includes(key.toLowerCase())) {
      return { mapped: value, isMultiVenue: false }
    }
  }

  return { mapped: 'Others', isMultiVenue: false }
}

function mapTeamToVertical(team: string, teamMap?: Record<string, string>): string {
  const trimmed = team.trim()
  const map = teamMap || TEAM_TO_VERTICAL

  if (map[trimmed]) {
    return map[trimmed]
  }

  // Try partial matches
  for (const [key, value] of Object.entries(map)) {
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

// Check if venue looks like crew initials (possible column shift in CSV)
function isSuspiciousVenue(venue: string): boolean {
  const trimmed = venue.trim()
  const upper = trimmed.toUpperCase()
  const lower = trimmed.toLowerCase()
  
  // Known valid venue codes/names (case-insensitive)
  const validVenues = ['JBT', 'TT', 'TET', 'GDT', 'LT', 'DPAG', 'SVR', 'OAP', 'TATA', 'LIB', 'EXPL', 
                       'LITTLE', 'LIBRARY', 'ONLINE', 'SUNKEN', 'WEST']
  if (validVenues.includes(upper)) return false
  
  // Check if it contains known venue keywords
  const venueKeywords = ['theatre', 'theater', 'room', 'garden', 'hall', 'gallery', 'studio', 'foyer', 'lawn', 'online']
  if (venueKeywords.some(kw => lower.includes(kw))) return false
  
  // Flag if it's 2-4 uppercase letters only (likely crew initials like SP, AGN)
  if (/^[A-Z]{2,4}$/.test(trimmed)) return true
  
  // Flag if it looks like a person's name (single capitalized word, short)
  // But exclude common venue patterns
  if (/^[A-Z][a-z]+$/.test(trimmed) && trimmed.length <= 8) {
    // Exclude known venue words
    const excludeWords = ['little', 'expl', 'tata', 'west', 'main', 'back', 'front', 'upper', 'lower']
    if (excludeWords.includes(lower)) return false
    return true
  }
  
  return false
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
  const cfg = await loadConfig(DB)
  const { events } = await c.req.json()
  
  const batchId = `batch_${Date.now()}`
  
  // Normalize event fields (accept both 'program' and 'name')
  for (const event of events) {
    if (!event.name && event.program) {
      event.name = event.program
    }
  }
  
  // Group multi-day events by name
  const eventGroups: Record<string, any[]> = {}
  for (const event of events) {
    const eventName = event.name || 'Unnamed Event'
    if (!eventGroups[eventName]) {
      eventGroups[eventName] = []
    }
    eventGroups[eventName].push({ ...event, name: eventName })
  }
  
  const insertedEvents = []
  
  for (const [name, groupEvents] of Object.entries(eventGroups)) {
    // Sort by date and split into consecutive sub-groups only.
    // Events with the same name but a gap between dates are treated as separate assignments
    // because crew availability may differ on non-consecutive dates.
    const withDates = groupEvents.map(e => {
      let d = e.date || ''
      if (d.match(/^\d{2}-\d{2}-\d{4}$/)) {
        const [dd, mm, yyyy] = d.split('-')
        d = `${yyyy}-${mm}-${dd}`
      }
      return { ...e, _sortDate: d }
    }).sort((a, b) => a._sortDate.localeCompare(b._sortDate))

    const subGroups: any[][] = [[withDates[0]]]
    for (let i = 1; i < withDates.length; i++) {
      const prev = new Date(withDates[i - 1]._sortDate)
      const curr = new Date(withDates[i]._sortDate)
      const diffDays = Math.round((curr.getTime() - prev.getTime()) / 86400000)
      if (diffDays === 1) {
        subGroups[subGroups.length - 1].push(withDates[i])
      } else {
        subGroups.push([withDates[i]])
      }
    }

    for (const subGroup of subGroups) {
      const eventGroup = subGroup.length > 1 ? `group_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : null

      for (const event of subGroup) {
      // Ensure date is in yyyy-mm-dd format for consistent comparison with unavailability
      let eventDate = event.date || ''
      if (eventDate.match(/^\d{2}-\d{2}-\d{4}$/)) {
        // Convert dd-mm-yyyy to yyyy-mm-dd
        const [dd, mm, yyyy] = eventDate.split('-')
        eventDate = `${yyyy}-${mm}-${dd}`
      }
      
      // Map venue
      const { mapped: venue, isMultiVenue } = mapVenue(event.venue || '', cfg.venueMap)

      // Map team to vertical
      const vertical = mapTeamToVertical(event.team || '', cfg.teamVerticalMap)
      
      // Check manual-only conditions
      const manualCheck = isManualOnlyVenue(event.venue || '')
      let manualOnly = manualCheck.manual || isMultiVenue
      let manualReason = manualCheck.reason || (isMultiVenue ? 'Multi-venue event' : '')
      
      // Check for suspicious venue (possible CSV column shift)
      let isSuspicious = false
      if (isSuspiciousVenue(event.venue || '')) {
        isSuspicious = true
        manualOnly = true
        manualReason = manualReason ? manualReason + '; Suspicious venue: ' + event.venue : 'Suspicious venue: ' + event.venue + ' (check CSV columns)'
      }
      
      // No special-casing for any crew member name in sound requirements
      // Assignment follows standard rules based on venue/vertical capabilities
      
      // Default crew count - suspicious venues get 1 crew (not 0)
      const defaultCrew = isSuspicious ? 1 : (manualOnly ? 0 : (cfg.venueDefaults[venue] || 1))
      
      const result = await DB.prepare(
        `INSERT INTO events (batch_id, name, event_date, venue, venue_normalized, team, vertical, sound_requirements, call_time, stage_crew_needed, event_group, needs_manual_review, manual_flag_reason) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        batchId, 
        event.name, 
        eventDate,  // Normalized to yyyy-mm-dd
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
        event_date: eventDate,  // Normalized yyyy-mm-dd
        venue: event.venue || '',  // Original
        venue_normalized: venue,  // For rules
        team: event.team || '',
        vertical,
        sound_requirements: event.sound_requirements || '',
        call_time: event.call_time || '',
        stage_crew_needed: defaultCrew,
        event_group: eventGroup,
        is_multi_day: subGroup.length > 1,
        total_days: subGroup.length,
        needs_manual_review: manualOnly,
        manual_flag_reason: manualReason
      })
      }  // end for (const event of subGroup)
    }    // end for (const subGroup of subGroups)
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

// Processing priority for venues: higher-priority venues get first pick of available crew
// on the same date. Uses venue_normalized values.
const VENUE_PRIORITY: Record<string, number> = {
  'JBT': 1,
  'Tata': 2,
  'Experimental': 3,
  'Little Theatre': 4,
  'Godrej Dance': 5,
}
const getVenuePriority = (v: string): number => VENUE_PRIORITY[v] ?? 99

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
  const cfg = await loadConfig(DB)
  const { batch_id, foh_preferences } = await c.req.json()

  // Load persistent FOH preferences from DB, then merge session preferences (lower priority)
  const dbPrefsResult = await DB.prepare(
    'SELECT fp.*, c.name as crew_name FROM foh_preferences fp JOIN crew c ON fp.crew_id = c.id WHERE fp.is_active = 1'
  ).all()
  const dbPrefs = (dbPrefsResult.results as any[]).map(p => ({ ...p, eventContains: p.event_name_contains }))
  const sessionPrefs = (foh_preferences || []).map((p: any) => ({ ...p, match_mode: p.match_mode || 'contains', venue_filter: p.venue_filter || null }))
  // DB preferences take priority; session prefs are appended (for batch-specific one-offs)
  const preferences = [...dbPrefs, ...sessionPrefs]

  // Get all events
  const eventsResult = await DB.prepare(
    'SELECT * FROM events WHERE batch_id = ? ORDER BY event_date, name'
  ).bind(batch_id).all()
  const events = eventsResult.results as any[]

  // Get all crew
  const crewResult = await DB.prepare('SELECT * FROM crew').all()
  const crew = crewResult.results.map((c: any) => ({
    ...c,
    venue_capabilities: JSON.parse(c.venue_capabilities),
    vertical_capabilities: JSON.parse(c.vertical_capabilities)
  })) as CrewMember[]

  // Get current month for specialist rotation
  const currentMonth = events[0]?.event_date?.substring(0, 7) || new Date().toISOString().substring(0, 7)

  // ========== TWO-TIER WORKLOAD SYSTEM ==========

  // 1. Get rolling workload history for OVERALL balancing (configurable window)
  const [year, monthNum] = currentMonth.split('-').map(Number)
  const historyMonthsBack = cfg.workloadHistoryMonths + 1
  const historyStart = new Date(year, monthNum - historyMonthsBack, 1)
  const threeMonthStart = `${historyStart.getFullYear()}-${String(historyStart.getMonth() + 1).padStart(2, '0')}`
  
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

  // Helper: check if a preference matches an event (supports match_mode + venue_filter)
  const prefMatchesEvent = (p: any, ev: any): boolean => {
    const prefText = (p.event_name_contains || p.eventContains || '').toLowerCase()
    if (!prefText) return false
    const nameMatch = p.match_mode === 'exact'
      ? ev.name.toLowerCase() === prefText
      : ev.name.toLowerCase().includes(prefText)
    const venueMatch = !p.venue_filter || ev.venue_normalized === p.venue_filter
    return nameMatch && venueMatch
  }

  // Build map of preferred-FOH crew by date so stage assignment avoids grabbing them
  const preferredFohByDate: Record<string, Set<number>> = {}
  for (const pref of preferences) {
    for (const ev of events) {
      if (prefMatchesEvent(pref, ev)) {
        if (!preferredFohByDate[ev.event_date]) preferredFohByDate[ev.event_date] = new Set()
        preferredFohByDate[ev.event_date].add(pref.crewId)
      }
    }
  }

  // Sort: events with FOH preferences first, then multi-day, then by date
  // This ensures preferred crew are reserved for their specified events
  const hasMatchingPreference = (event: any): boolean => {
    return preferences.some((p: any) => prefMatchesEvent(p, event))
  }

  const sortedEvents = [...events].sort((a, b) => {
    // FOH-preference events first (ensure preferred crew is reserved)
    const aHasPref = hasMatchingPreference(a)
    const bHasPref = hasMatchingPreference(b)
    if (aHasPref && !bHasPref) return -1
    if (!aHasPref && bHasPref) return 1

    // Multi-day events next
    if (a.event_group && !b.event_group) return -1
    if (!a.event_group && b.event_group) return 1

    // Then by date
    const dateDiff = a.event_date.localeCompare(b.event_date)
    if (dateDiff !== 0) return dateDiff

    // Same date: higher-priority venue gets first pick of crew
    return getVenuePriority(a.venue_normalized) - getVenuePriority(b.venue_normalized)
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
      event_group: event.event_group || null,
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
        eventAssignment.foh_preference_applied = existing.foh_preference_applied || false
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
      // Generalised per-crew monthly cap (replaces hardcoded Naren-only limit)
      const crewMember = crew.find(c => c.id === crewId)
      if (crewMember?.monthly_assignment_cap != null) {
        if ((currentMonthWorkload[crewId] || 0) >= crewMember.monthly_assignment_cap) return false
      }
      return true
    }

    // ========== FOH ASSIGNMENT (Two-tier workload) ==========
    let selectedFOH: CrewMember | null = null
    let isSpecialistAssignment = false
    let preferenceConflict = false

    // Check for FOH preference match FIRST
    const matchingPref = preferences.find((p: any) => prefMatchesEvent(p, event))

    if (matchingPref) {
      const preferredCrew = crew.find(c => c.id === matchingPref.crewId)
      if (preferredCrew) {
        if (isAvailable(preferredCrew.id)) {
          const { can } = canDoFOH(preferredCrew, event.venue_normalized, event.vertical)
          if (can) {
            selectedFOH = preferredCrew
          } else {
            // BUG 1 FIX: crew is available but cannot do FOH for this venue/vertical — explicit conflict
            preferenceConflict = true
            eventAssignment.foh_conflict = true
            conflicts.push({
              event_id: event.id,
              event_name: event.name,
              type: 'FOH Preference',
              reason: `Preferred FOH "${preferredCrew.name}" cannot do FOH at ${event.venue_normalized} / ${event.vertical} — check capability matrix. Assign manually.`
            })
          }
        } else {
          // Crew unavailable (day-off, already assigned, or at monthly cap)
          preferenceConflict = true
          eventAssignment.foh_conflict = true
          const cap = preferredCrew.monthly_assignment_cap
          const capMsg = cap != null && (currentMonthWorkload[preferredCrew.id] || 0) >= cap
            ? ` (at monthly cap ${currentMonthWorkload[preferredCrew.id] || 0}/${cap})`
            : ' (day-off or already assigned)'
          conflicts.push({
            event_id: event.id,
            event_name: event.name,
            type: 'FOH Preference',
            reason: `Preferred FOH "${preferredCrew.name}" unavailable${capMsg}. Assign manually.`
          })
        }
      }
    }

    // BUG 3 FIX: skip normal FOH logic if any preference matched (applied OR conflict)
    if (!selectedFOH && !preferenceConflict) {
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
        const rotationIdx = verticalRotationIndex[event.vertical] || 0
        for (let i = 0; i < availableSpecialists.length; i++) {
          const idx = (rotationIdx + i) % availableSpecialists.length
          const candidateId = availableSpecialists[idx]
          const candidate = crew.find(c => c.id === candidateId)!
          selectedFOH = candidate
          isSpecialistAssignment = true
          verticalRotationIndex[event.vertical] = (idx + 1) % availableSpecialists.length
          break
        }
      }

      // If no specialist available, fall back to capable crew with hybrid scoring
      if (!selectedFOH) {
        const capableCandidates: { crew: CrewMember, score: number }[] = []

        for (const c of crew) {
          if (c.level === 'Hired') continue
          if (!isAvailable(c.id)) continue
          const capability = canDoFOH(c, event.venue_normalized, event.vertical)
          if (!capability.can) continue

          const monthlyWorkload = currentMonthWorkload[c.id] || 0
          const historicalWorkload = workload3Month[c.id] || 0
          const seniorityBonus = (3 - LEVEL_ORDER[c.level]) * cfg.workloadWeightSeniority

          let score = cfg.scoreBase
          score -= monthlyWorkload * cfg.workloadWeightMonthly
          score += seniorityBonus
          score -= historicalWorkload * cfg.workloadWeightHistorical

          capableCandidates.push({ crew: c, score })
        }

        capableCandidates.sort((a, b) => b.score - a.score)
        if (capableCandidates.length > 0) selectedFOH = capableCandidates[0].crew
      }

      if (selectedFOH) {
        eventAssignment.foh = selectedFOH.id
        eventAssignment.foh_name = selectedFOH.name
        eventAssignment.foh_level = selectedFOH.level
        eventAssignment.foh_specialist = isSpecialistAssignment
        eventAssignment.foh_preference_applied = false

        for (const date of eventDates) dailyAssignments[date].add(selectedFOH.id)
        currentMonthWorkload[selectedFOH.id] = (currentMonthWorkload[selectedFOH.id] || 0) + eventDates.length
        workload3Month[selectedFOH.id] = (workload3Month[selectedFOH.id] || 0) + eventDates.length
        await DB.prepare('INSERT INTO assignments (event_id, crew_id, role) VALUES (?, ?, ?)').bind(event.id, selectedFOH.id, 'FOH').run()
      } else {
        eventAssignment.foh_conflict = true
        // Surface helpful cap messages for any capped crew who could have done FOH
        const crewAtCap = crew.find(c => {
          if (!c.monthly_assignment_cap) return false
          return canDoFOH(c, event.venue_normalized, event.vertical).can &&
            (currentMonthWorkload[c.id] || 0) >= c.monthly_assignment_cap
        })
        const reason = crewAtCap
          ? `No qualified FOH available — ${crewAtCap.name} at monthly cap (${currentMonthWorkload[crewAtCap.id] || 0}/${crewAtCap.monthly_assignment_cap}). Assign manually.`
          : 'No qualified FOH available. Assign manually.'
        conflicts.push({ event_id: event.id, event_name: event.name, type: 'FOH', reason })
      }
    } else if (selectedFOH) {
      // Preference was applied successfully
      eventAssignment.foh = selectedFOH.id
      eventAssignment.foh_name = selectedFOH.name
      eventAssignment.foh_level = selectedFOH.level
      eventAssignment.foh_specialist = false
      eventAssignment.foh_preference_applied = true

      for (const date of eventDates) dailyAssignments[date].add(selectedFOH.id)
      currentMonthWorkload[selectedFOH.id] = (currentMonthWorkload[selectedFOH.id] || 0) + eventDates.length
      workload3Month[selectedFOH.id] = (workload3Month[selectedFOH.id] || 0) + eventDates.length
      await DB.prepare('INSERT INTO assignments (event_id, crew_id, role) VALUES (?, ?, ?)').bind(event.id, selectedFOH.id, 'FOH').run()
    }
    // If preferenceConflict is true, FOH is left unassigned for manual review

    // ========== STAGE ASSIGNMENT (Hybrid workload balancing) ==========
    const stageNeeded = event.stage_crew_needed - 1  // -1 because total includes FOH
    if (stageNeeded > 0) {
      const stageCandidates: { crew: CrewMember, score: number }[] = []

      for (const c of crew) {
        if (!c.can_stage) continue
        if (c.id === eventAssignment.foh) continue
        if (!isAvailable(c.id)) continue

        const monthlyWorkload = currentMonthWorkload[c.id] || 0
        const historicalWorkload = workload3Month[c.id] || 0

        let score = cfg.scoreBase
        score -= monthlyWorkload * cfg.workloadWeightMonthly
        if (!c.stage_only_if_urgent) score += cfg.scoreStageNonurgentBonus
        score -= historicalWorkload * cfg.workloadWeightHistorical
        if (c.level === 'Hired') score -= cfg.scoreOcPenalty

        const isPreferredFohOnThisDate = eventDates.some(d => preferredFohByDate[d]?.has(c.id))
        if (isPreferredFohOnThisDate) score -= cfg.scorePreferredFohPenalty

        stageCandidates.push({ crew: c, score })
      }
      
      stageCandidates.sort((a, b) => b.score - a.score)
      
      // Separate internal crew from outside crew (OC)
      const internalCandidates = stageCandidates.filter(c => c.crew.level !== 'Hired')
      const outsideCandidates = stageCandidates.filter(c => c.crew.level === 'Hired')
      
      const selectedStage: number[] = []
      const stageNames: string[] = []
      
      // Rule: Always try to have at least one internal crew on stage with OC
      // Select internal crew first, then fill remaining with OC if needed
      let internalSelected = 0
      let outsideSelected = 0
      
      // First pass: select from internal crew
      for (const candidate of internalCandidates) {
        if (selectedStage.length >= stageNeeded) break
        selectedStage.push(candidate.crew.id)
        stageNames.push(candidate.crew.name)
        internalSelected++
      }
      
      // Second pass: if still need more, use outside crew
      // But ensure we have at least 1 internal if using OC (unless no internal available)
      for (const candidate of outsideCandidates) {
        if (selectedStage.length >= stageNeeded) break
        selectedStage.push(candidate.crew.id)
        stageNames.push(candidate.crew.name)
        outsideSelected++
      }
      
      // Update workload tracking for selected crew
      for (let i = 0; i < selectedStage.length; i++) {
        const stageCrew = stageCandidates.find(c => c.crew.id === selectedStage[i])?.crew
        if (!stageCrew) continue
        
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
        stage: eventAssignment.stage,
        foh_preference_applied: eventAssignment.foh_preference_applied || false
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

  // Self-check: silently verify every slot has required roles; catch anything the main
  // loop may have missed (edge cases, manual events with stage crew, etc.)
  for (const a of assignments) {
    const ev = events.find((e: any) => e.id === a.event_id)
    const needed = ev?.stage_crew_needed ?? 0
    if (needed > 0 && !a.foh && !a.foh_conflict) {
      a.foh_conflict = true
      conflicts.push({ event_id: a.event_id, event_name: a.event_name, type: 'FOH', reason: 'FOH role unfilled' })
    }
    if (needed > 1 && a.stage.length < needed - 1 && !a.stage_conflict) {
      a.stage_conflict = true
      conflicts.push({ event_id: a.event_id, event_name: a.event_name, type: 'Stage', reason: `Stage unfilled: ${(a.foh ? 1 : 0) + a.stage.length}/${needed} assigned` })
    }
  }

  return c.json({ assignments, conflicts })
})

// Redo endpoint - reshuffles unlocked assignments with randomized rotation
app.post('/api/assignments/redo', async (c) => {
  const { DB } = c.env
  const cfg = await loadConfig(DB)
  const { batch_id, foh_preferences, locked_assignments } = await c.req.json()

  // Load persistent FOH preferences from DB, then merge session preferences (lower priority)
  const dbPrefsResult = await DB.prepare(
    'SELECT fp.*, c.name as crew_name FROM foh_preferences fp JOIN crew c ON fp.crew_id = c.id WHERE fp.is_active = 1'
  ).all()
  const dbPrefs = (dbPrefsResult.results as any[]).map(p => ({ ...p, eventContains: p.event_name_contains }))
  const sessionPrefs = (foh_preferences || []).map((p: any) => ({ ...p, match_mode: p.match_mode || 'contains', venue_filter: p.venue_filter || null }))
  const preferences = [...dbPrefs, ...sessionPrefs]

  const locked = locked_assignments || []

  // Build maps for quick locked lookup
  const lockedFoh: Record<number, number> = {} // event_id -> crew_id
  const lockedStage: Record<number, number[]> = {} // event_id -> crew_ids
  for (const l of locked) {
    if (l.lock_foh && l.foh) lockedFoh[l.event_id] = l.foh
    if (l.lock_stage && l.stage?.length) lockedStage[l.event_id] = l.stage
  }

  // Get all events
  const eventsResult = await DB.prepare(
    'SELECT * FROM events WHERE batch_id = ? ORDER BY event_date, name'
  ).bind(batch_id).all()
  const events = eventsResult.results as any[]

  // Get all crew
  const crewResult = await DB.prepare('SELECT * FROM crew').all()
  const crew = crewResult.results.map((c: any) => ({
    ...c,
    venue_capabilities: JSON.parse(c.venue_capabilities),
    vertical_capabilities: JSON.parse(c.vertical_capabilities)
  })) as CrewMember[]

  // Current month for workload
  const currentMonth = events[0]?.event_date?.substring(0, 7) || new Date().toISOString().substring(0, 7)

  // Get rolling workload history (configurable window)
  const [year, monthNum] = currentMonth.split('-').map(Number)
  const historyMonthsBack = cfg.workloadHistoryMonths + 1
  const historyStartRedo = new Date(year, monthNum - historyMonthsBack, 1)
  const threeMonthStart = `${historyStartRedo.getFullYear()}-${String(historyStartRedo.getMonth() + 1).padStart(2, '0')}`
  
  const workload3MonthResult = await DB.prepare(
    `SELECT crew_id, SUM(assignment_count) as total FROM workload_history 
     WHERE month >= ? AND month <= ? GROUP BY crew_id`
  ).bind(threeMonthStart, currentMonth).all()
  
  const workload3Month: Record<number, number> = {}
  for (const w of workload3MonthResult.results as any[]) {
    workload3Month[w.crew_id] = w.total
  }
  
  // Build specialist rotation (RANDOMIZED for redo)
  const verticalSpecialistRotation: Record<string, number[]> = {}
  const verticalRotationIndex: Record<string, number> = {}
  
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
  
  // RANDOMIZE rotation order for redo
  for (const vertical of Object.keys(verticalSpecialistRotation)) {
    const arr = verticalSpecialistRotation[vertical]
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]]
    }
    // Random starting index
    verticalRotationIndex[vertical] = Math.floor(Math.random() * arr.length)
  }
  
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

  // Clear only UNLOCKED assignments
  const lockedEventIds = [...new Set([...Object.keys(lockedFoh), ...Object.keys(lockedStage)].map(Number))]
  const allEventIds = events.map(e => e.id)
  const unlockedEventIds = allEventIds.filter(id => !lockedEventIds.includes(id))
  
  // Delete unlocked assignments
  if (unlockedEventIds.length > 0) {
    await DB.prepare(`DELETE FROM assignments WHERE event_id IN (${unlockedEventIds.join(',')})`).run()
  }
  // For partially locked events, delete unlocked roles
  for (const eventId of lockedEventIds) {
    const hasLockedFoh = lockedFoh[eventId] !== undefined
    const hasLockedStage = lockedStage[eventId] !== undefined
    
    if (hasLockedFoh && !hasLockedStage) {
      await DB.prepare('DELETE FROM assignments WHERE event_id = ? AND role = ?').bind(eventId, 'Stage').run()
    } else if (!hasLockedFoh && hasLockedStage) {
      await DB.prepare('DELETE FROM assignments WHERE event_id = ? AND role = ?').bind(eventId, 'FOH').run()
    }
    // If both locked, keep everything
  }
  
  const assignments: any[] = []
  const conflicts: any[] = []
  const dailyAssignments: Record<string, Set<number>> = {}
  const multiDayAssignments: Record<string, { foh: number | null, stage: number[] }> = {}

  // Helper: check if a preference matches an event (supports match_mode + venue_filter)
  const prefMatchesEvent = (p: any, ev: any): boolean => {
    const prefText = (p.event_name_contains || p.eventContains || '').toLowerCase()
    if (!prefText) return false
    const nameMatch = p.match_mode === 'exact'
      ? ev.name.toLowerCase() === prefText
      : ev.name.toLowerCase().includes(prefText)
    const venueMatch = !p.venue_filter || ev.venue_normalized === p.venue_filter
    return nameMatch && venueMatch
  }

  // Build map of preferred-FOH crew by date to protect them from stage grabs
  const preferredFohByDate: Record<string, Set<number>> = {}
  for (const pref of preferences) {
    for (const ev of events) {
      if (prefMatchesEvent(pref, ev)) {
        if (!preferredFohByDate[ev.event_date]) preferredFohByDate[ev.event_date] = new Set()
        preferredFohByDate[ev.event_date].add(pref.crewId)
      }
    }
  }

  // Pre-populate dailyAssignments with locked crew
  for (const event of events) {
    const date = event.event_date
    if (!dailyAssignments[date]) dailyAssignments[date] = new Set()
    if (lockedFoh[event.id]) dailyAssignments[date].add(lockedFoh[event.id])
    if (lockedStage[event.id]) {
      for (const crewId of lockedStage[event.id]) dailyAssignments[date].add(crewId)
    }
  }

  // Helper: check if crew available on all event dates
  const isAvailable = (crewId: number, dates: string[]): boolean => {
    for (const date of dates) {
      if (unavailMap[date]?.has(crewId)) return false
      if (dailyAssignments[date]?.has(crewId)) return false
    }
    // Generalised per-crew monthly cap
    const crewMember = crew.find(c => c.id === crewId)
    if (crewMember?.monthly_assignment_cap != null) {
      if ((currentMonthWorkload[crewId] || 0) >= crewMember.monthly_assignment_cap) return false
    }
    return true
  }

  // Sort: preferences first, then multi-day, then by date
  const hasMatchingPreference = (event: any): boolean => {
    return preferences.some((p: any) => prefMatchesEvent(p, event))
  }
  
  const sortedEvents = [...events].sort((a, b) => {
    const aHasPref = hasMatchingPreference(a)
    const bHasPref = hasMatchingPreference(b)
    if (aHasPref && !bHasPref) return -1
    if (!aHasPref && bHasPref) return 1
    if (a.event_group && !b.event_group) return -1
    if (!a.event_group && b.event_group) return 1
    const dateDiff = a.event_date.localeCompare(b.event_date)
    if (dateDiff !== 0) return dateDiff
    return getVenuePriority(a.venue_normalized) - getVenuePriority(b.venue_normalized)
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
      event_group: event.event_group || null,
      foh: null,
      foh_name: null,
      stage: [],
      stage_names: [],
      foh_conflict: false,
      stage_conflict: false,
      needs_manual_review: event.needs_manual_review,
      manual_flag_reason: event.manual_flag_reason
    }

    const eventDates = [event.event_date]
    for (const date of eventDates) {
      if (!dailyAssignments[date]) dailyAssignments[date] = new Set()
    }
    
    // ========== FOH ASSIGNMENT ==========
    if (lockedFoh[event.id]) {
      // Use locked FOH
      const lockedCrewId = lockedFoh[event.id]
      const lockedCrewMember = crew.find(c => c.id === lockedCrewId)
      eventAssignment.foh = lockedCrewId
      eventAssignment.foh_name = lockedCrewMember?.name
      eventAssignment.foh_locked = true
    } else if (event.needs_manual_review) {
      eventAssignment.foh_conflict = true
      conflicts.push({
        event_id: event.id,
        event_name: event.name,
        type: 'Manual',
        reason: event.manual_flag_reason || 'Manual assignment required'
      })
    } else {
      // Standard assignment logic
      let selectedFOH: CrewMember | null = null
      let isSpecialistAssignment = false
      let preferenceConflict = false

      // Check preferences first
      const matchingPref = preferences.find((p: any) => prefMatchesEvent(p, event))

      if (matchingPref) {
        const preferredCrew = crew.find(c => c.id === matchingPref.crewId)
        if (preferredCrew) {
          if (isAvailable(preferredCrew.id, eventDates)) {
            const { can, isSpecialist } = canDoFOH(preferredCrew, event.venue_normalized, event.vertical)
            if (can) {
              selectedFOH = preferredCrew
              isSpecialistAssignment = isSpecialist
            } else {
              // BUG 1 FIX: crew available but cannot do FOH for this venue/vertical — explicit conflict
              preferenceConflict = true
              eventAssignment.foh_conflict = true
              conflicts.push({
                event_id: event.id,
                event_name: event.name,
                type: 'FOH Preference',
                reason: `Preferred FOH "${preferredCrew.name}" cannot do FOH at ${event.venue_normalized} / ${event.vertical} — check capability matrix. Assign manually.`
              })
            }
          } else {
            // Crew unavailable
            preferenceConflict = true
            eventAssignment.foh_conflict = true
            const cap = preferredCrew.monthly_assignment_cap
            const capMsg = cap != null && (currentMonthWorkload[preferredCrew.id] || 0) >= cap
              ? ` (at monthly cap ${currentMonthWorkload[preferredCrew.id] || 0}/${cap})`
              : ' (day-off or already assigned)'
            conflicts.push({
              event_id: event.id,
              event_name: event.name,
              type: 'FOH Preference',
              reason: `Preferred FOH "${preferredCrew.name}" unavailable${capMsg}. Assign manually.`
            })
          }
        }
      }

      // BUG 3 FIX: skip normal FOH logic if any preference matched (applied OR conflict)
      if (!selectedFOH && !preferenceConflict) {
        // Try specialist rotation
        const specialistIds = verticalSpecialistRotation[event.vertical] || []
        for (let i = 0; i < specialistIds.length; i++) {
          const rotIdx = verticalRotationIndex[event.vertical] || 0
          const idx = (rotIdx + i) % specialistIds.length
          const crewId = specialistIds[idx]
          const candidate = crew.find(c => c.id === crewId)!
          if (isAvailable(crewId, eventDates)) {
            const { can } = canDoFOH(candidate, event.venue_normalized, event.vertical)
            if (can) {
              selectedFOH = candidate
              isSpecialistAssignment = true
              verticalRotationIndex[event.vertical] = (idx + 1) % specialistIds.length
              break
            }
          }
        }

        if (!selectedFOH) {
          // Fallback: hybrid scoring
          const capableCandidates: { crew: CrewMember, score: number }[] = []
          for (const c of crew) {
            if (c.level === 'Hired') continue
            if (!isAvailable(c.id, eventDates)) continue
            const { can } = canDoFOH(c, event.venue_normalized, event.vertical)
            if (!can) continue
            const monthlyWorkload = currentMonthWorkload[c.id] || 0
            const historicalWorkload = workload3Month[c.id] || 0
            const seniorityBonus = (3 - LEVEL_ORDER[c.level]) * cfg.workloadWeightSeniority
            let score = cfg.scoreBase
            score -= monthlyWorkload * cfg.workloadWeightMonthly
            score += seniorityBonus
            score -= historicalWorkload * cfg.workloadWeightHistorical
            capableCandidates.push({ crew: c, score })
          }
          capableCandidates.sort((a, b) => b.score - a.score)
          if (capableCandidates.length > 0) selectedFOH = capableCandidates[0].crew
        }

        if (selectedFOH) {
          eventAssignment.foh = selectedFOH.id
          eventAssignment.foh_name = selectedFOH.name
          eventAssignment.foh_level = selectedFOH.level
          eventAssignment.foh_specialist = isSpecialistAssignment
          eventAssignment.foh_preference_applied = false
          for (const date of eventDates) dailyAssignments[date].add(selectedFOH.id)
          currentMonthWorkload[selectedFOH.id] = (currentMonthWorkload[selectedFOH.id] || 0) + 1
          await DB.prepare('INSERT INTO assignments (event_id, crew_id, role) VALUES (?, ?, ?)').bind(event.id, selectedFOH.id, 'FOH').run()
        } else {
          eventAssignment.foh_conflict = true
          const crewAtCap = crew.find(c => {
            if (!c.monthly_assignment_cap) return false
            return canDoFOH(c, event.venue_normalized, event.vertical).can &&
              (currentMonthWorkload[c.id] || 0) >= c.monthly_assignment_cap
          })
          const reason = crewAtCap
            ? `No qualified FOH available — ${crewAtCap.name} at monthly cap. Assign manually.`
            : 'No qualified FOH available. Assign manually.'
          conflicts.push({ event_id: event.id, event_name: event.name, type: 'FOH', reason })
        }
      } else if (selectedFOH) {
        // Preference was applied successfully
        eventAssignment.foh = selectedFOH.id
        eventAssignment.foh_name = selectedFOH.name
        eventAssignment.foh_level = selectedFOH.level
        eventAssignment.foh_specialist = isSpecialistAssignment
        eventAssignment.foh_preference_applied = true
        for (const date of eventDates) dailyAssignments[date].add(selectedFOH.id)
        currentMonthWorkload[selectedFOH.id] = (currentMonthWorkload[selectedFOH.id] || 0) + 1
        await DB.prepare('INSERT INTO assignments (event_id, crew_id, role) VALUES (?, ?, ?)').bind(event.id, selectedFOH.id, 'FOH').run()
      }
    }

    // ========== STAGE CREW ASSIGNMENT ==========
    if (lockedStage[event.id]) {
      eventAssignment.stage = lockedStage[event.id]
      eventAssignment.stage_names = lockedStage[event.id].map(id => crew.find(c => c.id === id)?.name).filter(Boolean)
      eventAssignment.stage_locked = true
    } else if (!event.needs_manual_review) {
      const stageNeeded = (event.stage_crew_needed || 2) - (eventAssignment.foh ? 1 : 0)

      if (stageNeeded > 0) {
        const stageCandidates: { crew: CrewMember, score: number }[] = []
        for (const c of crew) {
          if (!c.can_stage) continue
          if (!isAvailable(c.id, eventDates)) continue
          if (c.id === eventAssignment.foh) continue

          const monthlyWorkload = currentMonthWorkload[c.id] || 0
          const historicalWorkload = workload3Month[c.id] || 0
          let score = cfg.scoreBase
          score -= monthlyWorkload * cfg.workloadWeightMonthly
          if (!c.stage_only_if_urgent) score += cfg.scoreStageNonurgentBonus
          score -= historicalWorkload * cfg.workloadWeightHistorical
          if (c.level === 'Hired') score -= cfg.scoreOcPenalty
          const isPreferredFoh = eventDates.some(d => preferredFohByDate[d]?.has(c.id))
          if (isPreferredFoh) score -= cfg.scorePreferredFohPenalty
          stageCandidates.push({ crew: c, score })
        }
        stageCandidates.sort((a, b) => b.score - a.score)

        const internalCrew = stageCandidates.filter(c => c.crew.level !== 'Hired')
        const outsideCrew = stageCandidates.filter(c => c.crew.level === 'Hired')
        const selectedStage: number[] = []

        for (const { crew: c } of internalCrew) {
          if (selectedStage.length >= stageNeeded) break
          selectedStage.push(c.id)
        }
        for (const { crew: c } of outsideCrew) {
          if (selectedStage.length >= stageNeeded) break
          selectedStage.push(c.id)
        }

        eventAssignment.stage = selectedStage
        eventAssignment.stage_names = selectedStage.map(id => crew.find(c => c.id === id)?.name).filter(Boolean)

        for (const crewId of selectedStage) {
          for (const date of eventDates) dailyAssignments[date].add(crewId)
          currentMonthWorkload[crewId] = (currentMonthWorkload[crewId] || 0) + 1
          await DB.prepare('INSERT INTO assignments (event_id, crew_id, role) VALUES (?, ?, ?)').bind(event.id, crewId, 'Stage').run()
        }

        if (selectedStage.length < stageNeeded) {
          eventAssignment.stage_conflict = true
          conflicts.push({
            event_id: event.id, event_name: event.name, type: 'Stage',
            reason: `Need ${stageNeeded} stage, only ${selectedStage.length} available`
          })
        }
      }
    }
    
    assignments.push(eventAssignment)
  }

  // Self-check: silently verify every slot has required roles
  for (const a of assignments) {
    const ev = events.find((e: any) => e.id === a.event_id)
    const needed = ev?.stage_crew_needed ?? 0
    if (needed > 0 && !a.foh && !a.foh_conflict) {
      a.foh_conflict = true
      conflicts.push({ event_id: a.event_id, event_name: a.event_name, type: 'FOH', reason: 'FOH role unfilled' })
    }
    if (needed > 1 && a.stage.length < needed - 1 && !a.stage_conflict) {
      a.stage_conflict = true
      conflicts.push({ event_id: a.event_id, event_name: a.event_name, type: 'Stage', reason: `Stage unfilled: ${(a.foh ? 1 : 0) + a.stage.length}/${needed} assigned` })
    }
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
    
    // Keep yyyy-mm-dd format for ncpa-sound.pages.dev compatibility
    let dateOut = e.event_date
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
// ADMIN API
// ============================================

// --- Config CRUD ---

app.get('/api/config', async (c) => {
  const { DB } = c.env
  try {
    const rows = await DB.prepare('SELECT key, value, description, config_type, updated_at FROM system_config ORDER BY key').all()
    return c.json(rows.results)
  } catch {
    return c.json([]) // table not yet created
  }
})

app.put('/api/config/:key', async (c) => {
  const { DB } = c.env
  const key = c.req.param('key')
  const { value } = await c.req.json()
  if (value === undefined || value === null) return c.json({ error: 'value required' }, 400)

  // Fetch type for validation
  const row = await DB.prepare('SELECT config_type FROM system_config WHERE key = ?').bind(key).first() as any
  if (!row) return c.json({ error: 'Config key not found' }, 404)

  if (row.config_type === 'number') {
    if (isNaN(parseFloat(String(value)))) return c.json({ error: 'Value must be a valid number' }, 400)
  }
  if (row.config_type === 'json') {
    try { JSON.parse(String(value)) } catch { return c.json({ error: 'Value must be valid JSON' }, 400) }
  }

  await DB.prepare('UPDATE system_config SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?')
    .bind(String(value), key).run()
  return c.json({ success: true, key, value })
})

// Per-crew monthly cap
app.put('/api/crew/:id/cap', async (c) => {
  const { DB } = c.env
  const id = parseInt(c.req.param('id'))
  const { cap } = await c.req.json()
  const capVal = cap === null || cap === '' ? null : parseInt(String(cap))
  if (cap !== null && cap !== '' && isNaN(capVal as number)) return c.json({ error: 'cap must be a number or null' }, 400)
  await DB.prepare('UPDATE crew SET monthly_assignment_cap = ? WHERE id = ?').bind(capVal, id).run()
  return c.json({ success: true, id, cap: capVal })
})

// --- Persistent FOH Preferences CRUD ---

app.get('/api/preferences', async (c) => {
  const { DB } = c.env
  try {
    const rows = await DB.prepare(
      `SELECT fp.*, c.name as crew_name FROM foh_preferences fp
       JOIN crew c ON fp.crew_id = c.id
       ORDER BY fp.created_at DESC`
    ).all()
    return c.json(rows.results)
  } catch {
    return c.json([])
  }
})

app.post('/api/preferences', async (c) => {
  const { DB } = c.env
  const { event_name_contains, crew_id, venue_filter, match_mode } = await c.req.json()
  if (!event_name_contains || !crew_id) return c.json({ error: 'event_name_contains and crew_id required' }, 400)
  const result = await DB.prepare(
    `INSERT INTO foh_preferences (event_name_contains, crew_id, venue_filter, match_mode) VALUES (?, ?, ?, ?)`
  ).bind(event_name_contains.trim(), crew_id, venue_filter || null, match_mode || 'contains').run()
  return c.json({ success: true, id: (result as any).meta?.last_row_id })
})

app.put('/api/preferences/:id', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const { event_name_contains, crew_id, venue_filter, match_mode, is_active } = await c.req.json()
  const fields: string[] = []
  const values: any[] = []
  if (event_name_contains !== undefined) { fields.push('event_name_contains = ?'); values.push(event_name_contains) }
  if (crew_id !== undefined) { fields.push('crew_id = ?'); values.push(crew_id) }
  if (venue_filter !== undefined) { fields.push('venue_filter = ?'); values.push(venue_filter || null) }
  if (match_mode !== undefined) { fields.push('match_mode = ?'); values.push(match_mode) }
  if (is_active !== undefined) { fields.push('is_active = ?'); values.push(is_active ? 1 : 0) }
  if (fields.length === 0) return c.json({ error: 'Nothing to update' }, 400)
  values.push(id)
  await DB.prepare(`UPDATE foh_preferences SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run()
  return c.json({ success: true })
})

app.delete('/api/preferences/:id', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  await DB.prepare('DELETE FROM foh_preferences WHERE id = ?').bind(id).run()
  return c.json({ success: true })
})

// --- History Import ---

// Minimal server-side CSV parser
function parseCSVServer(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) return []
  const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase())
  const rows: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i])
    const row: Record<string, string> = {}
    headers.forEach((h, idx) => { row[h] = vals[idx]?.trim() || '' })
    rows.push(row)
  }
  return rows
}

function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
      else inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      result.push(current); current = ''
    } else {
      current += ch
    }
  }
  result.push(current)
  return result
}

app.post('/api/history/import/preview', async (c) => {
  const { DB } = c.env
  const cfg = await loadConfig(DB)
  const { csv_text } = await c.req.json()
  if (!csv_text) return c.json({ error: 'csv_text required' }, 400)

  const rows = parseCSVServer(csv_text)
  const crewResult = await DB.prepare('SELECT id, name, level FROM crew').all()
  const allCrew = crewResult.results as any[]

  // Normalise crew name for matching
  const normName = (n: string) => n.toLowerCase().replace(/\s+/g, ' ').trim()
  const crewByNorm: Map<string, any> = new Map(allCrew.map(c => [normName(c.name), c]))

  const matchName = (raw: string): any | null => {
    const n = normName(raw)
    if (!n) return null
    if (crewByNorm.has(n)) return crewByNorm.get(n)
    // Partial match
    for (const [key, crew] of crewByNorm.entries()) {
      if (n.includes(key) || key.includes(n)) return crew
    }
    return null
  }

  const parsedRows: any[] = []
  const unmatchedNames = new Set<string>()

  for (const row of rows) {
    const dateRaw = row['date'] || ''
    let eventDate = dateRaw.trim()
    // Normalise date to yyyy-mm-dd
    if (eventDate.match(/^\d{2}-\d{2}-\d{4}$/)) {
      const [dd, mm, yyyy] = eventDate.split('-')
      eventDate = `${yyyy}-${mm}-${dd}`
    }
    if (!eventDate.match(/^\d{4}-\d{2}-\d{2}$/)) continue

    const eventName = row['program'] || row['name'] || row['event'] || ''
    const venueRaw = row['venue'] || ''
    const teamRaw = row['team'] || ''
    const crewRaw = row['crew'] || ''

    const venueNormalized = mapVenue(venueRaw, cfg.venueMap).mapped
    const vertical = mapTeamToVertical(teamRaw, cfg.teamVerticalMap)

    // Parse crew column — comma separated names
    const crewNames = crewRaw.split(',').map(n => n.trim()).filter(Boolean)
    const matched: any[] = []

    for (let i = 0; i < crewNames.length; i++) {
      const name = crewNames[i]
      const c = matchName(name)
      if (c) {
        if (c.level === 'Hired') continue // skip OC crew
        matched.push({ crew_id: c.id, name: c.name, role_guess: i === 0 ? 'FOH' : 'Stage' })
      } else {
        unmatchedNames.add(name)
      }
    }

    if (matched.length > 0) {
      parsedRows.push({
        date: eventDate,
        event_name: eventName,
        venue_normalized: venueNormalized,
        vertical,
        crew_raw: crewRaw,
        matched,
        unmatched_names: crewNames.filter(n => !matchName(n))
      })
    }
  }

  return c.json({
    parsed_rows: parsedRows,
    unmatched: [...unmatchedNames],
    total_csv_rows: rows.length,
    matched_rows: parsedRows.length
  })
})

app.post('/api/history/import/commit', async (c) => {
  const { DB } = c.env
  // assignments: [{crew_id, month, role}] (month = 'YYYY-MM')
  const { assignments, mode } = await c.req.json()
  if (!assignments || !Array.isArray(assignments)) return c.json({ error: 'assignments array required' }, 400)

  // Aggregate by (crew_id, month)
  const totals: Record<string, number> = {}
  for (const a of assignments) {
    const key = `${a.crew_id}__${a.month}`
    totals[key] = (totals[key] || 0) + 1
  }

  let importedCount = 0
  for (const [key, count] of Object.entries(totals)) {
    const [crewId, month] = key.split('__')
    if (mode === 'replace') {
      await DB.prepare(
        `INSERT INTO workload_history (crew_id, month, assignment_count) VALUES (?, ?, ?)
         ON CONFLICT(crew_id, month) DO UPDATE SET assignment_count = excluded.assignment_count`
      ).bind(parseInt(crewId), month, count).run()
    } else {
      await DB.prepare(
        `INSERT INTO workload_history (crew_id, month, assignment_count) VALUES (?, ?, ?)
         ON CONFLICT(crew_id, month) DO UPDATE SET assignment_count = assignment_count + excluded.assignment_count`
      ).bind(parseInt(crewId), month, count).run()
    }
    importedCount += count
  }

  return c.json({ success: true, imported_assignments: importedCount, unique_crew_months: Object.keys(totals).length })
})

app.post('/api/history/patterns', async (c) => {
  // Mine FOH assignment patterns from submitted assignment data
  const { assignments } = await c.req.json()
  if (!assignments || !Array.isArray(assignments)) return c.json({ error: 'assignments required' }, 400)

  const { DB } = c.env
  const crewResult = await DB.prepare('SELECT id, name FROM crew').all()
  const crewById: Record<number, string> = {}
  for (const cr of crewResult.results as any[]) crewById[cr.id] = cr.name

  // Count FOH assignments per (crew, vertical, venue)
  const fohCounts: Record<string, { crew_id: number, vertical: string, venue: string, foh_count: number }> = {}
  const totalCounts: Record<string, number> = {} // key: vertical__venue

  for (const a of assignments) {
    const comboKey = `${a.vertical}__${a.venue_normalized}`
    totalCounts[comboKey] = (totalCounts[comboKey] || 0) + 1

    if (a.role === 'FOH') {
      const key = `${a.crew_id}__${a.vertical}__${a.venue_normalized}`
      if (!fohCounts[key]) fohCounts[key] = { crew_id: a.crew_id, vertical: a.vertical, venue: a.venue_normalized, foh_count: 0 }
      fohCounts[key].foh_count++
    }
  }

  const patterns = Object.values(fohCounts).map(p => {
    const comboKey = `${p.vertical}__${p.venue}`
    const total = totalCounts[comboKey] || 1
    return {
      crew_id: p.crew_id,
      crew_name: crewById[p.crew_id] || String(p.crew_id),
      vertical: p.vertical,
      venue: p.venue,
      foh_count: p.foh_count,
      total_events: total,
      pct: Math.round((p.foh_count / total) * 100)
    }
  }).sort((a, b) => b.pct - a.pct || b.foh_count - a.foh_count)

  return c.json(patterns)
})

app.get('/api/history/summary', async (c) => {
  const { DB } = c.env
  const rows = await DB.prepare(
    `SELECT c.name, c.level, SUM(wh.assignment_count) as total
     FROM workload_history wh JOIN crew c ON wh.crew_id = c.id
     GROUP BY c.id ORDER BY total DESC`
  ).all()
  return c.json(rows.results)
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
    <title>Assignment Automator</title>
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
      .day-cell { width: 36px; height: 36px; border-radius: 8px; transition: all 0.2s ease; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 12px; border: 1px solid rgba(255,255,255,0.06); }
      .day-cell:hover { background: rgba(96,165,250,0.2); border-color: rgba(96,165,250,0.3); }
      .day-cell.unavailable { background: rgba(248,113,113,0.3); color: #f87171; border-color: rgba(248,113,113,0.4); }
      .day-cell.weekend { background: rgba(251,191,36,0.1); border-color: rgba(251,191,36,0.15); }
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
      .admin-tab { color: #9ca3af; }
      .admin-tab:hover { color: #f5f0e8; background: rgba(255,255,255,0.05); }
      .admin-tab.active { color: #60a5fa; background: rgba(59,130,246,0.15); border-bottom: 2px solid #3b82f6; }
      .admin-input { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #f5f0e8; padding: 6px 10px; width: 100%; }
      .admin-input:focus { outline: none; border-color: rgba(96,165,250,0.5); }
      .admin-ta { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #f5f0e8; padding: 8px 10px; width: 100%; font-family: monospace; font-size: 12px; resize: vertical; }
      .admin-ta:focus { outline: none; border-color: rgba(96,165,250,0.5); }
      .pref-badge { background: rgba(59,130,246,0.15); color: #60a5fa; padding: 2px 8px; border-radius: 6px; font-size: 11px; }
    </style>
</head>
<body class="text-cream">
    <div id="app" class="min-h-screen p-6">
      <header class="max-w-6xl mx-auto mb-8 fade-in">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="text-2xl font-semibold tracking-tight">
              <i class="fas fa-sliders-h text-blue-400 mr-3"></i>Assignment Automator
            </h1>
            <p class="text-muted text-sm mt-1">Sound Crew bulk assignment</p>
          </div>
          <div class="flex items-center gap-4">
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
            <button id="admin-btn" onclick="openAdminPanel()" title="Admin Settings"
              class="w-10 h-10 rounded-full flex items-center justify-center text-gray-400 hover:text-blue-400 hover:bg-white/10 transition-colors border border-white/10">
              <i class="fas fa-cog text-sm"></i>
            </button>
          </div>
        </div>
      </header>

      <!-- Admin Panel Overlay -->
      <div id="admin-panel" class="fixed inset-0 modal-overlay hidden items-center justify-center z-50">
        <div class="glass-card p-6 w-full max-w-4xl mx-4 slide-up" style="max-height:90vh;overflow:hidden;display:flex;flex-direction:column">
          <div class="flex justify-between items-center mb-4">
            <div class="flex items-center gap-2">
              <i class="fas fa-cog text-blue-400 text-lg"></i>
              <h2 class="text-lg font-semibold">Admin Settings</h2>
            </div>
            <button onclick="closeAdminPanel()" class="text-gray-400 hover:text-white transition-colors">
              <i class="fas fa-times text-xl"></i>
            </button>
          </div>
          <!-- Admin Tabs -->
          <div class="flex gap-1 mb-4 border-b border-white/10 pb-0">
            <button class="admin-tab active px-4 py-2 text-sm font-medium rounded-t-lg transition-colors" data-tab="config" onclick="switchAdminTab('config')">
              <i class="fas fa-sliders-h mr-2"></i>Config
            </button>
            <button class="admin-tab px-4 py-2 text-sm font-medium rounded-t-lg transition-colors" data-tab="history" onclick="switchAdminTab('history')">
              <i class="fas fa-history mr-2"></i>History Import
            </button>
            <button class="admin-tab px-4 py-2 text-sm font-medium rounded-t-lg transition-colors" data-tab="preferences" onclick="switchAdminTab('preferences')">
              <i class="fas fa-thumbtack mr-2"></i>Persistent Preferences
            </button>
          </div>
          <!-- Tab Content -->
          <div id="admin-content" style="overflow-y:auto;flex:1;padding-right:4px"></div>
        </div>
      </div>
      
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
            <div class="flex items-center gap-6 text-sm text-muted">
              <span><span class="inline-block w-4 h-4 rounded bg-red-400/30 mr-2"></span>Day Off</span>
              <span><span class="inline-block w-4 h-4 rounded bg-amber-400/10 mr-2"></span>Weekend</span>
              <span class="border-l border-white/20 pl-6">Crew: <span class="text-blue-400 ml-2">●</span> Senior <span class="text-teal-400 ml-2">●</span> Mid <span class="text-amber-400 ml-2">○</span> Junior</span>
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
          
          <!-- FOH Preferences Section -->
          <div class="mt-6">
            <div class="flex items-center justify-between mb-2">
              <h3 class="text-lg font-medium flex items-center gap-2"><i class="fas fa-star text-amber-400"></i>FOH Preferences</h3>
            </div>

            <!-- Persistent preferences (from DB) -->
            <div id="persistent-prefs-summary" class="glass-card-light p-3 mb-3 text-xs text-muted">
              <i class="fas fa-database mr-1 text-blue-400"></i><span id="persistent-prefs-count">Loading persistent preferences...</span>
              <button onclick="openAdminPanel();switchAdminTab('preferences')" class="text-blue-400 hover:text-blue-300 ml-2">Manage →</button>
            </div>

            <!-- Session preferences (this batch only) -->
            <div class="mb-2">
              <div class="flex items-center justify-between mb-1">
                <span class="text-sm font-medium text-amber-400"><i class="fas fa-clock mr-1"></i>This Batch Only</span>
                <button id="add-preference-btn" class="btn-secondary px-3 py-1.5 rounded-lg text-xs"><i class="fas fa-plus mr-1"></i>Add Session Preference</button>
              </div>
              <p class="text-muted text-xs mb-2">One-off overrides for this batch (e.g. training assignments). Cleared when you start a new batch.</p>
            </div>

            <!-- Session Preferences List -->
            <div id="preferences-list" class="glass-card-light p-4 mb-4 hidden">
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-muted border-b border-white/10">
                    <th class="text-left py-2 w-8">#</th>
                    <th class="text-left py-2">Event Contains</th>
                    <th class="text-left py-2">FOH Crew</th>
                    <th class="text-left py-2 w-12"></th>
                  </tr>
                </thead>
                <tbody id="preferences-tbody"></tbody>
              </table>
            </div>

            <!-- Add Session Preference Form (hidden by default) -->
            <div id="preference-form" class="glass-card-light p-4 hidden">
              <div class="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                <div class="relative">
                  <label class="block text-sm text-muted mb-2">Event Name Contains</label>
                  <input type="text" id="pref-event" class="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" placeholder="Type to search events..." autocomplete="off">
                  <div id="pref-event-suggestions" class="absolute z-50 w-full mt-1 bg-gray-800 border border-white/20 rounded-lg max-h-48 overflow-y-auto hidden"></div>
                </div>
                <div>
                  <label class="block text-sm text-muted mb-2">FOH Crew</label>
                  <select id="pref-foh" class="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400">
                    <option value="">Select FOH</option>
                  </select>
                </div>
                <div class="flex gap-2">
                  <button id="save-preference" class="btn-primary px-4 py-2 rounded-lg text-sm flex-1"><i class="fas fa-check mr-1"></i>Add</button>
                  <button id="cancel-preference" class="btn-secondary px-4 py-2 rounded-lg text-sm"><i class="fas fa-times"></i></button>
                </div>
              </div>
            </div>
          </div>
          
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
          
          <!-- Workload Summary Panel -->
          <div id="workload-panel" class="mt-4 glass-card-light p-4">
            <div class="flex items-center justify-between mb-3 cursor-pointer" id="workload-toggle">
              <h4 class="font-medium text-sm"><i class="fas fa-chart-bar text-blue-400 mr-2"></i>Crew Workload (This Batch)</h4>
              <i class="fas fa-chevron-down text-gray-400 text-xs" id="workload-chevron"></i>
            </div>
            <div id="workload-content" class="text-sm flex flex-wrap gap-3"></div>
          </div>
          
          <div class="flex justify-between mt-6">
            <button id="step4-back" class="btn-secondary px-6 py-3 rounded-xl font-medium"><i class="fas fa-arrow-left mr-2"></i> Back</button>
            <div class="flex gap-3">
              <button id="redo-assignments" class="btn-secondary px-6 py-3 rounded-xl font-medium"><i class="fas fa-redo mr-2"></i>Redo Unlocked</button>
              <button id="step4-next" class="btn-primary px-6 py-3 rounded-xl font-medium">Finalize <i class="fas fa-arrow-right ml-2"></i></button>
            </div>
          </div>
        </section>
        
        <!-- Step 5: Export -->
        <section id="step5" class="glass-card p-8 mb-6 hidden">
          <h2 class="text-xl font-semibold flex items-center gap-3 mb-6"><i class="fas fa-download text-blue-400"></i>Export Assignments</h2>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
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

          </div>
          <div class="flex justify-between mt-6">
            <button id="step5-back" class="btn-secondary px-6 py-3 rounded-xl font-medium"><i class="fas fa-arrow-left mr-2"></i> Back to Edit</button>
            <button id="start-new" class="btn-primary px-6 py-3 rounded-xl font-medium"><i class="fas fa-plus mr-2"></i>Start New Batch</button>
          </div>
        </section>
      </main>
      
      <!-- Export Preview Modal -->
      <div id="export-preview-modal" class="fixed inset-0 modal-overlay hidden items-center justify-center z-50">
        <div class="glass-card p-6 w-full max-w-4xl mx-4 slide-up max-h-[90vh] flex flex-col">
          <div class="flex justify-between items-center mb-4">
            <h3 class="text-lg font-semibold"><i class="fas fa-file-csv text-blue-400 mr-2"></i>Export Preview</h3>
            <button id="preview-close" class="text-gray-400 hover:text-white"><i class="fas fa-times text-xl"></i></button>
          </div>
          <div id="export-preview-table" class="overflow-auto flex-1 mb-4"></div>
          <div class="flex justify-end gap-3">
            <button id="preview-cancel" class="btn-secondary px-4 py-2 rounded-xl">Cancel</button>
            <button id="preview-download" class="btn-primary px-4 py-2 rounded-xl"><i class="fas fa-download mr-2"></i>Download CSV</button>
          </div>
        </div>
      </div>
      
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
              <!-- Smart Swap Panel (hidden by default) -->
              <div id="swap-panel" class="hidden mt-3 p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg">
                <div class="flex items-center gap-2 text-blue-400 text-sm mb-2">
                  <i class="fas fa-exchange-alt"></i>
                  <span class="font-medium">Smart Swap Available</span>
                </div>
                <p id="swap-description" class="text-sm text-muted mb-3"></p>
                <div id="swap-details" class="text-sm space-y-1 mb-3"></div>
                <button id="swap-btn" class="btn-primary px-4 py-2 rounded-lg text-sm w-full">
                  <i class="fas fa-exchange-alt mr-2"></i>Confirm Swap
                </button>
              </div>
            </div>
            <div>
              <label class="block text-sm font-medium mb-2">Stage Crew <span id="modal-stage-count" class="text-muted"></span></label>
              <div id="modal-stage" class="glass-card-light p-3 max-h-48 overflow-y-auto space-y-2"></div>
              <p class="text-muted text-xs mt-2"><span class="text-yellow-400">⭐</span> Specialist <span class="text-blue-400 ml-2">●</span> Senior <span class="text-teal-400 ml-2">●</span> Mid <span class="text-amber-400 ml-2">○</span> Junior <span class="ml-2">|</span> <span class="text-red-400 ml-2">Red</span> = busy <span class="text-gray-500 ml-2">Grey</span> = day off</p>
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
      let fohPreferences = []; // Batch-only FOH preferences: { eventContains, crewId, crewName }
      let lockedAssignments = {}; // { eventId: { foh: true/false, stage: true/false } }
      
      // Helper: Convert yyyy-mm-dd to dd-mm-yyyy for display
      function formatDateDisplay(dateStr) {
        if (!dateStr) return '';
        // Check for yyyy-mm-dd format (use test with explicit pattern)
        const parts = dateStr.split('-');
        if (parts.length === 3 && parts[0].length === 4 && parts[1].length === 2 && parts[2].length === 2) {
          return parts[2] + '-' + parts[1] + '-' + parts[0];
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
        
        // Sort crew: Naren first (second in command), then by level
        const sortedCrew = [...crew].filter(c => c.level !== 'Hired').sort((a, b) => {
          if (a.name === 'Naren') return -1;
          if (b.name === 'Naren') return 1;
          return 0; // Keep original level-based order for others
        });
        
        for (const c of sortedCrew) {
          const levelColor = c.level === 'Senior' ? 'text-blue-400' : c.level === 'Mid' ? 'text-teal-400' : 'text-amber-400';
          html += '<tr class="border-b border-white/5 hover:bg-white/[0.02]"><td class="py-2 px-3 whitespace-nowrap sticky left-0 bg-gray-900/80 border-r border-white/10"><span class="' + levelColor + ' mr-2">' + (c.level === 'Senior' ? '●' : c.level === 'Mid' ? '●' : '○') + '</span>' + c.name + '</td>';
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
          const rows = parseCSV(text);
          const events = [];
          rawEventData = [];
          
          // Skip header row
          const totalRows = rows.length - 1;
          for (let i = 1; i < rows.length; i++) {
            const parts = rows[i];
            if (parts.length >= 2) {
              let dateStr = parts[0] || '';
              // Convert dd-mm-yyyy to yyyy-mm-dd for storage
              if (dateStr.match(/^\d{2}-\d{2}-\d{4}$/)) {
                const [dd, mm, yyyy] = dateStr.split('-');
                dateStr = yyyy + '-' + mm + '-' + dd;
              }
              // Also handle yyyy-mm-dd (already correct format)
              const evt = {
                date: dateStr,
                name: parts[1] || '',
                venue: parts[2] || '',
                team: parts[3] || '',
                sound_requirements: parts[4] || '',
                call_time: parts[5] || ''
              };
              if (evt.date && evt.name) {
                events.push(evt);
                rawEventData.push(evt);
              }
            }
            if (i % 10 === 0) {
              const pct = 50 + Math.round((i / totalRows) * 25);
              document.getElementById('upload-progress').textContent = pct + '% - Parsed ' + i + '/' + totalRows + ' events';
            }
          }
          
          document.getElementById('upload-progress').textContent = '75% - Uploading to server';
          const res = await fetch('/api/events/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events }) });
          document.getElementById('upload-progress').textContent = '90% - Processing response';
          const data = await res.json();
          batchId = data.batch_id;
          uploadedEvents = data.events;
          
          // Sort events chronologically by date, then by name
          uploadedEvents.sort((a, b) => {
            const dateCompare = a.event_date.localeCompare(b.event_date);
            if (dateCompare !== 0) return dateCompare;
            return a.name.localeCompare(b.name);
          });
          
          // Restore upload zone
          uploadZone.innerHTML = '<i class="fas fa-cloud-upload-alt text-4xl text-blue-400 mb-4"></i><p class="text-lg mb-2">Drop CSV file here or click to browse</p><p class="text-muted text-sm">Format: Date (dd-mm-yyyy), Program, Venue, Team, Sound Requirements, Call Time, Crew</p><input type="file" id="csv-input" accept=".csv" class="hidden">';
          document.getElementById('csv-input').addEventListener('change', (ev) => { if (ev.target.files.length > 0) handleFileUpload(ev.target.files[0]); });
          
          renderUploadPreview();
        };
        reader.readAsText(file);
      }
      
      // Parse CSV with multi-line field support
      function parseCSV(text) {
        const rows = [];
        let current = '';
        let inQuotes = false;
        let row = [];
        const CR = String.fromCharCode(13); // \\r
        const LF = String.fromCharCode(10); // \\n
        
        for (let i = 0; i < text.length; i++) {
          const char = text[i];
          const nextChar = text[i + 1];
          
          if (char === '"') {
            if (inQuotes && nextChar === '"') {
              current += '"';
              i++; // Skip escaped quote
            } else {
              inQuotes = !inQuotes;
            }
          } else if (char === ',' && !inQuotes) {
            row.push(current.trim());
            current = '';
          } else if ((char === CR || char === LF) && !inQuotes) {
            if (char === CR && nextChar === LF) i++; // Skip CRLF
            if (current || row.length > 0) {
              row.push(current.trim());
              if (row.some(cell => cell)) rows.push(row); // Skip empty rows
              row = [];
              current = '';
            }
          } else {
            current += char;
          }
        }
        // Handle last row
        if (current || row.length > 0) {
          row.push(current.trim());
          if (row.some(cell => cell)) rows.push(row);
        }
        return rows;
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
        let lastDate = '';
        for (const e of uploadedEvents) {
          const key = e.event_group || e.id;
          if (shown.has(key)) continue;
          shown.add(key);
          const group = groups[key];
          
          // Add date divider line when date changes
          const currentDate = e.event_date;
          const borderClass = lastDate && lastDate !== currentDate ? 'border-t-2 border-blue-500/30' : 'border-t border-white/5';
          lastDate = currentDate;
          
          const dateDisplay = group.length > 1 ? formatDateDisplay(e.event_date) + ' <span class="text-blue-400">(' + group.length + 'd)</span>' : formatDateDisplay(e.event_date);
          const manualBadge = e.needs_manual_review ? '<span class="manual-badge ml-2">' + e.manual_flag_reason + '</span>' : '';
          html += '<tr class="' + borderClass + '"><td class="py-2">' + e.name.substring(0, 40) + (e.name.length > 40 ? '...' : '') + '</td><td class="py-2">' + dateDisplay + '</td><td class="py-2">' + e.venue + '</td><td class="py-2">' + e.vertical + manualBadge + '</td></tr>';
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
        
        let html = '<table class="w-full text-sm"><thead><tr class="text-muted"><th class="text-left py-2" style="width:60%">Event</th><th class="text-left py-2">Venue</th><th class="text-left py-2">Crew #</th><th class="py-2"></th></tr></thead><tbody>';
        for (const [key, group] of Object.entries(groups)) {
          const e = group.firstEvent;
          const daysLabel = group.events.length > 1 ? ' <span class="text-blue-400">(' + group.events.length + 'd)</span>' : '';
          const manualBadge = e.needs_manual_review ? '<span class="manual-badge">' + (e.manual_flag_reason || 'Manual') + '</span>' : '';
          
          html += '<tr class="border-t border-white/5">';
          html += '<td class="py-3" style="line-height:1.4; word-wrap:break-word"><span class="block text-sm">' + e.name + '</span>' + daysLabel + '</td>';
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
        
        // Initialize FOH preferences UI
        renderPreferencesUI();
      }
      
      // FOH Preferences Functions
      function showPreferenceForm() {
        const form = document.getElementById('preference-form');
        form.classList.remove('hidden');
        
        // Populate FOH dropdown with non-OC crew
        const fohSelect = document.getElementById('pref-foh');
        fohSelect.innerHTML = '<option value="">Select FOH</option>';
        crew.filter(c => c.level !== 'Hired' && !c.is_outside_crew).forEach(c => {
          fohSelect.innerHTML += '<option value="' + c.id + '">' + c.name + ' (' + c.level + ')</option>';
        });
        
        // Clear inputs
        document.getElementById('pref-event').value = '';
        document.getElementById('pref-foh').value = '';
        document.getElementById('pref-event-suggestions').classList.add('hidden');
      }
      
      function hidePreferenceForm() {
        document.getElementById('preference-form').classList.add('hidden');
        document.getElementById('pref-event-suggestions').classList.add('hidden');
      }

      async function loadPersistentPrefsCount() {
        try {
          const res = await fetch('/api/preferences');
          const prefs = await res.json();
          const active = prefs.filter(p => p.is_active);
          const el = document.getElementById('persistent-prefs-count');
          if (!el) return;
          if (active.length === 0) {
            el.textContent = 'No persistent preferences set.';
          } else {
            el.textContent = active.length + ' persistent preference' + (active.length !== 1 ? 's' : '') + ' active: ' +
              active.slice(0, 3).map(p => '"' + p.event_name_contains + '" → ' + p.crew_name).join(', ') +
              (active.length > 3 ? ' ...' : '');
          }
        } catch {}
      }
      
      function handleEventInput(e) {
        const input = e.target.value.trim().toLowerCase();
        const suggestionsDiv = document.getElementById('pref-event-suggestions');
        
        if (input.length < 2) {
          suggestionsDiv.classList.add('hidden');
          return;
        }
        
        // Find matching events from uploadedEvents
        const matches = uploadedEvents.filter(ev => 
          ev.name.toLowerCase().includes(input)
        );
        
        // Get unique event names with their venues
        const uniqueMatches = {};
        matches.forEach(ev => {
          const key = ev.name.substring(0, 40);
          if (!uniqueMatches[key]) {
            uniqueMatches[key] = { name: ev.name, venue: ev.venue_normalized, rawVenue: ev.venue };
          }
        });
        
        const matchList = Object.values(uniqueMatches).slice(0, 8);
        
        if (matchList.length === 0) {
          suggestionsDiv.classList.add('hidden');
          return;
        }
        
        let html = '';
        matchList.forEach(m => {
          html += '<div class="px-3 py-2 hover:bg-white/10 cursor-pointer text-sm border-b border-white/5" data-name="' + m.name.replace(/"/g, '&quot;') + '" data-venue="' + m.venue + '">';
          html += '<span class="text-cream">' + m.name.substring(0, 45) + (m.name.length > 45 ? '...' : '') + '</span>';
          html += '<span class="text-muted text-xs ml-2">@ ' + m.venue + '</span>';
          html += '</div>';
        });
        
        suggestionsDiv.innerHTML = html;
        suggestionsDiv.classList.remove('hidden');
        
        // Add click handlers to suggestions
        suggestionsDiv.querySelectorAll('div').forEach(div => {
          div.addEventListener('click', () => selectEventSuggestion(div.dataset.name, div.dataset.venue));
        });
      }
      
      function selectEventSuggestion(name, venue) {
        // Extract a short search term from the event name (first 2-3 significant words)
        const words = name.split(/\s+/).filter(w => w.length > 0);
        const searchTerm = words.slice(0, 3).join(' ');

        document.getElementById('pref-event').value = searchTerm || name.substring(0, 20);
        document.getElementById('pref-event-suggestions').classList.add('hidden');
      }
      
      function savePreference() {
        const eventContains = document.getElementById('pref-event').value.trim();
        const crewId = document.getElementById('pref-foh').value;

        if (!eventContains || !crewId) {
          alert('Please fill in all fields: Event Name and FOH Crew');
          return;
        }

        const crewMember = crew.find(c => c.id == crewId);
        if (!crewMember) return;

        // Check for duplicate preference
        const exists = fohPreferences.some(p =>
          p.eventContains.toLowerCase() === eventContains.toLowerCase()
        );
        if (exists) {
          alert('A preference for this event name already exists');
          return;
        }

        fohPreferences.push({
          eventContains: eventContains,
          crewId: parseInt(crewId),
          crewName: crewMember.name
        });
        console.log('Saved preference:', JSON.stringify(fohPreferences));

        hidePreferenceForm();
        renderPreferencesUI();
      }
      
      function deletePreference(index) {
        fohPreferences.splice(index, 1);
        renderPreferencesUI();
      }
      
      function renderPreferencesUI() {
        const listContainer = document.getElementById('preferences-list');
        const tbody = document.getElementById('preferences-tbody');
        
        if (fohPreferences.length === 0) {
          listContainer.classList.add('hidden');
          return;
        }
        
        listContainer.classList.remove('hidden');
        let html = '';
        fohPreferences.forEach((p, idx) => {
          html += '<tr class="border-t border-white/5">';
          html += '<td class="py-2 text-muted">' + (idx + 1) + '</td>';
          html += '<td class="py-2"><span class="text-blue-400">' + escapeHtml(p.eventContains) + '</span></td>';
          html += '<td class="py-2 font-medium">' + p.crewName + '</td>';
          html += '<td class="py-2"><button class="text-red-400 hover:text-red-300 delete-pref-btn" data-index="' + idx + '"><i class="fas fa-trash-alt"></i></button></td>';
          html += '</tr>';
        });
        tbody.innerHTML = html;
        
        // Attach delete handlers
        document.querySelectorAll('.delete-pref-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const index = parseInt(e.currentTarget.dataset.index);
            deletePreference(index);
          });
        });
      }
      
      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }

      function showToast(message, type = 'success') {
        let toast = document.getElementById('toast-msg');
        if (!toast) {
          toast = document.createElement('div');
          toast.id = 'toast-msg';
          toast.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;padding:10px 18px;border-radius:10px;font-size:13px;font-weight:500;transition:opacity 0.3s;box-shadow:0 4px 20px rgba(0,0,0,0.4)';
          document.body.appendChild(toast);
        }
        toast.style.background = type === 'error' ? 'rgba(248,113,113,0.9)' : 'rgba(52,211,153,0.9)';
        toast.style.color = '#0f1419';
        toast.style.opacity = '1';
        toast.textContent = message;
        clearTimeout(toast._timeout);
        toast._timeout = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
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
        
        const res = await fetch('/api/assignments/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batch_id: batchId, foh_preferences: fohPreferences }) });
        clearInterval(progressInterval);
        
        const data = await res.json();
        assignments = data.assignments;
        conflicts = data.conflicts;
        
        // Sort assignments chronologically by date, then by name
        assignments.sort((a, b) => {
          const dateCompare = a.event_date.localeCompare(b.event_date);
          if (dateCompare !== 0) return dateCompare;
          return a.event_name.localeCompare(b.event_name);
        });
        
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
        
        let html = '<table class="w-full text-sm"><thead><tr class="text-muted"><th class="text-left py-2">Event</th><th class="text-left py-2">Date</th><th class="text-left py-2">Venue</th><th class="text-left py-2">FOH</th><th class="text-left py-2">Stage</th><th class="py-2"></th></tr></thead><tbody>';
        let lastDate = '';
        for (const a of assignments) {
          const fohDisplay = a.foh_name ? (a.foh_specialist ? '<span class="specialist-badge mr-1">★</span>' + a.foh_name : a.foh_name) + (a.foh_preference_applied ? ' <i class="fas fa-thumbtack text-xs text-teal-400 opacity-80" title="FOH preference applied"></i>' : '') : '<span class="conflict-badge">Unassigned</span>';
          const stageDisplay = (a.stage_names || []).join(', ') || '-';
          
          // Lock status
          const isLocked = lockedAssignments[a.event_id] || {};
          const fohLockIcon = isLocked.foh ? 'fa-lock text-amber-400' : 'fa-lock-open text-gray-500';
          const stageLockIcon = isLocked.stage ? 'fa-lock text-amber-400' : 'fa-lock-open text-gray-500';
          
          // Add date divider line when date changes
          const currentDate = a.event_date;
          const borderClass = lastDate && lastDate !== currentDate ? 'border-t-2 border-blue-500/30' : 'border-t border-white/5';
          lastDate = currentDate;
          
          html += '<tr class="' + borderClass + '">';
          html += '<td class="py-3">' + a.event_name.substring(0, 30) + (a.event_name.length > 30 ? '...' : '') + '</td>';
          html += '<td class="py-3">' + formatDateDisplay(a.event_date) + '</td>';
          html += '<td class="py-3">' + a.venue + '</td>';
          html += '<td class="py-3"><span class="mr-2">' + fohDisplay + '</span><button class="lock-btn opacity-60 hover:opacity-100" data-event-id="' + a.event_id + '" data-type="foh" title="' + (isLocked.foh ? 'Unlock FOH' : 'Lock FOH') + '"><i class="fas ' + fohLockIcon + ' text-xs"></i></button></td>';
          html += '<td class="py-3"><span class="mr-2">' + stageDisplay + '</span><button class="lock-btn opacity-60 hover:opacity-100" data-event-id="' + a.event_id + '" data-type="stage" title="' + (isLocked.stage ? 'Unlock Stage' : 'Lock Stage') + '"><i class="fas ' + stageLockIcon + ' text-xs"></i></button></td>';
          html += '<td class="py-3"><button class="text-blue-400 hover:text-blue-300 edit-btn" data-event-id="' + a.event_id + '"><i class="fas fa-edit"></i></button></td>';
          html += '</tr>';
        }
        html += '</tbody></table>';
        document.getElementById('assignments-table').innerHTML = html;
        document.querySelectorAll('.edit-btn').forEach(btn => btn.addEventListener('click', () => openEditModal(parseInt(btn.dataset.eventId))));
        document.querySelectorAll('.lock-btn').forEach(btn => btn.addEventListener('click', () => toggleLock(parseInt(btn.dataset.eventId), btn.dataset.type)));
        
        // Render workload summary
        renderWorkloadSummary();
      }
      
      function renderWorkloadSummary() {
        // Count assignments per crew member
        const workload = {};
        for (const a of assignments) {
          if (a.foh_name) {
            workload[a.foh_name] = (workload[a.foh_name] || 0) + 1;
          }
          for (const name of (a.stage_names || [])) {
            workload[name] = (workload[name] || 0) + 1;
          }
        }
        
        // Sort by count descending
        const sorted = Object.entries(workload).sort((a, b) => b[1] - a[1]);
        
        if (sorted.length === 0) {
          document.getElementById('workload-content').innerHTML = '<span class="text-muted">No assignments yet</span>';
          return;
        }
        
        // Find max/min for color coding
        const counts = sorted.map(x => x[1]);
        const maxCount = Math.max(...counts);
        const minCount = Math.min(...counts);
        const avgCount = counts.reduce((a, b) => a + b, 0) / counts.length;
        
        const narenCapLimit = 9;
        let html = '';
        for (const [name, count] of sorted) {
          // Color: green if below avg, yellow if avg, red if high
          let colorClass = 'text-teal-400'; // balanced
          if (count > avgCount + 2) colorClass = 'text-red-400'; // overloaded
          else if (count > avgCount) colorClass = 'text-amber-400'; // slightly high

          const capSuffix = name === 'Naren' ? ' <span class="text-white/40 text-xs">(' + count + '/' + narenCapLimit + ' cap)</span>' : '';
          html += '<span class="px-2 py-1 rounded bg-white/5">' + name + ': <span class="' + colorClass + ' font-medium">' + count + '</span>' + capSuffix + '</span>';
        }
        
        document.getElementById('workload-content').innerHTML = html;
      }
      
      function toggleLock(eventId, type) {
        if (!lockedAssignments[eventId]) lockedAssignments[eventId] = {};
        lockedAssignments[eventId][type] = !lockedAssignments[eventId][type];
        renderAssignments();
      }
      
      async function openEditModal(eventId) {
        const a = assignments.find(x => x.event_id === eventId);
        if (!a) return;
        
        const eventDate = a.event_date;
        
        // Find all crew assigned to OTHER events on the same date
        const busyCrewOnDate = {};
        const dayOffCrew = new Set();
        
        // Check assignments for same date
        for (const other of assignments) {
          if (other.event_id === eventId) continue; // Skip current event
          if (other.event_date !== eventDate) continue; // Different date
          
          if (other.foh) {
            if (!busyCrewOnDate[other.foh]) busyCrewOnDate[other.foh] = [];
            busyCrewOnDate[other.foh].push(other.event_name.substring(0, 20));
          }
          for (const stageId of (other.stage || [])) {
            if (!busyCrewOnDate[stageId]) busyCrewOnDate[stageId] = [];
            busyCrewOnDate[stageId].push(other.event_name.substring(0, 20));
          }
        }
        
        // Fetch unavailability for the event's month to ensure day-off data is available
        // This is needed because the Step 1 calendar may show a different month
        const eventMonth = eventDate.substring(0, 7); // yyyy-mm
        try {
          const unavailRes = await fetch('/api/unavailability?month=' + eventMonth);
          const unavailData = await unavailRes.json();
          // Merge into unavailability (don't overwrite, just ensure this month's data exists)
          for (const u of unavailData) {
            if (!unavailability[u.crew_id]) unavailability[u.crew_id] = new Set();
            unavailability[u.crew_id].add(u.unavailable_date);
          }
        } catch (e) {
          console.error('Failed to fetch unavailability for event month:', e);
        }
        
        // Check unavailability for this date (now with fresh data for event's month)
        // Normalize eventDate to yyyy-mm-dd for comparison (unavailability dates are stored as yyyy-mm-dd)
        let normalizedEventDate = eventDate;
        if (eventDate.match(/^\\d{2}-\\d{2}-\\d{4}$/)) {
          // Convert dd-mm-yyyy to yyyy-mm-dd
          const [dd, mm, yyyy] = eventDate.split('-');
          normalizedEventDate = yyyy + '-' + mm + '-' + dd;
        } else if (eventDate.match(/^\\d{2}\\/\\d{2}\\/\\d{4}$/)) {
          // Convert dd/mm/yyyy to yyyy-mm-dd
          const [dd, mm, yyyy] = eventDate.split('/');
          normalizedEventDate = yyyy + '-' + mm + '-' + dd;
        }
        
        for (const crewId in unavailability) {
          if (unavailability[crewId].has(normalizedEventDate)) {
            dayOffCrew.add(parseInt(crewId));
          }
        }
        
        // Build "Also on this day" summary
        const otherEventsToday = assignments.filter(x => x.event_date === eventDate && x.event_id !== eventId);
        let sameDaySummary = '';
        if (otherEventsToday.length > 0) {
          sameDaySummary = '<div class="text-xs text-muted mt-2 p-2 bg-white/5 rounded-lg"><strong>Also on ' + formatDateDisplay(eventDate) + ':</strong> ';
          sameDaySummary += otherEventsToday.map(e => {
            const crewNames = [e.foh_name, ...(e.stage_names || [])].filter(Boolean).join(', ');
            return e.event_name.substring(0, 25) + (crewNames ? ' (' + crewNames + ')' : '');
          }).join('; ');
          sameDaySummary += '</div>';
        }
        
        document.getElementById('modal-title').textContent = a.event_name.substring(0, 50);
        document.getElementById('modal-subtitle').innerHTML = a.venue + ' | ' + a.vertical + ' | <strong>' + formatDateDisplay(a.event_date) + '</strong>' + sameDaySummary;
        
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
        
        // FOH dropdown with conflict indicators
        let fohHtml = '<option value="">-- Select FOH --</option>';
        for (const c of crew) {
          if (c.level === 'Hired') continue;
          const selected = c.id === a.foh ? 'selected' : '';
          const badge = c.level === 'Senior' ? '⭐' : c.level === 'Mid' ? '●' : '○';
          
          const isDayOff = dayOffCrew.has(c.id);
          const isBusy = busyCrewOnDate[c.id];
          
          let optionClass = '';
          let suffix = '';
          if (isDayOff) {
            optionClass = 'color: #6b7280;'; // Grey
            suffix = ' [DAY OFF]';
          } else if (isBusy) {
            optionClass = 'color: #f87171;'; // Red
            suffix = ' [' + isBusy.join(', ') + ']';
          }
          
          fohHtml += '<option value=\"' + c.id + '\" ' + selected + ' style=\"' + optionClass + '\" data-busy=\"' + (isBusy ? isBusy.join(',') : '') + '\" data-dayoff=\"' + isDayOff + '\">' + badge + ' ' + c.name + suffix + '</option>';
        }
        document.getElementById('modal-foh').innerHTML = fohHtml;
        
        // Stage checkboxes with conflict indicators
        let stageHtml = '';
        for (const c of crew) {
          if (!c.can_stage) continue;
          const checked = a.stage?.includes(c.id) ? 'checked' : '';
          
          const isDayOff = dayOffCrew.has(c.id);
          const isBusy = busyCrewOnDate[c.id];
          
          let labelClass = '';
          let suffix = '';
          let checkboxStyle = '';
          
          if (isDayOff) {
            labelClass = 'opacity-50';
            suffix = ' <span class=\"text-gray-500 text-xs\">[DAY OFF]</span>';
            checkboxStyle = '';
          } else if (isBusy) {
            labelClass = '';
            suffix = ' <span class=\"text-red-400 text-xs\">[' + isBusy.join(', ') + ']</span>';
          }
          
          const levelColor = c.level === 'Senior' ? 'text-blue-400' : c.level === 'Mid' ? 'text-teal-400' : c.level === 'Junior' ? 'text-amber-400' : 'text-gray-400';
          
          stageHtml += '<label class=\"flex items-center gap-2 cursor-pointer p-2 hover:bg-white/5 rounded-lg ' + labelClass + '\">';
          stageHtml += '<input type=\"checkbox\" class=\"stage-checkbox\" value=\"' + c.id + '\" ' + checked + ' data-busy=\"' + (isBusy ? isBusy.join(',') : '') + '\" data-dayoff=\"' + isDayOff + '\" ' + checkboxStyle + '>';
          stageHtml += '<span class=\"' + levelColor + '\">' + (c.level === 'Senior' ? '●' : c.level === 'Mid' ? '●' : '○') + '</span><span class=\"ml-1\">' + c.name + '</span>' + suffix + '</label>';
        }
        document.getElementById('modal-stage').innerHTML = stageHtml;
        document.getElementById('edit-modal').dataset.eventId = eventId;
        document.getElementById('edit-modal').classList.remove('hidden');
        document.getElementById('edit-modal').classList.add('flex');
        
        // Setup Smart Swap detection on FOH change (remove old listener first to prevent duplicates)
        const fohSelect = document.getElementById('modal-foh');
        fohSelect.removeEventListener('change', handleFohChange);
        fohSelect.addEventListener('change', handleFohChange);
        document.getElementById('swap-panel').classList.add('hidden');
        
        // Store context for swap detection
        window.swapContext = {
          currentEventId: eventId,
          currentAssignment: a,
          busyCrewOnDate: busyCrewOnDate,
          eventDate: eventDate,
          originalFoh: a.foh
        };
      }
      
      function handleFohChange(e) {
        const newFohId = parseInt(e.target.value) || null;
        const ctx = window.swapContext;
        if (!ctx || !newFohId) {
          document.getElementById('swap-panel').classList.add('hidden');
          return;
        }
        
        // Check if new FOH is busy (assigned to another event on same day)
        const busyEvents = ctx.busyCrewOnDate[newFohId];
        if (!busyEvents || busyEvents.length === 0) {
          document.getElementById('swap-panel').classList.add('hidden');
          return;
        }
        
        // Find the event where this crew is currently assigned as FOH
        // Normalize dates for comparison (handle dd-mm-yyyy vs yyyy-mm-dd)
        const normalizeDate = (d) => {
          if (!d) return '';
          if (d.match(/^\\d{4}-\\d{2}-\\d{2}$/)) return d;
          if (d.match(/^\\d{2}-\\d{2}-\\d{4}$/)) {
            const [dd, mm, yyyy] = d.split('-');
            return yyyy + '-' + mm + '-' + dd;
          }
          return d;
        };
        const normalizedEventDate = normalizeDate(ctx.eventDate);
        
        const otherEvent = assignments.find(a => 
          normalizeDate(a.event_date) === normalizedEventDate && 
          a.event_id !== ctx.currentEventId &&
          a.foh === newFohId
        );
        
        if (!otherEvent) {
          // They're on stage duty, not a simple FOH swap
          document.getElementById('swap-panel').classList.add('hidden');
          return;
        }
        
        // We can offer a swap!
        const newFohName = crew.find(c => c.id === newFohId)?.name;
        const currentFohName = crew.find(c => c.id === ctx.originalFoh)?.name || 'None';
        const currentEventName = ctx.currentAssignment.event_name;
        const otherEventName = otherEvent.event_name;
        
        // Store swap details for execution
        window.pendingSwap = {
          event1Id: ctx.currentEventId,
          event1Name: currentEventName,
          event1OldFoh: ctx.originalFoh,
          event1NewFoh: newFohId,
          event2Id: otherEvent.event_id,
          event2Name: otherEventName,
          event2OldFoh: newFohId,
          event2NewFoh: ctx.originalFoh,
          newFohName: newFohName,
          currentFohName: currentFohName
        };
        
        // Show swap panel
        const swapPanel = document.getElementById('swap-panel');
        const swapDesc = document.getElementById('swap-description');
        const swapDetails = document.getElementById('swap-details');
        
        swapDesc.textContent = newFohName + ' is currently assigned to "' + otherEventName.substring(0, 30) + '". Swap them?';
        
        swapDetails.innerHTML = 
          '<div class="flex items-center gap-2"><span class="text-muted">•</span> <span>' + currentEventName.substring(0, 35) + ':</span> <span class="text-red-400">' + currentFohName + '</span> <i class="fas fa-arrow-right text-blue-400 mx-1"></i> <span class="text-green-400">' + newFohName + '</span></div>' +
          '<div class="flex items-center gap-2"><span class="text-muted">•</span> <span>' + otherEventName.substring(0, 35) + ':</span> <span class="text-red-400">' + newFohName + '</span> <i class="fas fa-arrow-right text-blue-400 mx-1"></i> <span class="text-green-400">' + currentFohName + '</span></div>';
        
        swapPanel.classList.remove('hidden');
      }
      
      async function executeSwap() {
        const swap = window.pendingSwap;
        if (!swap) return;
        
        // Get current stage assignments for both events (preserve them)
        const event1 = assignments.find(a => a.event_id === swap.event1Id);
        const event2 = assignments.find(a => a.event_id === swap.event2Id);
        
        const stage1 = event1?.stage || [];
        const stage2 = event2?.stage || [];
        
        // Update both assignments via API
        await fetch('/api/assignments/' + swap.event1Id, { 
          method: 'PUT', 
          headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify({ foh_id: swap.event1NewFoh, stage_ids: stage1 }) 
        });
        
        await fetch('/api/assignments/' + swap.event2Id, { 
          method: 'PUT', 
          headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify({ foh_id: swap.event2NewFoh, stage_ids: stage2 }) 
        });
        
        // Update local state
        if (event1) {
          event1.foh = swap.event1NewFoh;
          event1.foh_name = swap.newFohName;
          event1.foh_conflict = !swap.event1NewFoh;
        }
        if (event2) {
          event2.foh = swap.event2NewFoh;
          event2.foh_name = swap.currentFohName;
          event2.foh_conflict = !swap.event2NewFoh;
        }
        
        // Clear pending swap and close modal
        window.pendingSwap = null;
        window.swapContext = null;
        closeModal();
        renderAssignments();
      }
      
      async function saveModalChanges() {
        const eventId = parseInt(document.getElementById('edit-modal').dataset.eventId);
        const fohSelect = document.getElementById('modal-foh');
        const fohId = parseInt(fohSelect.value) || null;
        const stageCheckboxes = [...document.querySelectorAll('.stage-checkbox:checked')];
        const stageIds = stageCheckboxes.map(cb => parseInt(cb.value));
        
        // Check for conflicts and build warning message
        const warnings = [];
        
        if (fohId) {
          const fohOption = fohSelect.querySelector('option[value=\"' + fohId + '\"]');
          const fohBusy = fohOption?.dataset.busy;
          const fohDayOff = fohOption?.dataset.dayoff === 'true';
          const fohName = crew.find(c => c.id === fohId)?.name;
          
          if (fohDayOff) {
            warnings.push(fohName + ' has a DAY OFF on this date');
          } else if (fohBusy) {
            warnings.push(fohName + ' is already assigned to: ' + fohBusy);
          }
        }
        
        for (const cb of stageCheckboxes) {
          const crewId = parseInt(cb.value);
          const busy = cb.dataset.busy;
          const dayOff = cb.dataset.dayoff === 'true';
          const crewName = crew.find(c => c.id === crewId)?.name;
          
          if (dayOff) {
            warnings.push(crewName + ' has a DAY OFF on this date');
          } else if (busy) {
            warnings.push(crewName + ' is already assigned to: ' + busy);
          }
        }
        
        // Show confirmation if there are conflicts
        if (warnings.length > 0) {
          const confirmMsg = 'Warning - Potential conflicts:\\n\\n' + warnings.join('\\n') + '\\n\\nDo you want to proceed with this assignment?';
          if (!confirm(confirmMsg)) {
            return; // User cancelled
          }
        }
        
        await fetch('/api/assignments/' + eventId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ foh_id: fohId, stage_ids: stageIds }) });

        const a = assignments.find(x => x.event_id === eventId);
        const fohChanged = a ? a.foh !== fohId : true;
        const stageChanged = a ? JSON.stringify([...a.stage].sort()) !== JSON.stringify([...stageIds].sort()) : true;

        if (a) {
          a.foh = fohId;
          a.foh_name = crew.find(c => c.id === fohId)?.name || null;
          a.foh_conflict = !fohId;
          a.stage = stageIds;
          a.stage_names = stageIds.map(id => {
            const c = crew.find(x => x.id === id);
            return c?.name;
          }).filter(Boolean);
        }

        conflicts = conflicts.filter(c => !(c.event_id === eventId && fohId));

        // Propagate changes to multi-day group siblings
        const currentEventGroup = a?.event_group;
        let propagatedCount = 0;
        if (currentEventGroup && (fohChanged || stageChanged)) {
          const siblings = assignments.filter(x => x.event_id !== eventId && x.event_group === currentEventGroup);
          for (const sibling of siblings) {
            const siblingFohId = fohChanged ? fohId : sibling.foh;
            const siblingStageIds = stageChanged ? stageIds : sibling.stage;
            await fetch('/api/assignments/' + sibling.event_id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ foh_id: siblingFohId, stage_ids: siblingStageIds }) });
            if (fohChanged) {
              sibling.foh = fohId;
              sibling.foh_name = crew.find(c => c.id === fohId)?.name || null;
              sibling.foh_conflict = !fohId;
            }
            if (stageChanged) {
              sibling.stage = stageIds;
              sibling.stage_names = stageIds.map(id => crew.find(x => x.id === id)?.name).filter(Boolean);
            }
            conflicts = conflicts.filter(c => !(c.event_id === sibling.event_id && fohId));
            propagatedCount++;
          }
        }

        closeModal();
        renderAssignments();

        if (propagatedCount > 0) {
          const total = propagatedCount + 1;
          const msg = document.createElement('div');
          msg.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 bg-blue-600 text-white px-5 py-2 rounded-xl text-sm shadow-lg z-50';
          msg.textContent = 'Edit applied to all ' + total + ' dates of this event.';
          document.body.appendChild(msg);
          setTimeout(() => msg.remove(), 3000);
        }
      }
      
      function closeModal() {
        document.getElementById('edit-modal').classList.add('hidden');
        document.getElementById('edit-modal').classList.remove('flex');
      }
      
      async function showExportPreview() {
        // Show preview modal with all assignments
        let html = '<table class="w-full text-sm"><thead><tr class="text-muted border-b border-white/10"><th class="text-left py-2 px-2">Date</th><th class="text-left py-2 px-2">Program</th><th class="text-left py-2 px-2">Venue</th><th class="text-left py-2 px-2">Crew</th></tr></thead><tbody>';
        
        for (const a of assignments) {
          const crewDisplay = [];
          if (a.foh_name) crewDisplay.push(a.foh_name + ' (FOH)');
          if (a.stage_names?.length) crewDisplay.push(a.stage_names.join(', '));
          
          html += '<tr class="border-b border-white/5">';
          html += '<td class="py-2 px-2">' + formatDateDisplay(a.event_date) + '</td>';
          html += '<td class="py-2 px-2">' + a.event_name.substring(0, 40) + (a.event_name.length > 40 ? '...' : '') + '</td>';
          html += '<td class="py-2 px-2">' + a.venue + '</td>';
          html += '<td class="py-2 px-2">' + (crewDisplay.join(', ') || '<span class="text-red-400">Unassigned</span>') + '</td>';
          html += '</tr>';
        }
        html += '</tbody></table>';
        
        document.getElementById('export-preview-table').innerHTML = html;
        document.getElementById('export-preview-modal').classList.remove('hidden');
        document.getElementById('export-preview-modal').classList.add('flex');
      }
      
      function closePreviewModal() {
        document.getElementById('export-preview-modal').classList.add('hidden');
        document.getElementById('export-preview-modal').classList.remove('flex');
      }
      
      function downloadCSV() {
        closePreviewModal();
        window.location.href = '/api/export/csv?batch_id=' + batchId;
      }
      
      async function redoAssignments() {
        // Build locked assignments data
        const locked = [];
        for (const [eventId, locks] of Object.entries(lockedAssignments)) {
          const a = assignments.find(x => x.event_id === parseInt(eventId));
          if (!a) continue;
          if (locks.foh || locks.stage) {
            locked.push({
              event_id: parseInt(eventId),
              lock_foh: locks.foh || false,
              lock_stage: locks.stage || false,
              foh: locks.foh ? a.foh : null,
              stage: locks.stage ? a.stage : []
            });
          }
        }
        
        // Show progress
        document.getElementById('redo-assignments').disabled = true;
        document.getElementById('redo-assignments').innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Reshuffling...';
        
        try {
          const res = await fetch('/api/assignments/redo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              batch_id: batchId, 
              foh_preferences: fohPreferences,
              locked_assignments: locked
            })
          });
          const data = await res.json();
          assignments = data.assignments || [];
          conflicts = data.conflicts || [];
          
          // Sort by date then name
          assignments.sort((a, b) => {
            const dateCompare = a.event_date.localeCompare(b.event_date);
            return dateCompare !== 0 ? dateCompare : a.event_name.localeCompare(b.event_name);
          });
          
          renderAssignments();
        } catch (err) {
          alert('Failed to redo assignments: ' + err.message);
        } finally {
          document.getElementById('redo-assignments').disabled = false;
          document.getElementById('redo-assignments').innerHTML = '<i class="fas fa-redo mr-2"></i>Redo Unlocked';
        }
      }
      
      function exportCSV() { showExportPreview(); }
      function exportCalendar() { window.location.href = '/api/export/calendar?batch_id=' + batchId; }
      
      function goToStep(step) {
        for (let i = 1; i <= 5; i++) {
          document.getElementById('step' + i).classList.add('hidden');
          document.querySelector('.step-indicator[data-step="' + i + '"]').classList.remove('active', 'completed');
          if (i < step) document.querySelector('.step-indicator[data-step="' + i + '"]').classList.add('completed');
        }
        document.getElementById('step' + step).classList.remove('hidden');
        document.querySelector('.step-indicator[data-step="' + step + '"]').classList.add('active');
        currentStep = step;
        if (step === 3) { renderStageRequirements(); loadPersistentPrefsCount(); }
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
        document.getElementById('start-new').addEventListener('click', () => { uploadedEvents = []; batchId = null; assignments = []; conflicts = []; fohPreferences = []; document.getElementById('upload-preview').classList.add('hidden'); document.getElementById('step2-next').classList.add('hidden'); document.getElementById('csv-input').value = ''; goToStep(1); });
        
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
        document.getElementById('swap-btn').addEventListener('click', executeSwap);
        document.getElementById('edit-modal').addEventListener('click', (e) => { if (e.target.id === 'edit-modal') closeModal(); });
        
        document.getElementById('export-csv').addEventListener('click', exportCSV);
        document.getElementById('export-calendar').addEventListener('click', exportCalendar);
        
        // Workload panel toggle
        document.getElementById('workload-toggle').addEventListener('click', () => {
          const content = document.getElementById('workload-content');
          const chevron = document.getElementById('workload-chevron');
          content.classList.toggle('hidden');
          chevron.classList.toggle('fa-chevron-down');
          chevron.classList.toggle('fa-chevron-up');
        });
        
        // Redo button
        document.getElementById('redo-assignments').addEventListener('click', redoAssignments);
        
        // Export preview modal
        document.getElementById('preview-close').addEventListener('click', closePreviewModal);
        document.getElementById('preview-cancel').addEventListener('click', closePreviewModal);
        document.getElementById('preview-download').addEventListener('click', downloadCSV);
        document.getElementById('export-preview-modal').addEventListener('click', (e) => { if (e.target.id === 'export-preview-modal') closePreviewModal(); });
        
        // FOH Preferences event listeners
        document.getElementById('add-preference-btn').addEventListener('click', showPreferenceForm);
        document.getElementById('save-preference').addEventListener('click', savePreference);
        document.getElementById('cancel-preference').addEventListener('click', hidePreferenceForm);
        document.getElementById('pref-event').addEventListener('input', handleEventInput);
        document.getElementById('pref-event').addEventListener('focus', handleEventInput);
        
        // Hide suggestions when clicking outside
        document.addEventListener('click', (e) => {
          if (!e.target.closest('#pref-event') && !e.target.closest('#pref-event-suggestions')) {
            document.getElementById('pref-event-suggestions').classList.add('hidden');
          }
        });
      }
      
      init();

      // ============================================
      // ADMIN PANEL
      // ============================================

      let adminData = { config: [], preferences: [] };
      let historyPreviewData = null; // holds parsed rows for commit

      function openAdminPanel() {
        document.getElementById('admin-panel').classList.remove('hidden');
        document.getElementById('admin-panel').classList.add('flex');
        switchAdminTab('config');
      }

      function closeAdminPanel() {
        document.getElementById('admin-panel').classList.add('hidden');
        document.getElementById('admin-panel').classList.remove('flex');
      }

      // Close on backdrop click
      document.getElementById('admin-panel').addEventListener('click', function(e) {
        if (e.target === this) closeAdminPanel();
      });

      function switchAdminTab(tab) {
        document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
        document.querySelector('.admin-tab[data-tab="' + tab + '"]').classList.add('active');
        const content = document.getElementById('admin-content');
        if (tab === 'config') renderAdminConfig();
        else if (tab === 'history') renderAdminHistory();
        else if (tab === 'preferences') renderAdminPreferences();
      }

      // --- CONFIG TAB ---
      async function renderAdminConfig() {
        const content = document.getElementById('admin-content');
        content.innerHTML = '<p class="text-muted text-sm">Loading...</p>';
        const [cfgRes, crewRes] = await Promise.all([fetch('/api/config'), fetch('/api/crew')]);
        adminData.config = await cfgRes.json();
        const allCrew = await crewRes.json();

        // Build lookup map from DB rows
        const cfgMap = {};
        for (const r of adminData.config) cfgMap[r.key] = r.value;

        // ── How scoring works info box ──────────────────────────────────────
        let html = '<div class="space-y-4">';
        html += '<div class="glass-card-light p-4 border border-blue-400/20">';
        html += '<div class="flex items-start gap-3">';
        html += '<i class="fas fa-info-circle text-blue-400 mt-0.5 flex-shrink-0"></i>';
        html += '<div>';
        html += '<p class="text-sm font-medium text-blue-300 mb-1">How the assignment engine works</p>';
        html += '<p class="text-xs text-muted leading-relaxed">Every crew member is given a score for each event. The engine picks the person with the <strong class="text-white">highest score</strong>. Everyone starts equal, then points are <strong class="text-teal-400">added</strong> for seniority and <strong class="text-red-400">subtracted</strong> based on how many shows they already have this month. The settings below control how strongly each factor matters. The defaults work well — only change them if you notice a specific problem.</p>';
        html += '</div></div></div>';

        // ── Section 1: Workload Fairness ─────────────────────────────────────
        const fairnessParams = [
          {
            key: 'workload_weight_monthly',
            label: 'Monthly Fairness Weight',
            hint: 'points deducted per show already this month',
            guidance: 'Controls how hard the engine tries to spread shows evenly across the team each month. <strong>Higher = stronger push to avoid overloading anyone.</strong> Default 1000 works well. Try 1500–2000 if the same person keeps getting too many shows; try 500 if you want seniority to matter more than equal distribution.'
          },
          {
            key: 'workload_weight_seniority',
            label: 'Seniority Preference',
            hint: 'Senior gets 3×, Mid 2×, Junior 1× this value as a bonus',
            guidance: 'Gives more experienced crew a head-start in the scoring. At default 100: Senior starts +300 pts ahead of Junior. <strong>Set to 0 to ignore seniority and rely entirely on fair load distribution.</strong> Increase to give seniors an even stronger advantage.'
          },
          {
            key: 'workload_weight_historical',
            label: 'Past-Months Tiebreaker',
            hint: 'points deducted per show in the last few months (tiebreaker only)',
            guidance: 'A very small penalty based on how busy someone was in the last few months. Only matters when two crew members are otherwise completely equal in score. <strong>Safe to leave at 1.</strong>'
          },
          {
            key: 'workload_history_months',
            label: 'History Lookback (months)',
            hint: 'how many past months to include in the tiebreaker',
            guidance: 'How far back the tiebreaker looks. 3 months is standard. Increase to factor in a longer work history; set to 0 to ignore past months entirely.'
          }
        ];

        html += '<div>';
        html += '<h3 class="text-sm font-semibold text-blue-400 mb-1 flex items-center gap-2"><i class="fas fa-balance-scale text-xs"></i> Workload Fairness</h3>';
        html += '<p class="text-xs text-muted mb-3">These settings control how the engine balances work across the team.</p>';
        for (const p of fairnessParams) {
          const val = cfgMap[p.key] || '';
          html += '<div class="glass-card-light p-3 mb-2">';
          html += '<div class="flex justify-between items-start gap-3">';
          html += '<div class="flex-1 min-w-0">';
          html += '<div class="text-sm font-semibold mb-0.5">' + p.label + '</div>';
          html += '<div class="text-xs text-muted mb-1 italic">' + p.hint + '</div>';
          html += '<div class="text-xs text-gray-300 leading-relaxed mb-2">' + p.guidance + '</div>';
          html += '<div class="flex items-center gap-2">';
          html += '<input class="admin-input" type="number" min="0" id="cfg-' + p.key + '" value="' + escapeHtml(val) + '" style="width:100px">';
          html += '<span class="text-xs text-muted">(current: <strong>' + escapeHtml(val) + '</strong>)</span>';
          html += '</div></div>';
          html += '<button onclick="saveConfig(&apos;' + p.key + '&apos;,false)" class="btn-secondary px-3 py-1.5 rounded-lg text-xs whitespace-nowrap">Save</button>';
          html += '</div></div>';
        }
        html += '</div>';

        // ── Section 2: Assignment Rules ──────────────────────────────────────
        const ruleParams = [
          {
            key: 'score_base',
            label: 'Starting Score',
            hint: 'every crew member begins with this score before any adjustments',
            guidance: 'The baseline all scores are calculated from. No reason to change this unless advised.'
          },
          {
            key: 'score_stage_nonurgent_bonus',
            label: 'Flexible Crew Bonus',
            hint: 'bonus for crew who are happy to do any stage show',
            guidance: 'Stage crew who are <strong>not</strong> marked "stage only if urgent" receive this bonus. Increase to more strongly prefer flexible crew for stage roles.'
          },
          {
            key: 'score_oc_penalty',
            label: 'Hired Crew Last-Resort Penalty',
            hint: 'points deducted for outside / hired crew on stage',
            guidance: 'Outside or hired crew lose this many points when considered for stage assignments, so they are used only when no permanent crew is available. <strong>Increase to use hired crew even less; decrease if you want them used more freely.</strong>'
          },
          {
            key: 'score_preferred_foh_penalty',
            label: 'FOH Double-Booking Prevention',
            hint: 'penalty applied when a preferred-FOH crew member is considered for stage on the same day',
            guidance: 'When someone is the designated FOH for an event, they are penalised heavily if the engine tries to also put them on stage that same day. Increase for stricter protection; decrease if you are OK with potential double-booking.'
          }
        ];

        html += '<div>';
        html += '<h3 class="text-sm font-semibold text-blue-400 mb-1 flex items-center gap-2"><i class="fas fa-sliders-h text-xs"></i> Assignment Rules</h3>';
        html += '<p class="text-xs text-muted mb-3">Fine-tune how the engine handles special situations.</p>';
        for (const p of ruleParams) {
          const val = cfgMap[p.key] || '';
          html += '<div class="glass-card-light p-3 mb-2">';
          html += '<div class="flex justify-between items-start gap-3">';
          html += '<div class="flex-1 min-w-0">';
          html += '<div class="text-sm font-semibold mb-0.5">' + p.label + '</div>';
          html += '<div class="text-xs text-muted mb-1 italic">' + p.hint + '</div>';
          html += '<div class="text-xs text-gray-300 leading-relaxed mb-2">' + p.guidance + '</div>';
          html += '<div class="flex items-center gap-2">';
          html += '<input class="admin-input" type="number" min="0" id="cfg-' + p.key + '" value="' + escapeHtml(val) + '" style="width:100px">';
          html += '<span class="text-xs text-muted">(current: <strong>' + escapeHtml(val) + '</strong>)</span>';
          html += '</div></div>';
          html += '<button onclick="saveConfig(&apos;' + p.key + '&apos;,false)" class="btn-secondary px-3 py-1.5 rounded-lg text-xs whitespace-nowrap">Save</button>';
          html += '</div></div>';
        }
        html += '</div>';

        // ── Section 3: Venue Defaults (visual table) ─────────────────────────
        const CANONICAL_VENUES = ['JBT', 'Tata', 'Experimental', 'Godrej Dance', 'Little Theatre', 'Others'];
        let vdObj = {};
        try { vdObj = JSON.parse(cfgMap['venue_defaults'] || '{}'); } catch {}

        html += '<div>';
        html += '<h3 class="text-sm font-semibold text-blue-400 mb-1 flex items-center gap-2"><i class="fas fa-theater-masks text-xs"></i> Default Crew Required per Venue</h3>';
        html += '<p class="text-xs text-muted mb-1">How many people (FOH + stage combined) does each venue typically need?</p>';
        html += '<p class="text-xs text-muted mb-3">This is the default — you can override it per event in Step 3 when uploading shows.</p>';
        html += '<div class="glass-card-light p-3">';
        html += '<table class="w-full text-sm"><thead><tr>';
        html += '<th class="text-left py-1.5 text-muted font-normal text-xs">Venue</th>';
        html += '<th class="text-left py-1.5 text-muted font-normal text-xs">Total crew needed</th>';
        html += '</tr></thead><tbody>';
        for (const v of CANONICAL_VENUES) {
          const vId = v.replace(/ /g, '_');
          const cur = vdObj[v] != null ? vdObj[v] : 1;
          html += '<tr class="border-t border-white/5">';
          html += '<td class="py-2 pr-4 font-medium">' + v + '</td>';
          html += '<td class="py-1.5"><div class="flex items-center gap-2">';
          html += '<input type="number" min="1" max="10" class="admin-input" style="width:70px" id="vd-' + vId + '" value="' + cur + '">';
          html += '<span class="text-xs text-muted">people</span>';
          html += '</div></td>';
          html += '</tr>';
        }
        html += '</tbody></table>';
        html += '<div class="mt-3 pt-3 border-t border-white/10">';
        html += '<button onclick="saveVenueDefaults()" class="btn-primary px-4 py-2 rounded-lg text-sm"><i class="fas fa-save mr-2"></i>Save Crew Counts</button>';
        html += '</div></div></div>';

        // ── Section 4: Venue Aliases (editable table) ────────────────────────
        let vmObj = {};
        try { vmObj = JSON.parse(cfgMap['venue_map'] || '{}'); } catch {}
        const vmEntries = Object.entries(vmObj);

        const canonOpts = CANONICAL_VENUES.map(v => '<option value="' + v + '">' + v + '</option>').join('');

        html += '<div>';
        html += '<h3 class="text-sm font-semibold text-blue-400 mb-1 flex items-center gap-2"><i class="fas fa-map text-xs"></i> Venue Name Aliases</h3>';
        html += '<p class="text-xs text-muted mb-1">When your CSV file uses a shorthand or abbreviation for a venue, tell the system what it really means.</p>';
        html += '<p class="text-xs text-muted mb-3">Example: your CSV says <strong class="text-white">TT</strong> but the system should treat it as <strong class="text-white">Tata</strong>.</p>';
        html += '<div class="glass-card-light p-3">';
        html += '<table class="w-full text-sm" id="venue-map-table"><thead><tr>';
        html += '<th class="text-left py-1.5 text-muted font-normal text-xs">When your CSV contains...</th>';
        html += '<th class="text-left py-1.5 text-muted font-normal text-xs w-40">Treat as venue:</th>';
        html += '<th class="w-8"></th>';
        html += '</tr></thead>';
        html += '<tbody id="venue-map-tbody">';
        for (const [alias, canon] of vmEntries) {
          html += '<tr class="border-t border-white/5">';
          html += '<td class="py-1 pr-2"><input class="admin-input vm-alias" value="' + escapeHtml(alias) + '" placeholder="e.g. My Venue Name"></td>';
          html += '<td class="py-1 pr-2"><select class="admin-input vm-canon">' + canonOpts + '</select></td>';
          html += '<td class="py-1"><button onclick="this.closest(&apos;tr&apos;).remove()" class="text-red-400 hover:text-red-300 text-xs px-1" title="Remove">✕</button></td>';
          html += '</tr>';
        }
        html += '</tbody></table>';
        html += '<div class="mt-3 pt-3 border-t border-white/10 flex gap-2 flex-wrap">';
        html += '<button onclick="addVenueMapRow()" class="btn-secondary px-3 py-1.5 rounded-lg text-xs"><i class="fas fa-plus mr-1"></i>Add Alias</button>';
        html += '<button onclick="saveVenueMap()" class="btn-primary px-4 py-1.5 rounded-lg text-xs"><i class="fas fa-save mr-1"></i>Save All Aliases</button>';
        html += '</div></div></div>';

        // Need to set selected values after innerHTML is set, so store them
        // We'll do it via a script approach: encode the vm data in data attributes
        // Actually, the select values need to be set post-render. We'll do it in a follow-up step.
        // Store canon values in data-canon attribute and set after render.

        // ── Section 5: Team → Vertical Map ──────────────────────────────────
        let tvObj = {};
        try { tvObj = JSON.parse(cfgMap['team_vertical_map'] || '{}'); } catch {}
        const tvEntries = Object.entries(tvObj);

        const VERTICALS = ['Dance', 'Indian Music', 'Intl Music', 'Theatre', 'Library', 'Western Music', 'Corporate', 'Others'];
        const vertOpts = VERTICALS.map(v => '<option value="' + v + '">' + v + '</option>').join('');

        html += '<div>';
        html += '<h3 class="text-sm font-semibold text-blue-400 mb-1 flex items-center gap-2"><i class="fas fa-sitemap text-xs"></i> Team → Vertical Mapping</h3>';
        html += '<p class="text-xs text-muted mb-1">Maps the <strong class="text-white">Team</strong> column in your CSV to the correct programme type (vertical).</p>';
        html += '<p class="text-xs text-muted mb-3">The vertical determines which crew are eligible to work a show (based on their capability matrix). If a team name is missing here, it will be treated as "Others".</p>';
        html += '<div class="glass-card-light p-3">';
        html += '<table class="w-full text-sm" id="team-map-table"><thead><tr>';
        html += '<th class="text-left py-1.5 text-muted font-normal text-xs">When CSV &quot;Team&quot; column contains...</th>';
        html += '<th class="text-left py-1.5 text-muted font-normal text-xs w-44">Vertical is:</th>';
        html += '<th class="w-8"></th>';
        html += '</tr></thead>';
        html += '<tbody id="team-map-tbody">';
        for (const [team, vert] of tvEntries) {
          html += '<tr class="border-t border-white/5">';
          html += '<td class="py-1 pr-2"><input class="admin-input tv-team" value="' + escapeHtml(team) + '" placeholder="e.g. Dr.Swapno/Team"></td>';
          html += '<td class="py-1 pr-2"><select class="admin-input tv-vert">' + vertOpts + '</select></td>';
          html += '<td class="py-1"><button onclick="this.closest(&apos;tr&apos;).remove()" class="text-red-400 hover:text-red-300 text-xs px-1" title="Remove">✕</button></td>';
          html += '</tr>';
        }
        html += '</tbody></table>';
        html += '<div class="mt-3 pt-3 border-t border-white/10 flex gap-2 flex-wrap">';
        html += '<button onclick="addTeamMapRow()" class="btn-secondary px-3 py-1.5 rounded-lg text-xs"><i class="fas fa-plus mr-1"></i>Add Mapping</button>';
        html += '<button onclick="saveTeamMap()" class="btn-primary px-4 py-1.5 rounded-lg text-xs"><i class="fas fa-save mr-1"></i>Save All Mappings</button>';
        html += '</div></div></div>';

        // ── Section 6: Per-crew monthly caps ─────────────────────────────────
        const internalCrew = allCrew.filter(c => c.level !== 'Hired');
        html += '<div>';
        html += '<h3 class="text-sm font-semibold text-blue-400 mb-1 flex items-center gap-2"><i class="fas fa-user-clock text-xs"></i> Monthly Assignment Caps</h3>';
        html += '<p class="text-xs text-muted mb-3">Limit how many shows a crew member can be assigned in a single month. Leave blank for no limit.</p>';
        html += '<div class="glass-card-light p-3"><div class="grid grid-cols-2 gap-2">';
        for (const c of internalCrew) {
          html += '<div class="flex items-center gap-2">';
          html += '<span class="text-sm flex-1">' + escapeHtml(c.name) + ' <span class="text-muted text-xs">(' + c.level + ')</span></span>';
          const capVal = c.monthly_assignment_cap != null ? c.monthly_assignment_cap : '';
          html += '<input type="number" class="admin-input" style="width:70px" id="cap-' + c.id + '" value="' + capVal + '" placeholder="∞">';
          html += '<button onclick="saveCap(' + c.id + ')" class="btn-secondary px-2 py-1 rounded text-xs">Save</button>';
          html += '</div>';
        }
        html += '</div></div></div>';

        html += '</div>';
        content.innerHTML = html;

        // Set select values post-render (innerHTML doesn't preserve .value)
        document.querySelectorAll('#venue-map-tbody tr').forEach((tr, i) => {
          if (vmEntries[i]) tr.querySelector('.vm-canon').value = vmEntries[i][1];
        });
        document.querySelectorAll('#team-map-tbody tr').forEach((tr, i) => {
          if (tvEntries[i]) tr.querySelector('.tv-vert').value = tvEntries[i][1];
        });
      }

      async function saveConfig(key, isJson) {
        const el = document.getElementById('cfg-' + key);
        let value = el.value;
        if (isJson) {
          try { JSON.parse(value); } catch { showToast('Invalid JSON for ' + key, 'error'); return; }
        }
        const res = await fetch('/api/config/' + key, {
          method: 'PUT', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ value })
        });
        const data = await res.json();
        if (data.success) showToast('Saved', 'success');
        else showToast(data.error || 'Save failed', 'error');
      }

      async function saveVenueDefaults() {
        const venues = ['JBT', 'Tata', 'Experimental', 'Godrej Dance', 'Little Theatre', 'Others'];
        const obj = {};
        for (const v of venues) {
          const el = document.getElementById('vd-' + v.replace(/ /g, '_'));
          obj[v] = parseInt(el ? el.value : '1') || 1;
        }
        const res = await fetch('/api/config/venue_defaults', {
          method: 'PUT', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ value: JSON.stringify(obj) })
        });
        const data = await res.json();
        showToast(data.success ? 'Crew counts saved' : (data.error || 'Failed'), data.success ? 'success' : 'error');
      }

      async function saveVenueMap() {
        const rows = document.querySelectorAll('#venue-map-tbody tr');
        const obj = {};
        rows.forEach(tr => {
          const alias = tr.querySelector('.vm-alias').value.trim();
          const canon = tr.querySelector('.vm-canon').value;
          if (alias) obj[alias] = canon;
        });
        const res = await fetch('/api/config/venue_map', {
          method: 'PUT', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ value: JSON.stringify(obj) })
        });
        const data = await res.json();
        showToast(data.success ? 'Venue aliases saved' : (data.error || 'Failed'), data.success ? 'success' : 'error');
      }

      function addVenueMapRow() {
        const tbody = document.getElementById('venue-map-tbody');
        const venues = ['JBT', 'Tata', 'Experimental', 'Godrej Dance', 'Little Theatre', 'Others'];
        const opts = venues.map(v => '<option value="' + v + '">' + v + '</option>').join('');
        const tr = document.createElement('tr');
        tr.className = 'border-t border-white/5';
        tr.innerHTML = '<td class="py-1 pr-2"><input class="admin-input vm-alias" placeholder="Type what your CSV says..."></td>' +
          '<td class="py-1 pr-2"><select class="admin-input vm-canon">' + opts + '</select></td>' +
          '<td class="py-1"><button onclick="this.closest(&apos;tr&apos;).remove()" class="text-red-400 hover:text-red-300 text-xs px-1">✕</button></td>';
        tbody.appendChild(tr);
        tr.querySelector('.vm-alias').focus();
      }

      async function saveTeamMap() {
        const rows = document.querySelectorAll('#team-map-tbody tr');
        const obj = {};
        rows.forEach(tr => {
          const team = tr.querySelector('.tv-team').value.trim();
          const vert = tr.querySelector('.tv-vert').value;
          if (team !== undefined) obj[team] = vert; // allow empty string key
        });
        const res = await fetch('/api/config/team_vertical_map', {
          method: 'PUT', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ value: JSON.stringify(obj) })
        });
        const data = await res.json();
        showToast(data.success ? 'Team mappings saved' : (data.error || 'Failed'), data.success ? 'success' : 'error');
      }

      function addTeamMapRow() {
        const tbody = document.getElementById('team-map-tbody');
        const verts = ['Dance', 'Indian Music', 'Intl Music', 'Theatre', 'Library', 'Western Music', 'Corporate', 'Others'];
        const opts = verts.map(v => '<option value="' + v + '">' + v + '</option>').join('');
        const tr = document.createElement('tr');
        tr.className = 'border-t border-white/5';
        tr.innerHTML = '<td class="py-1 pr-2"><input class="admin-input tv-team" placeholder="e.g. Dr.Swapno/Team"></td>' +
          '<td class="py-1 pr-2"><select class="admin-input tv-vert">' + opts + '</select></td>' +
          '<td class="py-1"><button onclick="this.closest(&apos;tr&apos;).remove()" class="text-red-400 hover:text-red-300 text-xs px-1">✕</button></td>';
        tbody.appendChild(tr);
        tr.querySelector('.tv-team').focus();
      }

      async function saveCap(crewId) {
        const el = document.getElementById('cap-' + crewId);
        const capVal = el.value === '' ? null : parseInt(el.value);
        const res = await fetch('/api/crew/' + crewId + '/cap', {
          method: 'PUT', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ cap: capVal })
        });
        const data = await res.json();
        if (data.success) showToast('Cap saved', 'success');
        else showToast(data.error || 'Failed', 'error');
      }

      // --- HISTORY IMPORT TAB ---
      function renderAdminHistory() {
        const content = document.getElementById('admin-content');
        let html = '<div class="space-y-4">';
        html += '<div><h3 class="text-sm font-semibold text-blue-400 mb-1">Import Historical Assignments</h3>';
        html += '<p class="text-xs text-muted mb-3">Upload past assignment CSVs (Date, Program, Venue, Team, Sound Requirements, Call Time, Crew) to seed the workload history. The Crew column should list crew names separated by commas.</p></div>';
        html += '<div class="upload-zone p-6 text-center cursor-pointer" onclick="document.getElementById(&apos;hist-csv-input&apos;).click()">';
        html += '<i class="fas fa-file-csv text-blue-400 text-2xl mb-2"></i>';
        html += '<p class="text-sm text-muted">Click to select CSV file or drag &amp; drop</p>';
        html += '<input type="file" id="hist-csv-input" accept=".csv" class="hidden" onchange="previewHistoryCSV(event)"></div>';
        html += '<div id="hist-preview" class="hidden"></div>';
        html += '<div id="hist-patterns" class="hidden"></div>';
        html += '<div id="hist-summary" class="glass-card-light p-4 hidden">';
        html += '<h4 class="text-sm font-semibold mb-2">Current Workload History</h4>';
        html += '<div id="hist-summary-content"></div></div>';
        html += '<button onclick="loadHistorySummary()" class="btn-secondary px-4 py-2 rounded-lg text-sm">';
        html += '<i class="fas fa-chart-bar mr-2"></i>View Current Workload Summary</button>';
        html += '</div>';
        content.innerHTML = html;
        setupHistDrop();
      }

      function setupHistDrop() {
        const zone = document.querySelector('#admin-content .upload-zone');
        if (!zone) return;
        zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
        zone.addEventListener('drop', e => {
          e.preventDefault(); zone.classList.remove('dragover');
          const file = e.dataTransfer.files[0];
          if (file) processHistFile(file);
        });
      }

      function previewHistoryCSV(e) {
        const file = e.target.files[0];
        if (file) processHistFile(file);
      }

      async function processHistFile(file) {
        const text = await file.text();
        const previewDiv = document.getElementById('hist-preview');
        previewDiv.innerHTML = '<p class="text-muted text-sm">Parsing...</p>';
        previewDiv.classList.remove('hidden');

        const res = await fetch('/api/history/import/preview', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ csv_text: text })
        });
        const data = await res.json();
        historyPreviewData = data;

        let html = '<div class="glass-card-light p-4">';
        html += '<div class="flex justify-between items-center mb-3">';
        html += '<h4 class="text-sm font-semibold">Preview (' + data.matched_rows + '/' + data.total_csv_rows + ' rows matched)</h4>';
        if (data.unmatched && data.unmatched.length > 0) {
          html += '<span class="text-xs text-yellow-400"><i class="fas fa-exclamation-triangle mr-1"></i>' + data.unmatched.length + ' unmatched names</span>';
        }
        html += '</div>';

        if (data.unmatched && data.unmatched.length > 0) {
          html += '<div class="mb-3 p-2 rounded-lg bg-yellow-400/10 border border-yellow-400/20">';
          html += '<p class="text-xs text-yellow-400 font-medium mb-1">Unmatched crew names (will be skipped):</p>';
          html += '<p class="text-xs text-muted">' + data.unmatched.map(escapeHtml).join(', ') + '</p>';
          html += '</div>';
        }

        html += '<div class="overflow-x-auto" style="max-height:300px;overflow-y:auto">';
        html += '<table class="w-full text-xs"><thead><tr class="border-b border-white/10">';
        html += '<th class="text-left py-2 text-muted">Date</th><th class="text-left py-2 text-muted">Event</th>';
        html += '<th class="text-left py-2 text-muted">Crew (set FOH)</th></tr></thead><tbody>';

        for (let i = 0; i < data.parsed_rows.length; i++) {
          const row = data.parsed_rows[i];
          html += '<tr class="border-t border-white/5">';
          html += '<td class="py-1.5 pr-3 whitespace-nowrap">' + row.date + '</td>';
          html += '<td class="py-1.5 pr-3 max-w-xs truncate" title="' + escapeHtml(row.event_name) + '">' + escapeHtml(row.event_name.substring(0,40)) + '</td>';
          html += '<td class="py-1.5"><div class="flex flex-wrap gap-1">';
          for (let j = 0; j < row.matched.length; j++) {
            const m = row.matched[j];
            const isFoh = m.role_guess === 'FOH';
            html += '<button onclick="toggleHistFoh(' + i + ',' + j + ')" id="hcrew-' + i + '-' + j + '" class="px-2 py-0.5 rounded text-xs border ' +
              (isFoh ? 'border-blue-400 text-blue-400 bg-blue-400/15' : 'border-white/20 text-muted') + '">' +
              escapeHtml(m.name) + (isFoh ? ' (FOH)' : '') + '</button>';
          }
          html += '</div></td></tr>';
        }
        html += '</tbody></table></div>';

        html += '<div class="flex items-center gap-4 mt-4">';
        html += '<div class="flex items-center gap-2">';
        html += '<span class="text-xs text-muted">Import mode:</span>';
        html += '<select id="hist-mode" class="admin-input text-xs" style="width:auto">';
        html += '<option value="replace">Replace (overwrite existing months)</option>';
        html += '<option value="add">Add to existing</option>';
        html += '</select></div>';
        html += '<button onclick="commitHistoryImport()" class="btn-primary px-4 py-2 rounded-lg text-sm">Confirm Import</button>';
        html += '<button onclick="document.getElementById(&apos;hist-preview&apos;).classList.add(&apos;hidden&apos;)" class="btn-secondary px-3 py-2 rounded-lg text-xs">Cancel</button>';
        html += '</div></div>';

        previewDiv.innerHTML = html;
      }

      function toggleHistFoh(rowIdx, crewIdx) {
        if (!historyPreviewData) return;
        const row = historyPreviewData.parsed_rows[rowIdx];
        // Toggle: if clicked crew is FOH, make them Stage and find first non-FOH to promote
        for (let j = 0; j < row.matched.length; j++) {
          if (j === crewIdx) row.matched[j].role_guess = 'FOH';
          else if (row.matched[j].role_guess === 'FOH') row.matched[j].role_guess = 'Stage';
        }
        // Re-render just the buttons
        for (let j = 0; j < row.matched.length; j++) {
          const el = document.getElementById('hcrew-' + rowIdx + '-' + j);
          if (!el) continue;
          const isFoh = row.matched[j].role_guess === 'FOH';
          el.className = 'px-2 py-0.5 rounded text-xs border ' + (isFoh ? 'border-blue-400 text-blue-400 bg-blue-400/15' : 'border-white/20 text-muted');
          el.textContent = row.matched[j].name + (isFoh ? ' (FOH)' : '');
        }
      }

      async function commitHistoryImport() {
        if (!historyPreviewData) return;
        const mode = document.getElementById('hist-mode').value;
        // Build flat assignments list with crew_id, month, role, vertical, venue_normalized
        const assignments = [];
        for (const row of historyPreviewData.parsed_rows) {
          const month = row.date.substring(0, 7); // yyyy-mm
          for (const m of row.matched) {
            assignments.push({
              crew_id: m.crew_id,
              month,
              role: m.role_guess,
              vertical: row.vertical,
              venue_normalized: row.venue_normalized
            });
          }
        }
        const res = await fetch('/api/history/import/commit', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ assignments, mode })
        });
        const data = await res.json();
        if (data.success) {
          showToast('Imported ' + data.imported_assignments + ' assignments for ' + data.unique_crew_months + ' crew-months', 'success');
          document.getElementById('hist-preview').classList.add('hidden');
          // Run pattern analysis
          runPatternAnalysis(assignments);
          loadHistorySummary();
        } else {
          showToast('Import failed', 'error');
        }
      }

      async function runPatternAnalysis(assignments) {
        const res = await fetch('/api/history/patterns', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ assignments })
        });
        const patterns = await res.json();
        const div = document.getElementById('hist-patterns');
        if (!patterns.length) { div.classList.add('hidden'); return; }

        let html = '<div class="glass-card-light p-4">';
        html += '<h4 class="text-sm font-semibold mb-1">Assignment Patterns Detected</h4>';
        html += '<p class="text-xs text-muted mb-3">Crew who were consistently assigned as FOH for specific Vertical / Venue combinations. Click "Add as Preference" to make these persistent.</p>';
        html += '<div class="overflow-x-auto"><table class="w-full text-xs"><thead><tr class="border-b border-white/10">';
        html += '<th class="text-left py-2 text-muted">Crew</th><th class="text-left py-2 text-muted">Vertical</th><th class="text-left py-2 text-muted">Venue</th>';
        html += '<th class="text-right py-2 text-muted">FOH Count</th><th class="text-right py-2 text-muted">%</th><th class="py-2"></th></tr></thead><tbody>';
        for (const p of patterns) {
          const highlight = p.pct >= 50 ? 'text-green-400' : 'text-muted';
          html += '<tr class="border-t border-white/5">';
          html += '<td class="py-1.5 font-medium">' + escapeHtml(p.crew_name) + '</td>';
          html += '<td class="py-1.5">' + escapeHtml(p.vertical) + '</td>';
          html += '<td class="py-1.5">' + escapeHtml(p.venue) + '</td>';
          html += '<td class="py-1.5 text-right">' + p.foh_count + '/' + p.total_events + '</td>';
          html += '<td class="py-1.5 text-right ' + highlight + ' font-medium">' + p.pct + '%</td>';
          if (p.pct >= 50) {
            html += '<td class="py-1.5 pl-2"><button onclick="addPatternAsPreference(' + p.crew_id + ',&apos;' +
              escapeHtml(p.vertical) + '&apos;,&apos;' + escapeHtml(p.venue) + '&apos;,&apos;' + escapeHtml(p.crew_name) + '&apos;)" ' +
              'class="btn-secondary px-2 py-0.5 rounded text-xs">+ Add Preference</button></td>';
          } else {
            html += '<td></td>';
          }
          html += '</tr>';
        }
        html += '</tbody></table></div></div>';
        div.innerHTML = html;
        div.classList.remove('hidden');
      }

      async function addPatternAsPreference(crewId, vertical, venue, crewName) {
        // Create a preference with venue_filter for this pattern
        // Use vertical as event_name_contains with match_mode contains to catch all events of that vertical
        const res = await fetch('/api/preferences', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            event_name_contains: vertical,
            crew_id: crewId,
            venue_filter: venue,
            match_mode: 'contains'
          })
        });
        const data = await res.json();
        if (data.success) showToast('Preference added: ' + crewName + ' for ' + vertical + ' @ ' + venue, 'success');
        else showToast(data.error || 'Failed', 'error');
      }

      async function loadHistorySummary() {
        const res = await fetch('/api/history/summary');
        const rows = await res.json();
        const div = document.getElementById('hist-summary');
        const contentDiv = document.getElementById('hist-summary-content');
        if (!rows.length) { div.classList.add('hidden'); return; }
        let html = '<table class="w-full text-xs"><thead><tr class="border-b border-white/10">';
        html += '<th class="text-left py-1 text-muted">Crew</th><th class="text-left py-1 text-muted">Level</th><th class="text-right py-1 text-muted">Total Assignments</th></tr></thead><tbody>';
        for (const r of rows) {
          html += '<tr class="border-t border-white/5"><td class="py-1">' + escapeHtml(r.name) + '</td><td class="py-1 text-muted">' + r.level + '</td><td class="py-1 text-right">' + r.total + '</td></tr>';
        }
        html += '</tbody></table>';
        contentDiv.innerHTML = html;
        div.classList.remove('hidden');
      }

      // --- PREFERENCES TAB ---
      async function renderAdminPreferences() {
        const content = document.getElementById('admin-content');
        content.innerHTML = '<p class="text-muted text-sm">Loading...</p>';
        const [prefsRes, crewRes] = await Promise.all([fetch('/api/preferences'), fetch('/api/crew')]);
        adminData.preferences = await prefsRes.json();
        const allCrew = await crewRes.json();
        const internalCrew = allCrew.filter(c => c.level !== 'Hired');
        const venues = ['', 'JBT', 'Tata', 'Experimental', 'Godrej Dance', 'Little Theatre', 'Others'];

        let html = '<div class="space-y-4">';
        html += '<div class="flex justify-between items-center">';
        html += '<div><h3 class="text-sm font-semibold text-blue-400">Persistent FOH Preferences</h3>';
        html += '<p class="text-xs text-muted mt-0.5">These preferences apply across all batches. The engine always checks these first.</p></div>';
        html += '<button onclick="showAddPrefForm()" class="btn-secondary px-3 py-1.5 rounded-lg text-xs"><i class="fas fa-plus mr-1"></i>Add Preference</button>';
        html += '</div>';

        // Add form (hidden by default)
        html += '<div id="add-pref-form" class="glass-card-light p-4 hidden">';
        html += '<h4 class="text-sm font-semibold mb-3">New Persistent Preference</h4>';
        html += '<div class="grid grid-cols-2 gap-3">';
        html += '<div><label class="text-xs text-muted block mb-1">Event Name Pattern</label>';
        html += '<input class="admin-input" id="new-pref-event" placeholder="e.g. Jazz Night"></div>';
        html += '<div><label class="text-xs text-muted block mb-1">FOH Crew</label>';
        html += '<select class="admin-input" id="new-pref-crew"><option value="">Select...</option>';
        for (const c of internalCrew) html += '<option value="' + c.id + '">' + escapeHtml(c.name) + '</option>';
        html += '</select></div>';
        html += '<div><label class="text-xs text-muted block mb-1">Match Mode</label>';
        html += '<select class="admin-input" id="new-pref-mode"><option value="contains">Contains</option><option value="exact">Exact</option></select></div>';
        html += '<div><label class="text-xs text-muted block mb-1">Venue Filter (optional)</label>';
        html += '<select class="admin-input" id="new-pref-venue"><option value="">Any venue</option>';
        for (const v of venues.slice(1)) html += '<option value="' + v + '">' + v + '</option>';
        html += '</select></div>';
        html += '</div>';
        html += '<div class="flex gap-2 mt-3">';
        html += '<button onclick="savePersistentPref()" class="btn-primary px-4 py-2 rounded-lg text-sm">Save</button>';
        html += '<button onclick="document.getElementById(&apos;add-pref-form&apos;).classList.add(&apos;hidden&apos;)" class="btn-secondary px-3 py-2 rounded-lg text-sm">Cancel</button>';
        html += '</div></div>';

        // Preferences table
        if (adminData.preferences.length === 0) {
          html += '<p class="text-muted text-sm py-4 text-center">No persistent preferences yet. Add one above or import from history.</p>';
        } else {
          html += '<div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr class="border-b border-white/10">';
          html += '<th class="text-left py-2 text-muted font-normal">Event Pattern</th>';
          html += '<th class="text-left py-2 text-muted font-normal">Crew</th>';
          html += '<th class="text-left py-2 text-muted font-normal">Mode</th>';
          html += '<th class="text-left py-2 text-muted font-normal">Venue</th>';
          html += '<th class="text-center py-2 text-muted font-normal">Active</th>';
          html += '<th class="py-2"></th></tr></thead><tbody>';
          for (const p of adminData.preferences) {
            html += '<tr class="border-t border-white/5">';
            html += '<td class="py-2"><span class="text-blue-400">' + escapeHtml(p.event_name_contains) + '</span></td>';
            html += '<td class="py-2 font-medium">' + escapeHtml(p.crew_name) + '</td>';
            html += '<td class="py-2"><span class="pref-badge">' + p.match_mode + '</span></td>';
            html += '<td class="py-2 text-muted">' + (p.venue_filter || 'Any') + '</td>';
            html += '<td class="py-2 text-center"><input type="checkbox" ' + (p.is_active ? 'checked' : '') +
              ' onchange="togglePrefActive(' + p.id + ',this.checked)" class="cursor-pointer"></td>';
            html += '<td class="py-2"><button onclick="deletePref(' + p.id + ')" class="text-red-400 hover:text-red-300 text-xs"><i class="fas fa-trash-alt"></i></button></td>';
            html += '</tr>';
          }
          html += '</tbody></table></div>';
        }
        html += '</div>';
        content.innerHTML = html;
      }

      function showAddPrefForm() {
        document.getElementById('add-pref-form').classList.remove('hidden');
        document.getElementById('new-pref-event').focus();
      }

      async function savePersistentPref() {
        const event_name_contains = document.getElementById('new-pref-event').value.trim();
        const crew_id = parseInt(document.getElementById('new-pref-crew').value);
        const match_mode = document.getElementById('new-pref-mode').value;
        const venue_filter = document.getElementById('new-pref-venue').value || null;
        if (!event_name_contains || !crew_id) { showToast('Event pattern and crew required', 'error'); return; }
        const res = await fetch('/api/preferences', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ event_name_contains, crew_id, match_mode, venue_filter })
        });
        const data = await res.json();
        if (data.success) { showToast('Preference saved', 'success'); renderAdminPreferences(); }
        else showToast(data.error || 'Failed', 'error');
      }

      async function togglePrefActive(id, active) {
        await fetch('/api/preferences/' + id, {
          method: 'PUT', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ is_active: active })
        });
        showToast(active ? 'Preference enabled' : 'Preference disabled', 'success');
      }

      async function deletePref(id) {
        if (!confirm('Delete this preference?')) return;
        await fetch('/api/preferences/' + id, { method: 'DELETE' });
        showToast('Preference deleted', 'success');
        renderAdminPreferences();
      }

    </script>
</body>
</html>
  `)
})

export default app
