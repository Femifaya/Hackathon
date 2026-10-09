# Stock Catalyst AI completion checklist

## Product guardrails

- [x] Research-only product: humans make every decision; no trade execution, brokerage connectivity, or exchange trading APIs.
- [x] No Bitget data/API/MCP/Agent Hub integrations.
- [x] Market values are provider-backed or clearly synthetic demo values; unavailable values remain unavailable.
- [x] Keep credentials in server-only environment variables.

## Prioritized work

### P0 — Make the complete demo journey usable

- [x] Add setup and offline demo instructions and a placeholders-only environment example.
- [x] Validate research requests at the API boundary.
- [x] Gather market evidence and local indicators, then produce either a validated Qwen report or an explicitly labelled deterministic demo report.
- [x] Persist reports locally, expose report history and detail pages, and require acknowledgement before completion.
- [x] Export reports as Markdown and JSON with evidence, provenance, report state, and disclaimers.
- [x] Integrate research controls, progress/errors, report output, provenance, and acknowledgement in the responsive workspace.
- [x] Add tests for request validation, persistence, exports, acknowledgement, and unavailable AI behavior.

### P1 — Verify quality and security

- [ ] Run strict TypeScript, core tests, lint, and production build after the final integration changes.
- [ ] Start the local application on port 3000 and manually verify the complete demo workflow in a browser.
- [ ] Confirm the browser UI and API do not expose server credentials.

### P2 — Follow-up opportunities

- [ ] Add saved watchlist/preferences and configurable request throttling across multiple server processes.
- [ ] Add richer interactive chart overlays and report print styling.
- [ ] Add Vitest route and UI coverage beyond the core/service tests.

## Known limitations

- Offline demo reports are deterministic, rule-based templates built from synthetic demo evidence. They are not AI output and are labelled accordingly.
- Live AI report generation requires `QWEN_API_KEY`; no fake response is returned when it is missing or the model fails validation.
- Market-provider coverage and freshness depend on external provider availability and their credentials/terms.
- Local SQLite storage is intended for a single-user local workbench, not a shared multi-instance deployment.
