# PLAN-037-5: Settings rich tab layouts

## Metadata
- **Parent**: PLAN-037-portal-kit-parity
- **Effort**: 3 days
- **Dependencies**: [PLAN-037-2] (settings action endpoints)
- **Priority**: P1 (Settings is a complex surface; current state shows flat tables for Variants/Backends/Agents)

## Objective

Rebuild the Settings tabs to match the kit's rich layouts:
- **General**: 2-column `.settings-grid` of cards (Trust / Cost caps / Repo allowlist / Notifications) with `.input-row` for prefix/suffix inputs (`$ ... / day`)
- **Variants**: `.variant-grid` of cards with phase-tag pipelines + reviewer chain row
- **Standards**: rich table with severity chips (`.chip sev-blocking|sev-warn|sev-advisory`) and per-row Edit button
- **Backends**: `.backend-grid` cards with caps chips + Install / Configure action
- **Agents**: table + Inspect modal (kit pattern)

Add the Save/Discard header buttons (kit `Settings.jsx:18-19`).

## Scope

### In Scope

1. **General tab rebuild** (`templates/fragments/settings-general.tsx` or inline):
   - 2-column `.settings-grid` layout
   - Cost caps card uses `.input-row` with `<span class="input-prefix">$</span><input/><span class="input-suffix">/ day</span>`
   - Trust card uses radio group + per-repo overrides table
2. **Variants tab rebuild** (`templates/fragments/settings-variants.tsx`):
   - `.variant-grid` of `.variant-card`
   - Each card: header (ID mono + label), pipeline row of `.phase-tag` chips, reviewer chain row showing chain ID + count
3. **Standards tab rebuild**:
   - Use existing rich table, swap `.chip muted` for `.chip sev-{blocking|warn|advisory}` based on rule severity
   - Add Edit button per row that opens an edit modal
4. **Backends tab rebuild** (`templates/fragments/settings-backends.tsx`):
   - `.backend-grid` of `.backend-card`
   - Each card: header (ID + kind chip), caps chips (`.cap-chip` × N), health dot, footer with Install / Configure / Disable
5. **Agents tab modal** — wire `templates/fragments/agent-table.tsx`'s Inspect button to open a `<dialog>` modal via HTMX (`hx-get="/api/agents/:name/inspect" hx-target="#modal-slot"`). Add the matching GET route in PLAN-037-2.
6. **Save/Discard header** — `<div class="head-actions"><button class="btn">Discard</button><button class="btn primary" hx-post="/settings">Save</button></div>`. Save accumulates form deltas via dirty-tracking JS module (`settings-dirty.js` — small new module).
7. **Modals** — replace existing fragment-level `<dialog>` usage with kit's `.modal-bg`+`.modal modal-wide` overlay pattern. Provide a shared `<ConfirmModal>` and `<Modal>` helper.
8. **Tests**: per-tab template tests; one integration test for Save POST.

### Out of Scope
- Live config schema validation beyond what already exists in `config-validator.ts`.
- New config keys.

## Verification
- Visual match to `/tmp/portal-design-v2/autonomous-dev-design-system/project/ui_kits/portal/Settings.jsx`.
- Clicking "Inspect" on an agent opens the modal with that agent's details.
- Save button posts dirty form deltas and returns 200.

## Tests
- Unit per tab + Save flow integration test.

## Risks
| Risk | Mitigation |
|---|---|
| Dirty-tracking JS is a new module — could break existing tab navigation | Keep `settings-tabs.js` separate; new module is opt-in via `data-dirty-tracking` attribute |
| Modal overlay pattern (`.modal-bg`) conflicts with existing `<dialog>` usage in KillSwitch | KillSwitch can keep `<dialog>`; Settings uses the overlay pattern; document both as acceptable |
