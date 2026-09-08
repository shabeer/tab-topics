# Tab Organizer Extension — Requirements Review & Revised Specification

**Status:** Draft for review (rev 2 — added `done` queue)
**Date:** 2026-09-08
**Purpose:** Record of the issues found in the original requirements, the clarifying decisions made, and the resulting revised specification (v2). No code has been written.

---

## 1. Original requirements (verbatim, for traceability)

> Build a chrome plugin extension to read tabs info and auto or manually classify into topics. Aim to is organize, prioritize tabs, write notes.
> It should provide following functionalities
> - each tab entry should store - title, url, date of publishing (if available), if yt - then channel name, date of publishing, etc
> - have manual custom notes to each tab entry
> - classfying based on yt channel, manual topic, etc
> - Each topic should have 2 queues, one - ordered, another to_be_ordered. New tabs should be added in the first in to_be_ordered queue. It will be moved to ordered queue manually.
> - it should provide keyboard shortcut to add a tab to a topic's to_be_ordered queue.
> - it should provide keyboard shortcut to add info (custom notes) to a tab entry.
> - search facility within the notes
> - auto-classify tabs to respective topics. First present the draft classfication, get manual approval then add tabs to topic.
> - when a single tab or all tabs of a window are added to topic, provide a option to close the tab(s)
> - export/import all of plugin data - including topics, manually entered, keyboard shortcuts etc

---

## 2. Issues identified in the original requirements

### 2.1 Contradictions and internal tensions

1. **"Auto" classify vs. approval-gated everything.** The intro promises automatic classification, but the auto-classify bullet requires manual approval before any tab is added. As written, nothing is ever filed automatically — every "automatic" path ends in a human click. Either the intro overstates, or trusted classifications should bypass approval.
2. **"New tabs should be added in to_be_ordered" is unsatisfiable as written.** A brand-new browser tab has no topic, so it cannot enter "a topic's" to_be_ordered queue. If the intent was "newly *filed* entries always start in to_be_ordered," then even explicitly manual assignments must detour through it — which arguably defeats an explicit user choice.
3. **Approved drafts have no stated destination.** The auto-classify bullet ends at "add tabs to topic" without saying which queue receives them.
4. **"Prioritize" is claimed but never implemented.** The stated aim includes prioritizing tabs, yet the only mechanism is manual ordering *within* a single topic — no cross-topic priority, flags, due dates, or sort criteria.
5. **Close-tab vs. persistence is undefined.** The doc offers "close the tab(s)" after saving but never states whether a saved entry survives its tab closing or a browser restart — the single biggest unstated architectural decision.
6. **Minor editorial inconsistencies.** YouTube publish date listed twice in the metadata bullet; "etc" appears twice (fields list, classification signals) without definition; channel name specified only for YouTube with no analogous field (author/site) for ordinary pages; the export bullet says "manually entered" with no noun, and doesn't say whether pending-approval state exports.

### 2.2 Incompleteness

**Persistence & lifecycle** — whether entries survive tab close / browser restart; storage backend and limits; duplicate handling (same URL saved twice); what closing a tab means for the entry.

**Topic management** — no create/rename/delete/merge; behavior of entries on topic deletion; whether a default/Inbox topic exists for pending or unmatched tabs.

**Queue mechanics** — how order in the "ordered" queue is defined and changed; whether entries can move back; removal/archive; any "done/consumed" state (implied by the prioritize aim); multi-topic membership.

**Notes model** — single note vs. timestamped history; edit/delete; length; plain vs. rich text.

**Auto-classification spec** — trigger (tab open / on demand / periodic); signals; where rules are authored/edited; per-tab vs. bulk review; destination of rejected drafts.

**Metadata acquisition** — Chrome's tabs API provides only title/URL/favicon; publish date and channel name require content-script scraping (meta tags, JSON-LD), the YouTube Data API (key + quota), or oEmbed; fetch timing; behavior when unavailable.

