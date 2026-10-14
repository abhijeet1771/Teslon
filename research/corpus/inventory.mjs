// Channel inventory: which of the atlas's fifteen channels does a repository
// actually use, measured by the constructs that create each coupling.
//
//   node research/corpus/inventory.mjs <dir-of-clones> [--json]
//
// Two jobs. It picks the corpus: repos are chosen to cover every channel, by
// measurement, not by fame. And it is the first piece of "never silent": a
// channel a repo uses that Teslon has no rule for must show up as NOT MODELLED
// in every report on that repo, before any PR is analysed.
//
// A probe counts files, not matches, so one generated file cannot dominate.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const JAVA = '*.java', KT = '*.kt', TS = '*.{ts,tsx}', JS = '*.{js,jsx,mjs}', VUE = '*.vue', HTML = '*.html', PY = '*.py', CS = '*.cs', GO = '*.go';
const YML = '*.{yml,yaml}', PROPS = '*.properties', XML = '*.xml', JSON_ = '*.json', SQL = '*.sql';
const FE = [TS, JS, VUE, HTML];

/** [channel, probe name, globs, regex] */
export const PROBES = [
  // 1 code
  ['1 code', 'java/kotlin files', [JAVA, KT], '.'],
  ['1 code', 'ts/js/vue files', FE, '.'],
  ['1 code', 'python/go/c# files', [PY, GO, CS], '.'],
  ['1 code', 'interface dispatch', [JAVA, KT, TS], '\\bimplements\\s+\\w|\\binterface\\s+\\w+'],
  // 2 framework wiring
  ['2 wiring', 'AOP aspects', [JAVA, KT], '@Aspect\\b|@Around\\('],
  ['2 wiring', 'filters / interceptors', [JAVA, KT], 'OncePerRequestFilter|HandlerInterceptor|implements\\s+(Web)?Filter\\b|GlobalFilter|GatewayFilter'],
  ['2 wiring', 'global exception advice', [JAVA, KT], '@(Rest)?ControllerAdvice'],
  ['2 wiring', 'conditional beans', [JAVA, KT], '@Conditional\\w*\\(|@Profile\\(|@Primary\\b'],
  ['2 wiring', 'frontend DI / context', [TS, JS], '@Injectable\\(|createContext\\(|provide\\(\\s*[\'"\\w]'],
  // 3 cross-cutting annotations
  ['3 annotations', '@Transactional', [JAVA, KT], '@Transactional\\b'],
  ['3 annotations', '@Async / @Retryable', [JAVA, KT], '@Async\\b|@Retryable\\b'],
  ['3 annotations', 'method security', [JAVA, KT], '@PreAuthorize|@Secured|@RolesAllowed|@SaCheckPermission|@RequiresPermissions'],
  // 4 observable behaviour
  ['4 behaviour', 'sorting / paging', [JAVA, KT, PY, TS], 'Sort\\.by|PageRequest\\.of|Pageable\\b|ORDER BY|order_by\\(|orderBy:'],
  ['4 behaviour', 'money / rounding', [JAVA, KT, PY, CS], 'RoundingMode|setScale\\(|Decimal\\(|decimal\\b'],
  ['4 behaviour', 'time zones', [JAVA, KT, PY, TS], 'ZoneId|TimeZone|ZonedDateTime|tzinfo|timezone\\('],
  // 5 synchronous contracts
  ['5 sync contracts', 'server endpoints', [JAVA, KT], '@(Get|Post|Put|Delete|Patch|Request)Mapping'],
  ['5 sync contracts', 'server endpoints (other stacks)', [PY, CS, GO, TS], 'urlpatterns|@app\\.(get|post|route)|\\[Http(Get|Post|Put|Delete)|MapGet\\(|MapPost\\(|HandleFunc\\(|@(Get|Post|Put|Delete)\\(\\s*[\'"]'],
  ['5 sync contracts', 'bean validation', [JAVA, KT], '@Valid\\b|@NotNull|@NotBlank|@Size\\(|@Pattern\\(|@Min\\(|@Max\\(|@Email\\b'],
  ['5 sync contracts', 'java http clients', [JAVA, KT], '@FeignClient|RestTemplate|WebClient|RestClient\\b'],
  ['5 sync contracts', 'frontend http calls', [TS, JS, VUE], 'fetch\\(|axios|HttpClient|\\$http\\b|useQuery\\(|request\\(\\s*\\{|trpc\\.'],
  ['5 sync contracts', 'gateway routes', [YML, JAVA, PROPS], 'spring\\.cloud\\.gateway|- Path=|RouteLocator|zuul'],
  ['5 sync contracts', 'service discovery', [YML, JAVA, PROPS], 'eureka|consul|nacos|@EnableDiscoveryClient|lb://'],
  ['5 sync contracts', 'schemas: openapi/proto/graphql', ['*.proto', '*.graphql', '*.graphqls', 'openapi*.{yml,yaml,json}', 'swagger*.{yml,yaml,json}'], '.'],
  ['5 sync contracts', 'enums', [JAVA, KT, TS, PY, CS], '\\benum\\s+\\w+|\\(Enum\\)|models\\.TextChoices'],
  // 6 async contracts
  ['6 async', 'kafka', [JAVA, KT, PY, TS, YML], '@KafkaListener|KafkaTemplate|kafka'],
  ['6 async', 'rabbit / jms / sqs', [JAVA, KT, PY, CS, TS, YML], '@RabbitListener|RabbitTemplate|AmqpTemplate|@JmsListener|@SqsListener|rabbitmq|RabbitMQ'],
  ['6 async', 'in-process events', [JAVA, KT, CS, TS], '@EventListener|@TransactionalEventListener|ApplicationEventPublisher|IIntegrationEventHandler|EventEmitter'],
  ['6 async', 'scheduled jobs', [JAVA, KT, PY, TS, YML], '@Scheduled\\b|@XxlJob|cron:|@shared_task|celery|CronJob|Quartz|\\bJob\\b.*implements'],
  // 7 resilience
  ['7 resilience', 'fallbacks / breakers', [JAVA, KT, YML, CS, GO], '@CircuitBreaker|@HystrixCommand|resilience4j|Resilience4J|@SentinelResource|fallback|Polly|CircuitBreaker'],
  // 8 data
  ['8 data', 'entities', [JAVA, KT], '@Entity\\b|@TableName\\(|@Table\\('],
  ['8 data', 'migrations', ['*.sql', XML, YML, PY, CS], 'databaseChangeLog|changeSet|CREATE TABLE|ALTER TABLE|migrations\\.Migration|MigrationBuilder'],
  ['8 data', 'query mappers', [XML, JAVA, KT], '<mapper\\b|@Query\\(|@Select\\(|createQuery\\(|JdbcTemplate'],
  ['8 data', 'other models', [PY, TS, CS], 'models\\.Model\\b|@Entity\\(|DbContext|^model\\s+\\w+\\s*\\{'],
  ['8 data', 'search indexes', [JAVA, KT, PY, JSON_], '@Document\\(\\s*indexName|elasticsearch|opensearch'],
  // 9 caches and client state
  ['9 caches', 'server caches', [JAVA, KT, PY, CS, YML], '@Cacheable|@CacheEvict|RedisTemplate|StringRedisTemplate|IDistributedCache|cache\\.set\\('],
  ['9 caches', 'browser storage', [TS, JS, VUE], 'localStorage|sessionStorage|document\\.cookie|Cookies\\.(get|set)'],
  // 10 config and flags
  ['10 config', 'config bindings', [JAVA, KT], '@Value\\(\\s*"\\$\\{|@ConfigurationProperties'],
  ['10 config', 'external config server', [YML, PROPS, JAVA], 'spring\\.cloud\\.config|config\\.server|nacos\\.config|apollo\\.meta|configserver'],
  ['10 config', 'feature flags', [JAVA, KT, PY, TS, JS, CS, YML], 'unleash|launchdarkly|flagsmith|growthbook|togglz|ff4j|isFeatureEnabled|featureFlag|FeatureFlag|feature_flag|useFlag\\('],
  ['10 config', 'frontend env', [TS, JS, VUE], 'process\\.env\\.|import\\.meta\\.env'],
  // 11 dependencies and runtime
  ['11 deps', 'build manifests', ['pom.xml', 'build.gradle', 'build.gradle.kts', 'package.json', 'pyproject.toml', 'go.mod', '*.csproj'], '.'],
  ['11 deps', 'lockfiles', ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'go.sum', 'gradle.lockfile'], '.'],
  // 12 build and deploy
  ['12 deploy', 'containers / compose', ['Dockerfile', '*.Dockerfile', 'docker-compose*.yml', 'compose*.yaml'], '.'],
  ['12 deploy', 'kubernetes / helm', [YML], '^kind:\\s*(Deployment|StatefulSet|Service|Ingress)|apiVersion:\\s*v2'],
  // 13 UI composition
  ['13 UI', 'routers', [TS, JS, VUE], 'createRouter|new VueRouter|RouterModule\\.for(Root|Child)|\\$stateProvider|\\$routeProvider|createBrowserRouter|<Route\\b|path:\\s*[\'"`]/'],
  ['13 UI', 'component templates', [VUE, HTML, '*.tsx'], '.'],
  ['13 UI', 'form bindings / guards', [VUE, HTML, '*.tsx', TS], 'v-model|formControlName|\\[\\(ngModel\\)\\]|register\\(\\s*[\'"]|Validators\\.|:rules=|rules:\\s*\\{'],
  ['13 UI', 'stylesheets', ['*.{css,scss,less,sass}'], '.'],
  ['13 UI', 'i18n', [TS, JS, VUE, HTML, JSON_], '\\$t\\(|i18n|TranslateModule|translate\\(|useTranslation|jhiTranslate|t\\([\'"]\\w+\\.'],
  ['13 UI', 'client stores', [TS, JS, VUE], 'defineStore|createStore|new Vuex|@ngrx|createSlice|zustand|useStore\\('],
  ['13 UI', 'runtime-built UI (low-code)', [JAVA, TS, JS, VUE], 'onl_cgform|OnlCgform|form-create|formily|amis|DynamicForm|JsonSchemaForm|lowcode|low-code'],
  // 14 security
  ['14 security', 'security config', [JAVA, KT, YML, PY, CS], 'SecurityFilterChain|@EnableWebSecurity|HttpSecurity|WebSecurityConfigurerAdapter|AUTHENTICATION_BACKENDS|AddAuthentication|sa-token|shiro'],
  ['14 security', 'UI permission guards', [TS, JS, VUE, HTML], 'hasPermi|v-permission|v-auth|hasAuthority|hasAnyAuthority|canActivate|CanActivate|beforeEach\\(|isGranted|usePermission'],
  // 15 watchers outside the code path
  ['15 watchers', 'metrics in code', [JAVA, KT, PY, GO, CS, TS], 'MeterRegistry|Counter\\.builder|@Timed\\(|prometheus_client|promauto|Meter\\b.*Create'],
  ['15 watchers', 'dashboards / alert rules', [JSON_, YML], '"panels"\\s*:|^\\s*- alert:|^groups:'],
  ['15 watchers', 'emails / exports / webhooks', [JAVA, KT, PY, TS, CS, HTML], 'JavaMailSender|MimeMessage|send_mail|EmailService|XSSFWorkbook|EasyExcel|ExcelUtil|CSVPrinter|csv\\.writer|webhook|Webhook'],
  ['15 watchers', 'analytics events', [TS, JS, VUE], 'gtag\\(|analytics\\.track|posthog|mixpanel|segment\\.|dataLayer\\.push'],
];

