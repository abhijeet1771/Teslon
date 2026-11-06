# Tech landscape: what developers build with, and what Teslon reads

2026-11-05. This page answers which technologies Teslon must read so that no
corner of a real team's PR is missed. For each technology it gives what Teslon
does today, and the order in which the next readers should come.

## What the surveys say (2025)

These are summaries of the published surveys. The figures are from secondary
write-ups where the primary pages were not available, as marked.

- **Stack Overflow Developer Survey 2025**
  ([survey.stackoverflow.co/2025](https://survey.stackoverflow.co/2025/technology/);
  [summary](https://enstacked.com/stack-overflow-developer-survey-insights/)):
  - **Languages.** JavaScript is the most used, for the 11th year. Python
    moved up to third, past SQL. Go and Rust grew.
  - **Web frameworks.** Node.js and React lead, followed by jQuery, Express,
    Angular, Next.js and Vue.js.
  - **Databases.** PostgreSQL is first, then MySQL, then SQLite.
- **JetBrains, State of Java 2025** (Developer Ecosystem Survey, 24,534
  developers; [lp.jetbrains.com/the-state-of-java-2025](https://lp.jetbrains.com/the-state-of-java-2025)):
  - Spring is the leading Java framework, at 65%. Maven is the most used
    build tool, at 67%.
  - Teams are trying Quarkus, Micronaut and Ktor. Kotlin is above 5% usage.
- **State of JavaScript 2025** (13,002 answers;
  [summary](https://strapi.io/blog/state-of-javascript-2025-key-takeaways)):
  - Framework choice has settled around React, Vue and Angular.
  - Vitest and Playwright grew the most.

So an enterprise PR most often touches some mix of the following:
- **Back end:** Java with Spring (Kotlin a growing share), Node or
  TypeScript, Python, Go or .NET.
- **Front end:** React, Next.js, Angular or Vue.
- **Data:** PostgreSQL or MySQL, through JPA or SQL migrations.
- **Messaging:** Kafka or RabbitMQ.
- **Around it:** Docker, Kubernetes and CI.

## What Teslon does with each

**Status:**
- **Read:** facts are read and followed to areas, and skips are proven.
- **Detected, held:** the file is named in the report and every area it could
  reach is held as unclear. It is never silent and never a skip that rests on
  it.
- **Unread:** an unread file, said as such. Every skip in the PR is held.

### Back end

| Technology | Status | What a PR touching it gets |
|---|---|---|
| Java, Spring Boot (web, data JPA, validation, security, scheduling, events, async, AOP) | **Read** | The exact screens, APIs and jobs. Proven by 200 compiled mutants and 300+ probes |
| Spring Cloud: Gateway routes, OpenFeign, discovery names | **Read** (paths); held (filters, names) | Screens whose calls cross the route or the client |
| Spring Kafka, JMS, Rabbit and SQS listeners | **Read** (Kafka deep, the others as listeners) | Producers, consumers and the data they write |
| MapStruct, Lombok, builders, records | **Read** | The mapped fields, to the screens that show them |
| Liquibase, Flyway | **Read** | Entities, writers, readers, and start-up checks |
| Spring AI tools | **Read** | The chat that is given the tool |
| Kotlin (Spring) | Detected, held | Every area held; Kotlin is parsed as unreadable |
| Quarkus, Micronaut (JAX-RS) | Detected, held | Java is read, but `@Path` endpoints are not, so the change reaches no API and is held |
| Node.js: Express, NestJS (TypeScript) | Detected, held | Read as browser files that no screen imports: said and held |
| Python (Django, FastAPI, Flask), Go, .NET, Ruby, PHP | Unread | Said by name, and every area held [u4-17, u3-18, v4-14] |

### Front end

| Technology | Status | What a PR touching it gets |
|---|---|---|
| Angular (standalone, signals, httpResource, resolvers, guards, interceptors, pipes) | **Read** | Screens at member level, links, guards, styles |
| Vue 3 (SFC, script setup, Options API, Pinia, composables, router) | **Read** | The same |
| React, Next.js | Detected, held | Named "a React file Teslon does not read", every screen held |
| Svelte, AngularJS | Detected, held | The same |
| jQuery and plain scripts | Partly read | Read as browser modules when served from the app |

### Data, messaging, APIs

| Technology | Status |
|---|---|
| PostgreSQL, MySQL through JPA/Hibernate | **Read** (entities, columns, queries, writes) |
| SQL migrations, seeds | **Read** (Liquibase XML, Flyway SQL, CSV seeds) |
| MongoDB, Redis, Elasticsearch | Detected through their client settings, held |
| REST and JSON | **Read** at field level |
| GraphQL, gRPC and protobuf, WebSockets | Unread, said |

### Build, deploy, run

| Technology | Status |
|---|---|
| Maven (dependencies, parent, BOMs, the compiler plugin) | **Read** |
| npm, yarn, pnpm, lockfiles | **Read** |
| Gradle | Detected, held |
| Vite, the Angular CLI | **Read** for the entry, the base and global styles; the rest held |
| Docker, Compose, Kubernetes, Helm | DEPLOY area; Spring profiles they turn on are followed |
| Terraform, nginx | Unread, said |
| GitHub Actions, GitLab CI, Jenkins | No effect on the app, said so |

## The order of the next readers

Ranked by how often the technology appears in enterprise PRs (the surveys
above), times how much a missing reader costs. A missing reader always
costs skips, because everything is held; it never costs trust.

1. **React and Next.js.** They have the largest front-end share. The Vue and
   Angular readers already give the model: routes, components, member-level
   imports and fetch or axios calls.
2. **Kotlin for Spring.** The rules are the same as Java's; only the parser
   is new.
3. **Node and TypeScript back ends** (Express, NestJS). These are endpoints
   from decorators and router calls, on the TypeScript parser Teslon already
   has.
4. **Gradle** (Kotlin and Groovy DSL). The same model as Maven's
   dependencies.
5. **Python** (FastAPI, Django). Endpoints from decorators and URL
   configurations.
6. **GraphQL schemas and operations.** This is field-level, like the JSON
   reader.
7. **Go, .NET.**

Each reader lands the way the Java and Vue readers did:
- a fixture with a probe catalog, truth first;
- a compiler oracle where a compiler exists (javac here; `tsc`, `kotlinc`,
  `go build` next);
- the gauntlet's mutation families run on it before it is trusted.
