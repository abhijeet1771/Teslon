import type { Snapshot } from './snapshot.js';
import { readVue, type FrontendFacts } from './vue.js';
import { readAngular } from './angular.js';

/** Every front end in the repository this build reads, as one set of facts. */
export function readFrontend(snap: Snapshot): FrontendFacts {
  const v = readVue(snap);
  const a = readAngular(snap);
  if (!a) return v;
  return {
    routes: [...v.routes, ...a.routes],
    calls: [...v.calls, ...a.calls],
    components: new Map([...v.components, ...a.components]),
    globals: [...v.globals, ...a.globals],
    files: [...new Set([...v.files, ...a.files])],
    unread: v.unread.filter((u) => u.framework !== 'Angular'),
    ...(a.shell ? { shell: a.shell } : {}),
    ...(a.memberCalls ? { memberCalls: a.memberCalls } : {}),
    ...(v.guards ? { guards: v.guards } : {}),
  };
}
