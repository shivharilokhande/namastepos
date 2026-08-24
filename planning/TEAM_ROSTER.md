# NamastePOS — Build-team Roster (22 people)

**Active from:** Sprint 1 (2026-05-20)
**Capacity:** ~36 ideal dev-days / 2-week sprint after meetings + ceremonies
**Velocity target:** 80 story points / sprint (planning, retro at end of each)

---

## Leadership & Product

| Role | Name | Yrs | Owns |
|---|---|---|---|
| Founder / CEO | Arjun Mehta | 26 | Final calls, override, vision |
| CTO | Vikram Rao | 25 | Stack, security posture, scaling |
| CPO | Deepa Krishnan | 22 | Roadmap, OKRs, customer interviews |
| **Project Manager** | **Rohit Kapoor** | 18 | Cross-team timeline, vendor coordination, exec reporting |
| **Product Owner** | **Rajan Iyer** | 21 | Backlog priority, AC sign-off, demos to user |
| **Business Analyst** | **Ananya Desai** | 20 | User stories, edge cases, BRD → AC translation |
| **Scrum Master** | **Kavitha Nair** | 20 | Daily standups, sprint planning/retros, impediment removal, velocity tracking |
| Director of Design | Meera Joshi | 20 | Design system, wireframes, accessibility |

## Architecture & Senior Engineering

| Role | Name | Yrs | Owns |
|---|---|---|---|
| Solution Architect | Srinivas Iyengar | 23 | DB schema, API contracts, ADRs |
| Backend Senior | Arun Patel | 20 | Event-driven, performance, payments |
| Backend Senior 2 | Rajesh Bansal | 22 | Integration platforms (Zomato/Swiggy/Tally) |

## Backend Engineering (4)

| Role | Name | Yrs | Specialty |
|---|---|---|---|
| Backend Eng | Nikhil Gupta | 20 | Auth, billing, addons |
| Backend Eng | Pradeep Khanna | 18 | Order/KOT/inventory services |
| Backend Eng | Sunita Rao | 16 | Reports, accounting exports |
| Backend Eng (jr) | Tarun Saxena | 8 | Internal tooling, scripts |

## Frontend Engineering (3)

| Role | Name | Yrs | Specialty |
|---|---|---|---|
| Frontend Senior | Rhea Menon | 20 | React, design system, perf |
| Frontend Eng | Aman Shukla | 14 | Admin panels, complex forms |
| Frontend Eng (jr) | Priya Bhatt | 7 | Customer dashboard polish |

## Mobile Engineering (2)

| Role | Name | Yrs | Specialty |
|---|---|---|---|
| Flutter Senior | Bharath Kumar | 16 | Captain app, POS, offline sync |
| Flutter Eng | Shruti Pillai | 9 | Customer-facing app, push notifications |

## QA (4) — manual + automation

| Role | Name | Yrs | Specialty |
|---|---|---|---|
| QA Lead | Divya Srinivasan | 20 | Test architecture, sign-off, quality gate |
| QA — API + Automation | Arvind Kumar | 22 | Supertest, Playwright, k6 |
| QA — Functional + Manual | Suresh Pillai | 21 | E2E flows, edge-cases, exploratory |
| QA — Database + Security | Priya Iyer + Lakshmi Reddy | 24 / 23 | Schema, FK integrity, RBAC, OWASP |

## DevOps + Data (1)

| Role | Name | Yrs | Owns |
|---|---|---|---|
| DevOps Lead | Rohan Chakraborty | 20 | K8s, CI/CD, observability, release management |

---

## RACI (who is responsible for what across a story)

| Stage | R (does the work) | A (sign-off) | C (consulted) | I (informed) |
|---|---|---|---|---|
| **Idea → user story** | BA Ananya | PO Rajan | Designer Meera | PM Rohit |
| **AC + estimation** | BA + dev lead | PO Rajan | Architect Srinivas | SM Kavitha |
| **Design** | Designer Meera | PO Rajan | Frontend Rhea | PM Rohit |
| **Schema** | Architect Srinivas | CTO Vikram | DBA Priya | PM Rohit |
| **Backend dev** | Backend eng | Backend Senior Arun | Architect Srinivas | SM |
| **Frontend dev** | Frontend eng | Senior Rhea | Designer Meera | SM |
| **Mobile dev** | Flutter eng | Senior Bharath | Backend (API contract) | SM |
| **Manual QA** | Suresh | QA Lead Divya | Dev | PO |
| **Auto + perf** | Arvind | QA Lead Divya | DevOps Rohan | PO |
| **Security review** | Lakshmi | CTO Vikram | Backend Senior | PO |
| **Deploy** | DevOps Rohan | CTO Vikram | All | PM Rohit |
| **Demo + accept** | PO Rajan | Founder Arjun | All | Stakeholders |

---

## Specialty assignments per gap-doc theme

| Theme | Lead dev | Pair | QA | Mobile |
|---|---|---|---|---|
| Aggregator ingestion (F1) | Rajesh (integration) | Pradeep | Arvind | n/a |
| Variants + modifiers (F2, F3) | Arun | Pradeep | Suresh + Priya | Bharath |
| Bill polish (F4-F8) | Nikhil | Aman (FE) | Suresh | Bharath |
| 86 toggle, cancel reasons (F9, F39) | Pradeep | Priya B (FE) | Suresh | Shruti |
| Z-report (F10) | Sunita | Aman | Arvind | n/a |
| Reservation (F11) | Pradeep | Rhea | Suresh | Bharath |
| Manager approval (F12) | Nikhil | Aman | Lakshmi | Shruti |
| Offline mode (F13) | Bharath | Pradeep | Arvind | — |
| i18n (F14) | Rhea | Bharath | Suresh | Shruti |
| Tokens (F15) | Pradeep | Priya B | Suresh | Bharath |
| Order tracker (F16) | Sunita | Priya B | Suresh | — |
| WhatsApp ordering (F18) | Rajesh | Arun | Arvind | n/a |
| Direct online site (F19) | Rhea | Aman | Suresh | n/a |
| Driver mgmt (F20) | Pradeep | Bharath | Suresh | Shruti |
| Printer integration (F22, F23) | Arun | Bharath | Suresh + Arvind | Bharath |
| Item-level GST (F25) | Sunita | Architect | Priya I | n/a |
| Bar / liquor (F26) | Pradeep | Sunita | Priya I + Lakshmi | n/a |
| Multi-outlet (F36) | Nikhil + Srinivas | Aman | Arvind | n/a |
| KDS (F38) | Pradeep + Rhea | Aman | Suresh | n/a |
| Retail (R1-R20) | Whole backend team rotating | — | Whole QA team | n/a |

---

## Working rhythm

- **Sprint length:** 2 weeks
- **Standup:** Daily, 09:30 IST, 15 min, async on Slack channel
- **Sprint planning:** Day 1, 11:00–13:00 IST (PO + SM + leads)
- **Mid-sprint demo:** Day 5, 17:00 IST (informal)
- **Sprint review:** Last day, 14:00 IST (with user/customer rep)
- **Retro:** Last day, 16:00 IST (team only)
- **Architecture sync:** Wednesdays 11:00 IST (architect + backend seniors + CTO)
- **Quality gate:** Last day before sprint end (QA lead + dev leads sign each story off)
