# NCPA Crew Assignment Helper

**Bulk Assignment Co-Pilot for Sound Crew Scheduling**

A full-stack web application that automates crew assignments for NCPA (National Centre for the Performing Arts) sound department events. The system applies intelligent rules based on crew capabilities, venue requirements, and vertical specializations while maintaining even workload distribution.

## 🌐 URLs

- **Development**: https://3000-iwubkjnli1k5cluc5mwux-b9b802c4.sandbox.novita.ai
- **Production**: *(Deploy with `npm run deploy`)*

## ✅ Completed Features

### Core Functionality
1. **5-Step Workflow**
   - Step 1: Crew day-offs calendar with weekend marking
   - Step 2: CSV event upload with multi-day detection
   - Step 3: Stage crew requirements quick-entry
   - Step 4: Review & edit assignments with conflict resolution
   - Step 5: Export (CSV, Calendar, Workload report)

2. **Assignment Engine**
   - Priority tiers: Senior + Specialist → Senior + Capable → Mid + Specialist → Mid + Capable → Junior → Outside Crew
   - Same-month workload balancing
   - Multi-day events get same crew throughout
   - 1 event per day per crew member (hard constraint)
   - Auto-assign Stage crew, flag FOH conflicts for manual resolution

3. **Crew Capability Matrix**
   - 12 crew members (4 Senior, 5 Mid, 2 Junior, 2 Hired)
   - 6 venues: JBT, Tata, Experimental, Little Theatre, Godrej Dance, Others
   - 8 verticals: Indian Music, Int'l Music, Western Music, Theatre, Corporate, Library, Dance, Others
   - Specialist (Y*) and conditional (Exp only) capabilities

4. **UI Features**
   - Dark theme with glassmorphic design
   - Click-to-toggle availability calendar
   - Drag-and-drop CSV upload
   - Inline editing with override warnings
   - Responsive card-based layout

### API Endpoints
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/crew` | GET | List all crew with capabilities |
| `/api/unavailability` | GET/POST/DELETE | Manage day-offs |
| `/api/unavailability/bulk` | POST | Bulk add/remove day-offs |
| `/api/events/upload` | POST | Upload events from CSV |
| `/api/events` | GET | List events by batch |
| `/api/events/:id` | PUT | Update stage crew count |
| `/api/assignments/run` | POST | Run assignment engine |
| `/api/assignments` | GET | Get assignments for batch |
| `/api/assignments/:eventId` | PUT | Manual override |
| `/api/export/csv` | GET | Download standard CSV |
| `/api/export/calendar` | GET | Download calendar format |
| `/api/export/workload` | GET | Download workload report |

## 📊 Data Models

### Crew
- Name, Level (Senior/Mid/Junior/Hired)
- Venue capabilities (JSON: Y/Y*/N per venue)
- Vertical capabilities (JSON: Y/Y*/N/Exp only per vertical)
- can_stage, stage_only_if_urgent flags
- Special notes

### Events
- Name, Date, Venue, Vertical
- Stage crew needed (default: JBT/Tata=2, others=1)
- Event group (for multi-day)
- Batch ID

### Assignments
- Event → Crew mapping
- Role (FOH/Stage)
- Manual override tracking

### Workload History
- Crew × Month → Assignment count

## 📁 Input CSV Format

```csv
Event Name,Date,Venue,Vertical
Ravi Shankar Tribute,2026-02-12,JBT,Indian Music
Jazz Night,2026-02-15,Tata,Intl Music
Kathak Festival,2026-02-14,Experimental,Dance
Kathak Festival,2026-02-15,Experimental,Dance
```

**Multi-day events**: Same name = same crew for all dates.

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

## 🔮 Future Enhancements (Phase 2)

- [ ] Learning from overrides (suggested vs final tracking)
- [ ] Historical workload analytics
- [ ] Crew skill progression tracking
- [ ] Integration with Google Calendar API
- [ ] Mobile-optimized view

## 📝 Tech Stack

- **Backend**: Hono (TypeScript)
- **Database**: Cloudflare D1 (SQLite)
- **Frontend**: Vanilla JS + Tailwind CSS
- **Platform**: Cloudflare Pages/Workers

---

*Built as a co-pilot to reduce cognitive load for bulk scheduling, while preserving human judgment for edge cases.*
