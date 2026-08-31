# Local API and bridge

The daemon exposes versioned REST routes under `/api/v1` and one WebSocket
event stream. It listens only on `127.0.0.1`. The CLI reads the per-user
descriptor and sends the admin bearer token. The web panel exchanges a
single-use token for an HttpOnly, SameSite=Strict cookie.

The machine-readable contract is [openapi.yaml](openapi.yaml).

## Human/admin API

- `GET /health`, `GET /doctor`
- `GET|POST /fleets`, `GET|PUT /fleets/{id}`
- `POST /fleets/design`
- `POST /fleets/{id}/launch|pause|resume|kill|cleanup`
- `POST /fleets/{id}/relaunch/{node}`
- `GET /fleets/{id}/events|report`
- `GET /fleets/{id}/ws`
- `GET|POST /config`, `POST /shutdown`

Launch requires `{ "confirm": true }`; full access additionally requires
`{ "fullAccessConfirm": true }`.

## Agent bridge

The MCP and Pi bridges expose:

- `fleet_status`, `fleet_inbox`, `fleet_message`, `fleet_ack`
- `fleet_publish`, `fleet_request_node`
- Orchestrator-only: `fleet_add_node`, `fleet_edit_node`,
  `fleet_control`, and `fleet_report`

The server—not the tool description—enforces authorization. A worker calling
an orchestrator tool receives HTTP 403.

## Events

Events have a stable monotonic ID, fleet/node/attempt ownership, ISO timestamp,
normalized type and payload, plus the original harness event in `raw`.
Clients reconnect with the latest ID through `?after=<id>` before reopening
the WebSocket, avoiding gaps.