**Keyboard shortcuts** — which keys; Chrome constraint (extension commands are declared statically in the manifest with only a handful of default bindings — per-topic shortcuts at runtime are impossible); conflicts; whether the notes shortcut requires an already-saved tab.

**UI surface** — never specified: popup, Chrome Side Panel, or full page; where queues, search, and review live.

**Search** — scope (notes only vs. all metadata); matching style; where results appear; actions from results.

**Import/export** — format; merge vs. replace; same-URL conflict handling; schema versioning; whether imported shortcuts/settings overwrite current ones.

**Sync & platform** — single device vs. cross-device sync; Chrome-only; Manifest V3; privacy posture (host permissions for scraping; whether page data may leave the machine).

### 2.3 Ambiguities

"Auto or manually classify" (configurable modes?); which queue approved items enter; how the shortcut knows *which* topic; whether the notes shortcut targets the active tab and works on unsaved tabs; "search within the notes" (strictly notes?); both "etc"s; "all tabs of a window added to a topic" (same topic collectively or each to any topic; who triggers the close option); "provide an option to close" (prompt each time, a setting, or automatic with undo); "manually entered" in the export bullet; "new tabs" in the queue bullet.

---

## 3. Clarifying decisions (Q&A record)

| # | Question | Decision |
|---|----------|----------|
| 1 | Persistent saved entries vs. live-tab organizer? | **Persistent entries** — closing a tab is optional cleanup; data survives restarts (read-later library model) |
| 2 | Classifier type & autonomy? | **Rule-based, local, approval-gated** — user-defined mappings; nothing files unattended; no external services |
| 3 | Shortcut → topic mechanism? | **One shortcut + topic picker** (type-to-search / number keys) |
| 4 | Metadata approach for v1? | **Minimal** — title, URL, date-added only; enrichment deferred |
| 5 | Main UI surface? | **Popup + full page** — compact popup for quick filing; full-tab page for queues/search |
| 6 | Notes model? | **Single editable plain-text note** per entry |
| 7 | Multi-topic membership / duplicates? | **One topic per URL**; re-saving moves it |
| 8 | When are draft classifications generated? | **Suggest at save time** — rules run when the shortcut is invoked; the picker pre-selects the match. No background watching |
| 9 | Queue lifecycle — terminal "done" state? | **Added (post-review)** — each topic gets a third queue, `done`; entries can move into it from either `to_be_ordered` or `ordered` |

**Tension flagged during Q&A:** "Minimal metadata" (no stored channel name) vs. "classify by YouTube channel." Resolved: v1 rules match channels via URL patterns (domain, `youtube.com/@handle`); storing channel name as a field moves to v2.

---

## 4. Revised requirements (v2)

**Product:** A Chrome (Manifest V3) extension that saves open tabs as persistent entries, files them under user-defined topics through three per-topic queues (`to_be_ordered`, `ordered`, `done`), and supports per-entry notes and search. A saved entry is a library record — it survives the tab closing and browser restarts; closing a tab never deletes it.

### 4.1 Data model

