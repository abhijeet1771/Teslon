# Spikes behind research/ADOPTION.md

Install the candidates in a directory of their own, then pass its path:

```
mkdir -p /tmp/spike && (cd /tmp/spike && npm init -y >/dev/null && \
  npm i @vue/compiler-sfc@3 @vue/compiler-dom@3 @angular/compiler@20 @prometheus-io/lezer-promql @lezer/lr @lezer/highlight)
npm run build   # the Vue spike compares with the engine's own reader

node research/spikes/vue-spike.mjs    /tmp/spike <spm clone> <jhipster-sample-app-vuejs clone>
node research/spikes/ng-spike.mjs     /tmp/spike <jhipster-sample-app clone>
node research/spikes/promql-spike.mjs /tmp/spike <spm clone>
```

The smart-doc + oasdiff spike was run by hand:

1. Put a `src/main/resources/default.json` with `{"outPath": "target/smart-doc", "openApiAllInOne": true}` in the module.
2. Run `mvn -DskipTests com.ly.smart-doc:smart-doc-maven-plugin:3.1.1:openapi` at the base and at the head.
3. Run `oasdiff breaking base.json head.json`. To install oasdiff: `go install github.com/oasdiff/oasdiff@latest`.
