# Assignment Automator

**Version 1.0 - Stable Release**  
*Sound Crew Bulk Assignment Tool for NCPA*

A full-stack web application that automates crew assignments for NCPA (National Centre for the Performing Arts) sound department events. Integrates directly with the existing ncpa-sound.pages.dev scheduler - upload your monthly events CSV, get intelligent crew assignments, and export back for import.

## 🌐 URLs

- **Production**: https://crew-assignment.pages.dev
- **Sandbox**: https://3000-iwubkjnli1k5cluc5mwux-b9b802c4.sandbox.novita.ai
- **GitHub**: https://github.com/ashwinjyoti-ship-it/Crew-Assignment-Automation

## 📋 Version 1.0 Release Notes

### Core Features
- **5-Step Workflow**: Day-offs → Upload → Crew Requirements → Review/Edit → Export
- **Intelligent Assignment Engine**: Rules-based crew allocation with workload balancing
- **CSV Import/Export**: Full compatibility with NCPA format (dd-mm-yyyy dates)
- **Manual Override Support**: Edit assignments with conflict warnings
- **Calendar Export**: Google Calendar compatible format

### V1.0 Completed Features

1. **Availability Calendar**
   - Mark crew day-offs with visual grid
   - One-click weekend marking
   - Clear month functionality
   - Naren pinned at top (second-in-command)
   - Subtle grid lines for easy row/column tracking
   - Color-coded crew levels: ● Senior (blue) ● Mid (teal) ○ Junior (amber)

2. **CSV Parsing & Upload**
   - Multi-line field support (quoted fields with newlines)
   - Date format handling: dd-mm-yyyy input → yyyy-mm-dd storage → dd-mm-yyyy display
   - Automatic venue normalization (TT→Tata, JBT, TET→Experimental, etc.)
   - Team to vertical mapping (Dr.Rao→Indian Music, Farrahnaz→Intl Music, etc.)
   - Multi-day event grouping
   - Suspicious venue detection (flags potential CSV column shifts)

3. **Assignment Engine Rules**
   - FOH: Specialist rotation within verticals, capability matching
   - Stage: Internal crew prioritized over Outside Crew (OC)
   - OC must be paired with at least one internal crew member
   - All-OC stage only when no internal crew available
   - Naren capped at 7 shows/month (admin duties)
   - Day-off enforcement (unavailable crew never assigned)
   - Multi-day events: same crew throughout
   - Workload balancing within capability tiers

4. **Stage Requirements**
   - Full event names displayed (no truncation)
   - Quick dropdown for crew count (0-5)
   - Venue-based defaults (JBT/Tata: 3, Experimental: 2, Others: 1)

5. **Assignments Display**
   - Chronological ordering by date
   - Light divider lines between date groups
   - Symbol-based crew level indicators (no S/M/J text)
   - Specialist star badge (⭐)
   - Edit modal with conflict warnings

6. **Export Options**
   - NCPA Format CSV: Same columns as input with Crew populated
   - Calendar Import: Google Calendar compatible
   - Workload Report: Crew assignment summary

### Manual Review Flags
Events automatically flagged:
- DPAG (Dilip Piramal Art Gallery)
- Stuart Liff Library venues
- Multi-venue events
- Suspicious venue values (possible CSV misalignment)

## 👥 Crew Roster (14 members)

| Level | Crew Members |
|-------|--------------|
| Senior | Naren, Nikhil, Coni, Sandeep |
| Mid | Aditya, Viraj, NS, Nazar, Shridhar |
| Junior | Omkar, Akshay |
| Outside Crew | OC1, OC2, OC3 (Stage-only, last resort) |

> The roster above is the initial seed. The crew list and capability matrix are
> now **fully editable from the app** — see Crew Settings below. The seed only
> defines the starting state.

## ⚙️ Crew Settings (Configurable Roster & Capability Matrix)

Click the **Settings** button in the header to open the Crew management panel.
The roster is no longer hard-coded — manage it directly as crew join, leave, or
gain experience:

- **Add** a new crew member (name, level, stage flags, special notes)
- **Edit / update** any crew member's capability matrix as their experience grows
- **Delete** crew who have left — also removes their day-off records and workload history
- Visual capability matrix: per-venue and per-vertical dropdowns
  - **Y\*** = Specialist (preferred by the engine)
  - **Y** = Can do this
  - **N** = Cannot do (engine never assigns to these venues/verticals)

Changes take effect immediately: the day-off calendar refreshes so newly added
crew appear and removed crew disappear without reloading. Internal crew
(Senior/Mid/Junior) show in the day-off calendar; outside/hired crew do not, by
design.

> **Note:** Because the roster now lives in the database, re-running
> `npm run db:seed` will reset it to the seed roster and overwrite any edits made
> through Settings. Only seed on a fresh database.

## 📊 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/crew` | GET | List all crew with capabilities |
| `/api/crew` | POST | Add a new crew member |
| `/api/crew/:id` | PUT | Update a crew member (name, level, flags, capability matrix) |
| `/api/crew/:id` | DELETE | Remove a crew member (cleans up day-offs & workload history) |
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

## 📁 CSV Format

**Input:**
```csv
Date,Program,Venue,Team,Sound Requirements,Call Time,Crew
01-02-2026,"Jazz Night Showcase","TT","Farrahnaz & Team","Check sound requirements",17:00,""
02-02-2026,"Indian Classical Evening","JBT","Dr.Rao/Team","Full concert setup",18:00,""
```

**Output:**
```csv
Date,Program,Venue,Team,Sound Requirements,Call Time,Crew
01-02-2026,"Jazz Night Showcase","TT","Farrahnaz & Team","Check sound requirements","17:00","Nikhil, NS, Akshay"
02-02-2026,"Indian Classical Evening","JBT","Dr.Rao/Team","Full concert setup","18:00","Aditya, Viraj, Omkar"
```

## 🎯 Date Format Handling

| Location | Format |
|----------|--------|
| CSV Input | dd-mm-yyyy |
| Internal Storage | yyyy-mm-dd |
| UI Display | dd-mm-yyyy |
| CSV Export | dd-mm-yyyy |
| Calendar Export | dd-mm-yyyy |

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
npm run build
npm run deploy
```

## 📝 Tech Stack

- **Backend**: Hono (TypeScript)
- **Database**: Cloudflare D1 (SQLite)
- **Frontend**: Vanilla JS + Tailwind CSS
- **Platform**: Cloudflare Pages/Workers

## 🔮 Future Enhancements (Post V1.0)

- [ ] Calendar view with edit capability
- [ ] Learning from overrides
- [ ] Historical workload analytics
- [ ] Crew skill progression tracking
- [ ] Direct Google Calendar API integration

---

**Last Updated**: 28 June 2026  
**Version**: 1.0 Stable (+ configurable Crew Settings)  

*Built as a co-pilot to reduce cognitive load for bulk scheduling, while preserving human judgment for edge cases.*
