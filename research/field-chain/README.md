# Field-level chain

page → section → field → API → data → job → dashboard, from the repository
alone, joined only by keys the frameworks themselves define.

```
node research/field-chain/chain.mjs <repo> <base> <head>
```

Run on spring-petclinic-microservices PR #559 (`dc9ca15..1d76b00`). Full
output is in [`sample-559.txt`](sample-559.txt). One field of it:

```
━━ birthDate @PastOrPresent — newly enforced on POST and PUT
   API      POST /api/customer/owners/{ownerId}/pets → PetResource.processCreationForm  PetResource.java:55
   DTO      PetRequest.birthDate  JSON key "birthDate"  PetRequest.java:29
   DATA     pets.birth_date ← pet.setBirthDate(petRequest.birthDate())  PetResource.java:80 → Pet.java:46 @Column Pet.java:44
     PAGE     /owners/:ownerId/new-pet  router.js:36   sends POST (petId ? 'PUT' : 'POST'  PetFormPage.js:61)
       SECTION  "Pet"  PetFormPage.js:88
       FIELD    "Birth date" <date required>  PetFormPage.js:105 → payload birthDate  :52 → request :61
       REACH    YES — type="date" with no max
       TEST     pick a date after today, save → expect rejection (before: saved)
       JOURNEY  on success → /owners/details/:ownerId  PetFormPage.js:62
     GLOBAL   <chat-box> on every page → AIDataProvider.addPetToOwner()  AIDataProvider.java:73
       REACH    YES — no client guard between the model and the API
   READERS
     PAGE     /owners/details/:ownerId  SECTION "Pets and Visits" :53  FIELD "Birth Date" :66
       DATA     rows breaking the rule still display, cannot be saved again: SELECT id FROM pets WHERE birth_date > CURRENT_DATE;
       JOURNEY  "Edit Pet" OwnerDetailsPage.js:83 → the form above
   JOBS       none on this path (inventory: 1 @EventListener, vets only)
   DASHBOARD  CHANGES "HTTP Request Latency" json:85, "HTTP Request Activity" json:173 — the new 400s are counted
              unchanged "Pets Created" json:449 — @Valid rejects before the timed method runs; renaming it empties the panel
```

## How each layer is joined, and from what data

| Layer | Data in the repo | Join key | Rule |
|---|---|---|---|
| **Page** | Router config (`router.js`) | route path → component file | Vue Router `path` / `component`; React Router, Next.js file routes and Angular routes the same way |
| **Which page sends what** | The call site | a ternary on a route param | `petId ? 'PUT' : 'POST'`: the route that declares `:petId` sends PUT |
| **Section** | The component's template | nearest heading above the field | `<h1-6>`; next: `fieldset/legend`, `aria-label`, landmarks, child components |
| **Field** | Template binding + payload | `v-model="pet.birthDate"` ↔ `birthDate: pet.birthDate` | Label from `<label for=id>`, client guards from the input's attributes and modifiers |
| **Reachable?** | Client guards × server rule | — | Guard algebra: `type=date` without `max` lets a future date through; `required` + `.trim` blocks an empty name (checked in a real browser, `research/form-guard`) |
| **API** | Call URL template, gateway, mappings | URL unification | `research/page-impact` |
| **DTO** | Request record | JSON property | Field name, or `@JsonProperty` |
| **Data** | Handler, entity | setter → field → `@Column` → `@Table` | Spring Data / JPA naming |
| **Readers** | Templates of other pages | `pet.birthDate` in `{{ }}` | The object must be the entity: `pet.name`, not `pet.type.name` |
| **Journeys** | `router-link :to`, `router.push` | link pattern → route | Navigation edges into and out of the affected form |
| **Jobs** | `@Scheduled`, `@EventListener`, queue listeners | entity / table / DTO named in the job | Full inventory printed, so "none" is checkable |
| **Dashboards** | Dashboard JSON in the repo | metric name + label matchers | `http.server.requests` records every status; the PromQL matchers are evaluated against `status=400`. `@Timed` + `TimedAspect` record only when the method runs, and `@Valid` rejects before it does |

**Never silent.** Every changed file is printed as claimed by a rule, test
code, or **NOT MODELLED**. On the test-only commit `a3f9d06..1d76b00` the
output is one line saying exactly that
([`sample-control-testonly.txt`](sample-control-testonly.txt)).

## Two of its own mistakes, caught on the way

1. Reader matching by the bare JSON key listed the pet-type dropdown
   (`type.name`) and the Type row (`pet.type.name`) as readers of the pet's
   name. The join now requires the object to be the entity.
2. The empty-name test on the form: see `research/form-guard`. The rule is
   reachable from the API and the chat, not from the form.

## What the repository cannot give, and what replaces it

| Missing | Why | Replacement |
|---|---|---|
| Dashboards kept only in Grafana, not in git | Not in the repo | Read-only Grafana API (a K2 connector) |
| Rows that already break a new rule | Production data | The SQL is printed; run it on a read-only replica |
| UI built at runtime (server-driven forms, CMS content) | No template to read | Crawl a running build with Playwright and record field → request at runtime |
| Whether a reader page actually receives the field | The JSON join is name-level here | Phase B: type-level proof through response DTOs, gateway DTOs and generated clients |
| Dynamic keys (`payload[name] = …`) | Not decidable statically | Listed as unknown with the call site, never dropped |

## Scope

This prototype handles one change kind: request rules tightened by Bean
Validation. It covers one stack (Spring + Vue string templates + Grafana
JSON) and one real PR. Other change kinds print **NOT MODELLED**. Turning
this into the engine is Phase B of the roadmap.
