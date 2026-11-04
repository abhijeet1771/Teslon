import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileKind, noAppEffect } from '../dist/engine/kinds.js';

test('only what the app never reads is "no app effect": served images, help pages and start scripts are not', () => {
  const k = (p) => fileKind(p);
  // documentation
  for (const p of ['README.md', 'docs/setup.md', 'docs/img/flow.png', 'logo.png', '.github/screenshot.png', 'services/billing/README.md', 'CHANGELOG.md']) assert.equal(k(p), 'docs', p);
  // what the app serves or shows
  for (const p of ['public/logo.svg', 'src/assets/icons/cart.png', 'src/main/webapp/content/logo.svg', 'static/fonts/inter.woff2', 'app/images/hero.webp']) assert.equal(k(p), 'asset', p);
  for (const p of ['src/assets/help/returns.md', 'public/robots.txt', 'src/main/resources/templates/mail.txt']) assert.notEqual(k(p), 'docs', p);
  // scripts: how the app starts is deployment; lint and setup are tooling; anything else is not known
  for (const p of ['docker-entrypoint.sh', 'bin/start.sh', 'scripts/migrate-db.sh', 'ops/backup.sh']) assert.equal(k(p), 'deploy', p);
  for (const p of ['scripts/lint.sh', 'scripts/setup-dev.sh', 'tools/format.ps1']) assert.equal(k(p), 'tooling', p);
  for (const p of ['scripts/fix_totals.sh', 'scripts/reconcile.sh', 'scripts/agent.sh', 'scripts/devices.sh']) assert.equal(k(p), 'other', p);
  // and only documentation, CI and tooling are ever called no app effect
  for (const kind of ['asset', 'deploy', 'other', 'frontend', 'java', 'config']) assert.equal(noAppEffect(kind), null, kind);
});