// e2e suites are not a channel; they are a ground-truth source (see README)
export const ORACLES = [
  ['e2e', 'cypress / playwright / protractor', ['*.cy.{ts,js}', '*.spec.{ts,js}', '*.e2e.{ts,js}', 'cypress.config.*', 'playwright.config.*', 'protractor.conf.*'], 'cy\\.|page\\.goto|browser\\.get|test\\(|it\\('],
];

function filesMatching(repo, globs, re) {
  const args = ['-l', '--no-messages', '--max-filesize', '1M', '-g', '!node_modules', '-g', '!**/dist/**', '-g', '!**/build/**', '-g', '!**/target/**'];
  for (const g of globs) args.push('-g', g);
  args.push('-e', re, repo);
  try { return execFileSync('rg', args, { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean).length; }
  catch (e) { if (e.status === 1) return 0; throw e; }
}

export function inventory(repo) {
  const probes = PROBES.map(([channel, name, globs, re]) => ({ channel, name, files: filesMatching(repo, globs, re) }));
  const oracles = ORACLES.map(([kind, name, globs, re]) => ({ kind, name, files: filesMatching(repo, globs, re) }));
  const channels = {};
  for (const p of probes) if (!/files$/.test(p.name)) channels[p.channel] = (channels[p.channel] ?? 0) + p.files;
  return { probes, oracles, channels };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  const repos = readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory()).sort();
  const all = {};
  for (const r of repos) all[r] = inventory(join(dir, r));
  if (process.argv.includes('--json')) { console.log(JSON.stringify(all, null, 1)); process.exit(0); }
  const chans = [...new Set(PROBES.map((p) => p[0]))].filter((c) => c !== '1 code');
  console.log(['repo', 'files', ...chans.map((c) => c.split(' ')[0]), 'e2e'].join('\t'));
  for (const r of repos) {
    const v = all[r];
    const size = v.probes.filter((p) => /files$/.test(p.name)).reduce((a, p) => a + p.files, 0);
    console.log([r, size, ...chans.map((c) => v.channels[c] ?? 0), v.oracles[0].files].join('\t'));
  }
}
