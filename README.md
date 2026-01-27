# NCPA Crew Assignment Helper

**Bulk Assignment Co-Pilot for Sound Crew Scheduling**

A full-stack web application that automates crew assignments for NCPA (National Centre for the Performing Arts) sound department events. Integrates directly with the existing ncpa-sound.pages.dev scheduler - upload your monthly events CSV, get intelligent crew assignments, and export back for import.

## 🌐 URLs

- **Development**: https://3000-iwubkjnli1k5cluc5mwux-b9b802c4.sandbox.novita.ai
- **Production**: *(Deploy with `npm run deploy`)*
- **Integration**: Exports compatible with ncpa-sound.pages.dev

## ✅ Completed Features

### Core Functionality
1. **5-Step Workflow**
   - Step 1: Crew day-offs calendar with weekend marking
   - Step 2: CSV event upload with automatic venue/team mapping
   - Step 3: Crew requirements quick-entry (defaults by venue)
   - Step 4: Review & edit assignments with conflict resolution
   - Step 5: Export (NCPA format CSV, Calendar, Workload report)

2. **Intelligent Parsing (Real NCPA Format)**
   - **Input**: `Date, Program, Venue, Team, Sound Requirements, Call Time, Crew`
   - **Output**: Same format with Crew column populated
   - **Venue Mapping**: JBT, TT→Tata, TET→Experimental, GDT→Godrej Dance, LT→Little Theatre
   - **Team→Vertical**: Dr.Rao/Team→Indian Music, Farrahnaz→Intl Music, etc.
   - **Manual Flags**: Multi-venue, DPAG, Stuart Liff events flagged for manual decision

3. **Assignment Engine**
   - Priority tiers: Senior + Specialist → Senior + Capable → Mid + Specialist → Mid + Capable → Junior → OC
   - **Same-month** workload balancing (rotation within tiers)
   - Multi-day events get same crew throughout
   - 1 event per day per crew member (hard constraint)
   - Auto-assign Stage crew, flag FOH conflicts for manual resolution

4. **Crew Roster (13 members)**
   - **Senior (4)**: Naren, Nikhil, Coni, Sandeep
   - **Mid (5)**: Aditya, Viraj, NS, Nazar, Shridhar
   - **Junior (2)**: Omkar, Akshay
   - **Outside Crew (3)**: OC1, OC2, OC3 (Stage-only, last resort)

5. **Venue Defaults**
   - JBT/Tata: 3 crew (1 FOH + 2 Stage)
   - Experimental: 2 crew
   - Little Theatre/Godrej Dance/Others: 1 crew

### Manual Review Flags
Events automatically flagged for manual assignment:
- **DPAG** (Dilip Piramal Art Gallery)
- **Stuart Liff Library**
- **Multi-venue events** (e.g., "TT TET GDT")

### API Endpoints
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/crew` | GET | List all crew with capabilities |
| `/api/unavailability` | GET/POST/DELETE | Manage day-offs |
| `/api/unavailability/bulk` | POST | Bulk add/remove day-offs |
| `/api/events/upload` | POST | Upload events from CSV |
| `/api/events` | GET | List events by batch |
| `/api/events/:id` | PUT | Update crew count |
| `/api/assignments/run` | POST | Run assignment engine |
| `/api/assignments` | GET | Get assignments for batch |
| `/api/assignments/:eventId` | PUT | Manual override |
| `/api/export/csv` | GET | Download NCPA format CSV |
| `/api/export/calendar` | GET | Download calendar format |
| `/api/export/workload` | GET | Download workload report |

## 📊 Data Models

### Crew
- Name, Level (Senior/Mid/Junior/Hired)
- is_outside_crew flag (OC1, OC2, OC3)
- Venue capabilities (JSON: Y/Y*/N per venue)
- Vertical capabilities (JSON: Y/Y*/N/Exp only per vertical)
- can_stage, stage_only_if_urgent flags

### Events
- Original CSV fields preserved: Program, Venue, Team, Sound Requirements, Call Time
- venue_normalized (for rules engine)
- vertical (derived from Team)
- needs_manual_review, manual_flag_reason
- Event group (for multi-day)

### Assignments
- Event → Crew mapping
- Role (FOH/Stage)
- Manual override tracking

## 📁 CSV Format

**Input (from ncpa-sound.pages.dev):**
```csv
Date,Program,Venue,Team,Sound Requirements,Call Time,Crew
2026-02-01,Jazz Night Showcase,TT,Farrahnaz & Team,Check sound requirements,17:00,
2026-02-02,Indian Classical Evening,JBT,Dr.Rao/Team,Full concert setup,18:00,
```

**Output (ready for import):**
```csv
Date,Program,Venue,Team,Sound Requirements,Call Time,Crew
2026-02-01,Jazz Night Showcase,TT,Farrahnaz & Team,Check sound requirements,17:00,"Nikhil, NS, Akshay"
2026-02-02,Indian Classical Evening,JBT,Dr.Rao/Team,Full concert setup,18:00,"Aditya, Viraj, Omkar"
```

**Multi-day events**: Same Program name = same crew for all dates.

## 🚀 Deployment

### Local Development
```bash
npm run build
npm run db:migrate:local
npm run db:seed
npm run dev:sandbox
```

### Production (Cloudflare Pages)
```bash
# Setup API key first
npm run build
npx wrangler d1 create ncpa-crew-db  # Get database_id
# Update wrangler.jsonc with database_id
npx wrangler d1 migrations apply ncpa-crew-db
npm run deploy
```

## 🎨 Design System

- **Theme**: Dark minimalist glassmorphism
- **Colors**: Blues (#60a5fa), greys, cream (#f5f0e8), off-white
- **Cards**: Glass panels with backdrop blur
- **Motion**: Subtle fade-ins, smooth transitions

## 📝 Team→Vertical Mapping Reference

| Team Field | Vertical |
|------------|----------|
| Dr.Rao/Team, Dr. Rao/Team | Indian Music |
| Farrahnaz & Team, Farrahnaz | Intl Music |
| Bianca/Team | Western Music |
| Nooshin/Team, Bruce/* | Theatre |
| Dr.Swapno/Team | Dance |
| Dr.Sujata/Team, Dr.Cavas | Library |
| Marketing | Corporate |
| DP, PAG, Lit Live | Others |

## 🔮 Future Enhancements (Phase 2)

- [ ] Learning from overrides (suggested vs final tracking)
- [ ] Historical workload analytics
- [ ] Crew skill progression tracking
- [ ] Direct Google Calendar integration

## 📝 Tech Stack

- **Backend**: Hono (TypeScript)
- **Database**: Cloudflare D1 (SQLite)
- **Frontend**: Vanilla JS + Tailwind CSS
- **Platform**: Cloudflare Pages/Workers

---

*Built as a co-pilot to reduce cognitive load for bulk scheduling, while preserving human judgment for edge cases.*
