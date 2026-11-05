# Probe catalog: spm

9 probes · 9 trusted · 0 trust failures · 0 imprecise · extra screens 1.2% (P1 ≤ 5%) · held screens 2.5% (P2 ≤ 10%) · 10 logic units covered · slowest 1799 ms

skip certificates: 55 skips checked · 44 certified (1 of them rely on content analysis) · 11 not proven, held · unknowns that blocked a skip: http-client 9 · dangling calls 7.3%

| probe | logic | Teslon said | result |
|---|---|---|---|
| m01-find-owner: Owner lookup returns empty for owner 1 | services.callers, services.gateway-aggregation | T7 S4 U1 · High · +1 extra | ✓ |
| m02-create-visit: New visits are dated today | services.callers | T2 S8 U1 · High | ✓ |
| m03-vets-list: Vets are listed first ten only | services.callers, ai.tools | T2 S8 U1 · High | ✓ |
| m04-gateway-route: The vets route moves to /api/vets | services.gateway-routes | T1 S7 U2 · High · 1 held | ✓ |
| m05-service-client: The gateway asks visits-service on a new path | services.http-clients, services.gateway-aggregation | T2 S8 U1 · High | ✓ |
| m06-ai-tool: The vets tool answers in a new format | ai.tools | T2 S9 U1 · High | ✓ |
| m07-http-client: Every request now sends cookies | ui.shell, ui.services | T9 S0 U2 · High · 1 held | ✓ |
| m08-route-renamed: Vets page moves to /veterinarians | ui.routes, ui.links | T11 S0 U1 · High | ✓ |
| m09-stylesheet: Wider page margins | ui.styles, ui.shell | T10 S0 U1 · High | ✓ |