- **Tab entry:** id, title (tabs API), URL, date_added, topic_id, queue (`to_be_ordered` | `ordered` | `done`), position within its queue, single plain-text note (optional, editable anytime), optional record of which rule suggested the topic.
- **Topic:** id, name, created_at. Rename allowed. Deletion requires moving its entries to another topic first (default — see §5).
- **Rule:** id, match type (domain | URL pattern | YouTube channel via URL handle), target topic, enabled flag. v1 matches on URL only.
- **Settings:** shortcut bindings (within Chrome's limits), close-after-add preference, export/import.

### 4.2 Behavior

**Saving a tab.** Keyboard shortcut → picker overlay (type-to-search / number keys) → matching rules pre-select/highlight a suggested topic → user confirms → entry lands in that topic's `to_be_ordered`. *This resolves original point 9: the "present draft → manual approval" step is folded into the picker confirmation rather than being a separate review screen (decision #8).* The picker includes an optional "close tab after adding" checkbox.

**Bulk window filing.** A "file all tabs in this window" action shows one picker row per tab (each may target a different topic, rules pre-filling); once every tab in the window is filed, the extension offers to close them. Entries persist regardless.

**Queues.** Each topic has three queues: `to_be_ordered`, `ordered`, and `done`. New entries append to the end of `to_be_ordered`; moving to `ordered` is manual (drag-and-drop reorder — default); entries can move back, be reordered anytime, or be deleted anytime. Entries can move into `done` from either of the other two queues (decision #9). Done entries can be moved back out or deleted, and they remain searchable and included in export (defaults — see §5).

**Duplicates.** Saving an already-saved URL moves it to the newly chosen topic's `to_be_ordered`; the existing note is preserved.

**Search.** Available in popup and full page. Scope: notes **plus** title, URL, and topic name (the literal "notes only" reading would make note-less entries unsearchable — see §5). Substring matching.

**Export/import.** One JSON file containing topics, entries (notes, queues, positions), rules, and settings, with a schema version field. Import merges; on URL conflicts the local entry wins and the conflict count is reported (default — see §5).

**Storage & privacy.** `chrome.storage.local`, single device, no sync in v1. Permissions: `tabs` only — no host permissions, no scraping, no external services; everything on-machine.

### 4.3 Explicitly deferred to v2

- Publish date, YouTube channel name, and other enriched metadata (requires scraping or the YouTube Data API).
- Classification keyed on stored channel fields (v1 matches URLs only).
- Background / on-demand bulk classification scans and a separate draft-review screen.
- Timestamped note history; multi-topic membership; an archive state distinct from `done`; cross-device sync.
- Cross-topic prioritization (flags, due dates) — the "prioritize" aim is scoped to manual ordering within topics.

### 4.4 How each original contradiction was resolved

1. *Auto vs. approval gate* → rules only suggest; the picker confirmation is the approval.
2. *New tabs → to_be_ordered with no topic* → entries are created only at save time and always enter the chosen topic's `to_be_ordered`.
3. *Approved drafts' destination* → moot; confirmation files directly into `to_be_ordered`.
4. *Prioritize aim* → intra-topic manual ordering plus a consumption workflow via the `done` queue (decision #9); cross-topic priority remains a v2 feature request.
5. *Close tabs vs. entry survival* → closing is pure cleanup; entries persist.
6. *YT-channel classification vs. minimal metadata* → v1 rules match channels through URL patterns; storing channel names is v2.

---

## 5. Defaults applied — please review and veto any

These were not explicitly confirmed in the Q&A; they follow conventional patterns and can be changed without affecting the locked decisions:

1. Ordered queue is reordered by drag-and-drop; entries may move back to `to_be_ordered`.
2. `done` is reversible — entries can move back to `to_be_ordered` or `ordered`, or be deleted — and done entries stay searchable and are included in export.
3. Re-saving a duplicate preserves the note and re-files the entry into the new topic's `to_be_ordered` (queue resets to `to_be_ordered` even if the entry was in `done`).
4. Search scope extended beyond notes to title/URL/topic (deviates from the literal original wording).
5. Import merges; same-URL conflicts keep the local entry (reported, not prompted per-item).
6. Topic deletion requires first moving entries to another topic.
7. Storage is local-only (`chrome.storage.local`); no cross-device sync in v1.
8. Chrome-only, Manifest V3.

---

## 6. Review checklist

- [ ] Confirm the nine locked decisions (§3) still stand.
- [ ] Veto or accept the eight applied defaults (§5).
- [ ] Confirm `done`-queue semantics (reversible; done entries stay searchable and exported).
- [ ] Confirm the v2 deferral list (§4.3) is acceptable — especially enriched metadata (publish date / channel name) and the folded approval flow.
- [ ] Decide whether cross-topic prioritization should be in scope after all (original aim said "prioritize").
