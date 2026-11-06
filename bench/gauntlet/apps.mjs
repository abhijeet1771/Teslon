/** Where each fixture's compiled classes, sources and settings are, for the oracle. */
import { join } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { screensFor } from './front-edge.mjs';
export function appConfig(app, built) {
  // built: a directory holding the fixture after `mvn compile` (see build.sh)
  if (app === 'orderdesk') return { app, fixture: 'fixtures/orderdesk', modules: [{ name: 'orderdesk', dir: '', classDir: join(built, 'target/classes'), srcRoot: 'src/main/java', yml: join(built, 'src/main/resources/application.yml') }], screens: screensFor(app) };
  const mods = readdirSync(built).filter((d) => existsSync(join(built, d, 'pom.xml')));
  return { app, fixture: 'fixtures/shopflow', modules: mods.map((d) => ({ name: d, dir: d, classDir: join(built, d, 'target/classes'), srcRoot: `${d}/src/main/java`, yml: join(built, d, 'src/main/resources/application.yml') })), screens: screensFor(app) };
}
