/*
 * Teslon — local interface.
 *
 * Every string that came out of a repository (paths, symbols, reasons) is put
 * on the page with textContent. Nothing here builds HTML from data: a file
 * named `<img src=x onerror=…>.ts` is a legal path, and this page can trigger
 * analyses on your machine. The server's CSP is the second line, not the first.
 */

const $ = (s, el = document) => el.querySelector(s);
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const SVG = 'http://www.w3.org/2000/svg';

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const TIERS = {
  1: { title: 'Test first', sub: 'Directly impacted' },
  2: { title: 'Test next', sub: 'Moderately impacted' },
  3: { title: 'Smoke', sub: 'Lightly impacted' },
  4: { title: 'Eyes on', sub: 'Could not be ruled out — not "unaffected"' },
};

// ---------------------------------------------------------------- motion ----

const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/** Count a numeral up to its value. It establishes scale before it is read. */
function countUp(el, to, { duration = 900, delay = 0, decimals = 0 } = {}) {
  const fmt = (v) => v.toFixed(decimals);
  if (reduce || to === 0) {
    el.textContent = fmt(to);
    return;
  }
  el.textContent = fmt(0);
  const start = performance.now() + delay;
  const tick = (now) => {
    const t = Math.max(0, Math.min(1, (now - start) / duration));
    el.textContent = fmt(to * easeOutExpo(t));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Bring elements in on a stagger. One hero first, support after. */
function stagger(els, { step = 50, delay = 0, cls = 'in' } = {}) {
  [...els].forEach((el, i) => {
    if (reduce) return el.classList.add(cls);
    el.style.setProperty('transition-delay', `${delay + i * step}ms`);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add(cls)));
  });
}

/** Run once, the first time an element is actually on screen. */
const onceSeen = (() => {
  const jobs = new WeakMap();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        jobs.get(e.target)?.();
      }
    },
    { rootMargin: '0px 0px -12% 0px' },
  );
  return (el, fn) => {
    if (reduce) return fn();
    jobs.set(el, fn);
    io.observe(el);
  };
})();

function toast(message) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.add('in');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('in'), 1800);
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { class: 'mono' }, text);
    ta.style.setProperty('position', 'fixed');
    ta.style.setProperty('opacity', '0');
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`${what} copied`);
}

// ----------------------------------------------------------------- theme ----

const THEMES = ['auto', 'dark', 'light'];
function getTheme() {
  try {
    return localStorage.getItem('teslon-theme') ?? 'auto';
  } catch {
    return 'auto';
  }
}
function applyTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  try {
    localStorage.setItem('teslon-theme', t);
  } catch {
    // Private windows refuse storage; the theme still applies for this visit.
  }
}

// ----------------------------------------------------------------- state ----

const state = { ctx: null, data: null, req: null };

function chrome({ where = '', actions = [], sections = null, verdict = null } = {}) {
  $('#where').textContent = where;
  $('#actions').replaceChildren(...actions);
  const nav = $('#subnav');
  if (sections) {
    nav.replaceChildren(
      ...sections.map(([id, name, count]) =>
        h('a', { href: `#${id}`, 'data-id': id }, name, count !== undefined ? h('span', { class: 'c' }, String(count)) : null),
      ),
    );
    nav.hidden = false;
  } else nav.hidden = true;
  const footer = $('#footer');
  if (verdict) {
    // Never dismissible — that is the point of it — but on a phone the full
    // sentence took a third of the screen, so it says the same thing shorter.
    $('#footer-inner').replaceChildren(
      h('b', {}, 'At least these'),
      h('span', { class: 'long' }, verdict.text),
      h('span', { class: 'short' }, verdict.short),
    );
    footer.hidden = false;
  } else footer.hidden = true;
}

function themeButton() {
  const label = { auto: 'Auto', dark: 'Dark', light: 'Light' };
  const b = h('button', { class: 'pill-btn line', type: 'button', title: 'Appearance' }, label[getTheme()]);
  b.addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(getTheme()) + 1) % THEMES.length];
    applyTheme(next);
    b.textContent = label[next];
  });
  return b;
}

// ------------------------------------------------------------------- run ----

function renderRun() {
  state.data = null;
  chrome({ where: state.ctx?.root ?? '', actions: [themeButton()] });
  const main = $('#main');
  window.scrollTo({ top: 0 });

  if (state.ctx && !state.ctx.git) {
    main.replaceChildren(
      h('section', { class: 'run' },
        h('h1', {}, 'No repository here.'),
        h('p', { class: 'sub' }, `${state.ctx.root} is not a git working tree. Start Teslon inside a checkout: `, h('code', { class: 'mono' }, 'teslon ui'), ' from the repository root.'),
      ),
    );
    return;
  }

  const branches = h('datalist', { id: 'branches' }, ...(state.ctx?.branches ?? []).map((b) => h('option', { value: b })));
  const base = h('input', { id: 'base', name: 'base', list: 'branches', autocomplete: 'off', spellcheck: 'false', placeholder: 'auto — origin/HEAD, main, master…' });
  const head = h('input', { id: 'head', name: 'head', list: 'branches', autocomplete: 'off', spellcheck: 'false', placeholder: state.ctx?.head ?? 'HEAD' });
  const go = h('button', { class: 'pill-btn primary', type: 'submit' }, 'Analyse');

  const form = h('form', { class: 'form rise', onsubmit: (e) => {
    e.preventDefault();
    const req = {};
    if (base.value.trim()) req.base = base.value.trim();
    req.head = head.value.trim() || state.ctx?.head || 'HEAD';
    analyse(req);
  } },
    h('div', { class: 'field' }, h('label', { class: 'label', for: 'base' }, 'Base branch'), base),
    h('div', { class: 'field' }, h('label', { class: 'label', for: 'head' }, 'Pull request branch'), head),
    go,
  );

  const headline = h('h1', {},
    ...['What can', 'this change', 'break?'].map((line) => [h('span', { class: 'mask' }, h('span', {}, line)), h('br')]),
  );

  const recent = (state.ctx?.recent ?? []).slice(0, 8);
  main.replaceChildren(
    h('section', { class: 'run' },
      h('div', { class: 'label rise' }, 'PR impact analysis · runs on this machine'),
      headline,
      h('p', { class: 'sub rise' }, 'Point at a pull request. Teslon reads it at its own commit — without touching your working tree — and tells you what to test first, why, who to ask, and how much of the answer to trust.'),
      branches,
      form,
      recent.length ? h('div', { class: 'or label rise' }, 'Or a change that already landed') : null,
      recent.length
        ? h('div', { class: 'recent' },
            ...recent.map((c) =>
              h('button', { type: 'button', class: 'rise', onclick: () => analyse({ sha: c.sha }) },
                h('span', { class: 'sha' }, c.sha),
                h('span', {}, c.subject),
                h('span', { class: 'go' }, 'Analyse →'),
              ),
            ),
          )
        : null,
    ),
  );

  stagger(main.querySelectorAll('.mask'), { step: 90, delay: 80 });
  stagger(main.querySelectorAll('.rise'), { step: 45, delay: 260 });
  setTimeout(() => head.focus({ preventScroll: true }), reduce ? 0 : 500);
}

// --------------------------------------------------------------- loading ----

function renderLoading(req) {
  const target = req.sha ? `commit ${req.sha}` : `${req.head}${req.base ? ` against ${req.base}` : ''}`;
  chrome({ where: target, actions: [themeButton()] });
  const secs = h('div', { class: 'num' }, '0.0');
  $('#main').replaceChildren(
    h('section', { class: 'loading' },
      h('div', { class: 'label' }, 'Reading'),
      h('h2', {}, target),
      secs,
      h('div', { class: 'bar', role: 'progressbar', 'aria-label': 'Analysing' }, h('i')),
      h('p', { class: 'dim' }, 'Checking the head out on its own, reading every signal, and writing down what it could not see. Seconds, measured — not a promise.'),
    ),
  );
  const t0 = performance.now();
  const tick = () => {
    if (!secs.isConnected) return;
    secs.textContent = ((performance.now() - t0) / 1000).toFixed(1);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function analyse(req) {
  state.req = req;
  renderLoading(req);
  let res;
  let body;
  try {
    res = await fetch('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
    body = await res.json();
  } catch {
    return renderError({ error: 'The Teslon server stopped answering. Is `teslon ui` still running?' });
  }
  if (!res.ok) return renderError(body);
  if (body.empty) return renderError({ title: 'Nothing changed', error: 'Those two refs point at the same code. There is nothing to analyse.' });
  state.data = body;
  renderReport(body);
}

function renderError(body) {
  chrome({ actions: [themeButton()] });
  $('#main').replaceChildren(
    h('section', { class: 'run' },
      h('div', { class: 'error-card rise' },
        h('h2', {}, body.title ?? 'Teslon stopped'),
        h('p', {}, body.error ?? 'Something went wrong.'),
        body.advice ? h('p', { class: 'dim' }, body.advice) : null,
        h('button', { class: 'pill-btn ink', type: 'button', onclick: renderRun }, 'Try another'),
      ),
    ),
  );
  stagger($('#main').querySelectorAll('.rise'));
}

// ---------------------------------------------------------------- report ----

function splitPath(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? ['', path] : [path.slice(0, i + 1), path.slice(i + 1)];
}

/** `index.ts` says nothing on its own — a repository has dozens. Show its folder. */
function shortName(path) {
  const parts = path.split('/');
  const base = parts.at(-1);
  return /^index\.|^__init__\.|^mod\./.test(base) && parts.length > 1 ? `${parts.at(-2)}/${base}` : base;
}

function pathEl(path, note) {
  const [dir, base] = splitPath(path);
  return h('div', { class: 'path' }, dir, h('b', {}, base), note ? h('small', {}, note) : null);
}

function testList(r) {
  const out = [`## Teslon — what to test`, `${r.change.baseSha.slice(0, 10)}…${r.change.headSha.slice(0, 10)}`, ''];
  for (const t of [1, 2, 3, 4]) {
    const rows = r.priority.filter((p) => p.tier === t);
    if (!rows.length) continue;
    out.push(`### Tier ${t} · ${TIERS[t].title} — ${TIERS[t].sub}`);
    for (const p of rows) {
      const why = p.because.filter((f) => f.points > 0).slice(0, 3).map((f) => f.detail).join('; ');
      out.push(`- [ ] \`${p.file}\` — ${why}`);
    }
    out.push('');
  }
  if (r.tests.length) {
    out.push('### Existing tests to run');
    for (const t of r.tests) out.push(`- [ ] \`${t.file}\``);
    out.push('');
  }
  out.push(`_${r.completeness.verdict}_`);
  return out.join('\n');
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderReport(data) {
  const r = data.result;
  const counts = [1, 2, 3, 4].map((t) => r.priority.filter((p) => p.tier === t).length);
  const changed = r.change.files.length;

  chrome({
    where: `${r.change.baseSha.slice(0, 8)} … ${r.change.headSha.slice(0, 8)}  ·  merge base ${r.change.mergeBase.slice(0, 8)}`,
    actions: [
      h('button', { class: 'pill-btn line', type: 'button', onclick: () => copy(r.brief.join('\n\n'), 'Brief') }, 'Copy brief'),
      h('button', { class: 'pill-btn line', type: 'button', onclick: () => copy(testList(r), 'Test list') }, 'Copy test list'),
      h('button', { class: 'pill-btn line', type: 'button', onclick: () => download('teslon-result.json', JSON.stringify(data, null, 2)) }, 'JSON'),
      themeButton(),
    ],
    sections: [
      ['overview', 'Overview'],
      ['test', 'What to test', r.priority.length],
      ['prove', 'Prove it', new Set(data.proofs.map((p) => [p.origin.file, ...p.steps.slice(0, -1).map((x) => x.file)].join('>'))).size],
      ['coverage', 'Coverage', r.surfaces.length + r.tests.length],
      ['people', 'Who & how much'],
      ['trust', 'Trust', `${r.completeness.signalsRun.length}/${r.completeness.signalsRun.length + r.completeness.signalsAbsent.length}`],
    ],
    verdict: {
      text: r.completeness.verdict,
      short: `${r.completeness.signalsRun.length}/${r.completeness.signalsRun.length + r.completeness.signalsAbsent.length} signals · ${plural(r.limitations.length, 'limitation')} — never "only these".`,
    },
  });

  const main = $('#main');
  main.replaceChildren(
    overview(r, counts, changed),
    whatToTest(r, data, counts),
    proveIt(r, data),
    coverage(r),
    people(r),
    trust(r),
  );
  window.scrollTo({ top: 0 });
  scrollSpy();

  // Choreography for the first screen: the numeral lands, the headline rises
  // under it, then the supporting facts.
  const big = $('.hero .big', main);
  countUp(big, r.radius.length, { duration: 1000 });
  stagger(main.querySelectorAll('.hero .mask'), { step: 90, delay: 160 });
  stagger(main.querySelectorAll('#overview .rise'), { step: 45, delay: 420 });
}

function overview(r, counts, changed) {
  const lead = counts[0] > 0 ? `${counts[0]} to test first.` : counts[1] > 0 ? `${counts[1]} to test next.` : 'Nothing in Tier 1.';
  const lines = [`${changed} changed.`, lead];
  const breaking = r.priority.filter((p) => p.because.some((f) => f.factor === 'breaking change')).length;
  if (breaking) lines.push(`${breaking} breaking.`);

  return h('section', { class: 'block', id: 'overview' },
    h('div', { class: 'hero' },
      h('div', {},
        h('div', { class: 'num big' }, String(r.radius.length)),
        h('div', { class: 'label big-label rise' }, 'Files in the blast radius'),
      ),
      h('div', {},
        h('h1', {}, ...lines.map((l) => [h('span', { class: 'mask' }, h('span', {}, l)), h('br')])),
        r.change.readFrom ? h('p', { class: 'readfrom rise' }, r.change.readFrom) : null,
        h('div', { class: 'meta-row rise' },
          ...[
            ['Base', r.change.baseSha.slice(0, 10)],
            ['Head', r.change.headSha.slice(0, 10)],
            ['Merge base', r.change.mergeBase.slice(0, 10)],
            r.change.recoveredFrom ? ['Recovered from', r.change.recoveredFrom] : null,
            ['Schema', r.schemaVersion],
          ].filter(Boolean).map(([k, v]) => h('div', {}, h('span', { class: 'label' }, k), h('span', { class: 'v' }, v))),
        ),
      ),
    ),
    h('div', { class: 'brief' },
      ...r.brief
        .filter((line) => line !== r.change.readFrom)
        .map((line, i) =>
          h('p', { class: `rise ${i === 0 ? 'lead' : ''} ${/breaking|coverage gap|no test|no existing test|will fail|no declared owner/i.test(line) ? 'warn' : ''}` }, line),
        ),
    ),
  );
}

// -------------------------------------------------------- what to test ----

function whatToTest(r, data, counts) {
  const radius = new Map(r.radius.map((x) => [x.file, x]));
  const diffs = new Map(data.diffs.map((d) => [d.file, d]));
  const active = new Set([1, 2, 3, 4]);
  const most = Math.max(1, ...counts);

  const statEls = [1, 2, 3, 4].map((t) => {
    const num = h('div', { class: 'num' }, '0');
    const fill = h('div', { class: 'fill' });
    const el = h('button', { class: `stat t${t}`, type: 'button', 'aria-pressed': 'true', title: `Show or hide Tier ${t}` },
      num,
      h('div', { class: 'track' }, fill),
      h('div', { class: 'what' }, h('b', {}, TIERS[t].title), TIERS[t].sub),
    );
    el.addEventListener('click', () => {
      if (active.has(t) && active.size > 1) active.delete(t);
      else active.add(t);
      for (const [i, s] of statEls.entries()) s.el.setAttribute('aria-pressed', String(active.has(i + 1)));
      for (const g of groups) g.el.hidden = !active.has(g.t);
    });
    return { el, num, fill, t };
  });

  const groups = [1, 2, 3, 4].map((t) => {
    const rows = r.priority.filter((p) => p.tier === t);
    const el = h('div', { class: `tier t${t}` });
    if (!rows.length) {
      el.hidden = true;
      return { el, t };
    }
    el.append(h('div', { class: 'tier-head' }, h('span', { class: 'num' }, String(rows.length)), h('span', { class: 'label' }, `Tier ${t} · ${TIERS[t].title} — ${TIERS[t].sub}`)));
    const CAP = 150;
    const draw = (list) => list.map((p) => row(p, radius.get(p.file), diffs.get(p.file)));
    el.append(...draw(rows.slice(0, CAP)));
    if (rows.length > CAP) {
      const more = h('button', { class: 'pill-btn line', type: 'button' }, `Show all ${rows.length}`);
      more.addEventListener('click', () => {
        more.replaceWith(...draw(rows.slice(CAP)));
      });
      el.append(h('div', { class: 'rows' }, more));
    }
    return { el, t };
  });

  const section = h('section', { class: 'block', id: 'test' },
    h('div', { class: 'block-head' },
      h('div', {}, h('span', { class: 'label' }, 'Testing order'), h('h2', {}, 'What to test')),
      h('p', {}, 'Ordered by what to open first, not by how sure Teslon is. A possible change to an untested payment endpoint outranks a certain change to a well-covered helper. Every score below is the sum of its named reasons — open a row to see them.'),
    ),
    h('div', { class: 'stats' }, ...statEls.map((s) => s.el)),
    h('div', { class: 'rows' }, ...groups.map((g) => g.el)),
  );

  onceSeen(section, () => {
    statEls.forEach((s, i) => {
      countUp(s.num, counts[i], { duration: 800, delay: i * 90 });
      setTimeout(() => s.fill.style.setProperty('width', `${(counts[i] / most) * 100}%`), reduce ? 0 : 120 + i * 90);
    });
    stagger([...section.querySelectorAll('.row')].slice(0, 14), { step: 28, delay: 240 });
    for (const el of [...section.querySelectorAll('.row')].slice(14)) el.classList.add('in');
  });
  return section;
}

function row(p, rad, diff) {
  const tags = [];
  if (p.band === 'unknown') tags.push(h('span', { class: 'chip unknown', title: 'Teslon could not analyse this connection, so it is kept rather than guessed away' }, 'Could not analyse'));
  if (p.because.some((f) => f.factor === 'breaking change')) tags.push(h('span', { class: 'chip none' }, 'Breaking'));
  if (p.because.some((f) => f.factor === 'new code')) tags.push(h('span', { class: 'chip new' }, 'New'));
  if (p.ownerSource === 'none') tags.push(h('span', { class: 'chip', title: 'Nothing in CODEOWNERS covers this file and no git history was found' }, 'No owner'));
  else for (const o of p.owners.slice(0, 2)) tags.push(h('span', { class: 'chip owner', title: p.ownerSource === 'CODEOWNERS' ? 'Declared in CODEOWNERS' : 'Inferred from recent git history' }, o));

  const first = p.because.find((f) => f.points > 0 && f.factor !== 'confidence' && f.factor !== 'proximity') ?? p.because[0];
  const positive = p.because.filter((f) => f.points > 0);
  const stack = h('div', { class: 'stack', 'aria-hidden': 'true' },
    ...positive.map((f) => {
      const seg = h('i', { title: `+${f.points} ${f.factor}` });
      seg.style.setProperty('flex', String(f.points));
      return seg;
    }),
  );
  const factors = h('ol', { class: 'factors' },
    ...p.because.map((f) =>
      h('li', { class: f.factor === 'floor' ? 'floor' : '' }, h('b', {}, f.points ? `+${f.points}` : '·'), h('span', {}, h('em', {}, f.factor), f.detail)),
    ),
  );

  const changes = diff?.changes ?? [];
  const body = h('div', { class: 'body' },
    h('div', { class: 'label' }, `Score ${p.score} — every point accounted for`),
    stack,
    factors,
    rad?.why?.length
      ? h('div', { class: 'why' },
          h('div', { class: 'label' }, 'Why it is in the radius'),
          ...rad.why.slice(0, 6).map((w) => h('div', {}, h('code', {}, w.signal), ' — ', w.detail)),
          rad.why.length > 6 ? h('div', {}, `…and ${rad.why.length - 6} more reasons`) : null,
        )
      : null,
    changes.length
      ? h('div', { class: 'why' },
          h('div', { class: 'label' }, 'What changed about its behaviour'),
          ...changes.slice(0, 8).map((c) => h('div', {}, h('code', {}, c.severity), ' — ', c.what, c.test ? ` → test ${c.test}` : '')),
        )
      : null,
  );

  const el = h('details', { class: `row rise t${p.tier}` },
    h('summary', {}, h('span', { class: 'score' }, String(p.score)), pathEl(p.file, first?.detail), h('span', { class: 'tags' }, ...tags)),
    body,
  );
  // The motion here is the argument: the score assembles itself from its
  // reasons, left to right, in the order they were counted.
  el.addEventListener('toggle', () => {
    if (!el.open) {
      stack.classList.remove('in');
      factors.classList.remove('in');
      return;
    }
    [...stack.children].forEach((seg, i) => seg.style.setProperty('transition-delay', reduce ? '0ms' : `${i * 70}ms`));
    [...factors.children].forEach((li, i) => li.style.setProperty('transition-delay', reduce ? '0ms' : `${120 + i * 55}ms`));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      stack.classList.add('in');
      factors.classList.add('in');
    }));
  });
  return el;
}

// --------------------------------------------------------------- prove it ----

function link(kind) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 76 26');
  svg.setAttribute('preserveAspectRatio', 'none');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'M4 13 H66 M60 7 L67 13 L60 19');
  svg.append(path);
  return h('span', { class: 'link', 'aria-label': `imports, ${kind}` }, svg, h('span', {}, kind));
}

function proveIt(r, data) {
  const proofs = data.proofs;
  const section = h('section', { class: 'block', id: 'prove' },
    h('div', { class: 'block-head' },
      h('div', {}, h('span', { class: 'label' }, 'Method-level proof'), h('h2', {}, 'Prove it')),
      h('p', {}, 'Each route is one complete argument: changed symbols, and every import that carries them to another file. Paths, not a graph — a graph of two thousand nodes is a hairball; a route is read once, start to finish.'),
    ),
  );

  if (!proofs.length) {
    section.append(
      h('p', { class: 'dim' },
        'No symbol-level chain left the changed files. That happens when a change exports nothing, when every dependent reaches it through a signal other than a named import (a shared name, a config route, a Java package), or when nothing depends on it. The reasons for each file are in What to test.',
      ),
    );
    return section;
  }

  // Many symbols travel the same road — every export of a barrel reaches the
  // same consumers the same way. Showing each one as its own chain made the
  // reader read one route forty times. A route is shown once, with every
  // symbol that takes it.
  // Then routes that share everything but their last file are one road
  // with several exits, so they are drawn as a fan: the shared path once,
  // and every place it arrives stacked at the end.
  const routes = new Map();
  for (const p of proofs) {
    const via = p.steps.slice(0, -1);
    const last = p.steps.at(-1);
    const key = [p.origin.file, ...via.map((s) => `${s.kind}>${s.file}`), `${last?.kind}`].join('\u0000');
    const r0 = routes.get(key) ?? { origin: p.origin.file, via, kind: last?.kind, ends: new Set(), symbols: new Set(), exact: true, chains: 0 };
    if (last) r0.ends.add(last.file);
    r0.symbols.add(p.origin.symbol);
    r0.exact = r0.exact && p.exact;
    r0.chains++;
    routes.set(key, r0);
  }
  const ordered = [...routes.values()].sort((a, b) => b.ends.size - a.ends.size || b.via.length - a.via.length || b.symbols.size - a.symbols.size);
  const CAP = 40;

  const list = h('div', { class: 'proofs' });
  for (const route of ordered.slice(0, CAP)) {
    const syms = [...route.symbols];
    const ends = [...route.ends].sort();
    const chain = h('div', { class: 'chain' }, h('span', { class: 'node origin', title: route.origin }, shortName(route.origin)));
    for (const s of route.via) chain.append(link(s.kind), h('span', { class: 'node', title: s.file }, shortName(s.file)));
    if (ends.length) {
      chain.append(link(route.kind));
      const shown = ends.slice(0, 8);
      chain.append(
        h('span', { class: `fan ${ends.length > 1 ? 'many' : ''}` },
          ...shown.map((f) => h('span', { class: 'node end', title: f }, shortName(f))),
          ends.length > shown.length ? h('span', { class: 'node more' }, `+${ends.length - shown.length} more`) : null,
        ),
      );
    }
    const el = h('div', { class: 'proof' },
      h('div', { class: 'proof-head' },
        h('div', {},
          h('span', { class: 'sym' }, syms.length === 1 ? syms[0] : plural(syms.length, 'symbol')),
          ends.length > 1 ? h('span', { class: 'fan-count' }, ` → ${plural(ends.length, 'file')}`) : null,
          syms.length > 1 ? h('div', { class: 'syms' }, ...syms.slice(0, 12).map((x) => h('code', {}, x)), syms.length > 12 ? h('span', { class: 'dim' }, `+${syms.length - 12}`) : null) : null,
        ),
        h('span', { class: `chip ${route.exact ? 'solid' : 'partial'}`, title: route.exact ? 'Every hop names the symbol' : 'At least one hop imports the whole module, so from there the path is file-level' }, route.exact ? 'Exact at every hop' : 'File-level after a hop'),
      ),
      chain,
    );
    // Impact travels hop by hop, so the chain draws hop by hop; the exits of
    // a fan arrive together, because they are reached at the same distance.
    onceSeen(el, () => {
      const parts = [...chain.children];
      parts.forEach((c, i) => {
        const go = () => {
          c.classList.add('on');
          if (c.classList.contains('fan')) [...c.children].forEach((n, j) => setTimeout(() => n.classList.add('on'), reduce ? 0 : j * 45));
        };
        if (reduce) return go();
        setTimeout(go, i * 110);
      });
    });
    list.append(el);
  }
  section.append(
    h('p', { class: 'dim routes-note' }, `${plural(proofs.length, 'chain')}, read as ${plural(routes.size, 'route')}.${routes.size > CAP ? ` Showing the ${CAP} widest; the rest are in the JSON.` : ''}`),
    list,
  );
  return section;
}

// --------------------------------------------------------------- coverage ----

function coverage(r) {
  const section = h('section', { class: 'block', id: 'coverage' },
    h('div', { class: 'block-head' },
      h('div', {}, h('span', { class: 'label' }, 'API · UI · data · jobs'), h('h2', {}, 'Coverage')),
      h('p', {}, 'Solid means a test reaches it directly. Outlined means only as a side effect of testing something else. Red means nothing in this repository reaches it at all — start there.'),
    ),
  );

  if (r.tests.length) {
    section.append(
      h('div', { class: 'label' }, `Existing tests that touch this change · ${r.tests.length}`),
      h('ul', { class: 'owners' },
        ...r.tests.map((t) =>
          h('li', { class: 'rise' },
            pathEl(t.file),
            h('span', { class: `chip ${t.coversDirectly.length ? 'solid' : 'partial'}` }, t.coversDirectly.length ? `Covers ${t.coversDirectly.length} directly` : `Side effect only`),
            h('span', { class: 'src' }, `Tier ${t.highestTierCovered}`),
          ),
        ),
      ),
    );
  } else {
    section.append(h('p', { class: 'dim' }, 'No existing test in this repository reaches any changed file, directly or indirectly.'));
  }

  if (r.surfaces.length) {
    section.append(
      h('div', { class: 'label', style: { 'margin-top': '48px', display: 'block', 'margin-bottom': '16px' } }, `What a person can open · ${r.surfaces.length}`),
      h('div', { class: 'cov' },
        ...r.surfaces.map((s) => {
          const state = s.directTests.length ? 'solid' : s.indirectTests.length ? 'partial' : 'none';
          const label = { solid: `${plural(s.directTests.length, 'direct test')}`, partial: 'Indirect only', none: 'No test' }[state];
          const tests = [...s.directTests, ...s.indirectTests];
          return h('div', { class: 'surface rise' },
            h('div', { class: 'kind' }, h('span', { class: 'label' }, s.kind), h('span', {}, s.isNew ? h('span', { class: 'chip new' }, 'New') : null, ' ', h('span', { class: `chip ${state}` }, label))),
            h('div', { class: `id ${/[/{}]|\./.test(s.id) && s.kind !== 'endpoint' ? 'code' : ''}` }, s.id),
            s.file ? h('div', { class: 'tests' }, h('code', {}, s.file)) : null,
            tests.length ? h('div', { class: 'tests' }, ...tests.slice(0, 3).map((t) => h('code', {}, t))) : null,
          );
        }),
      ),
    );
  }

  if (r.gaps.length) {
    section.append(
      h('div', { class: 'limits' },
        h('div', { class: 'label' }, `Coverage gaps · ${r.gaps.length}`),
        ...r.gaps.map((g) => h('div', { class: 'limit rise' }, h('div', { class: 'w mono' }, g.file), h('div', { class: 'm' }, g.reason))),
      ),
    );
  }

  onceSeen(section, () => stagger(section.querySelectorAll('.rise'), { step: 30 }));
  return section;
}

// ---------------------------------------------------------- people & effort ----

function people(r) {
  const e = r.effort;
  const big = h('div', { class: 'num effort-big' }, '0');
  const section = h('section', { class: 'block', id: 'people' },
    h('div', { class: 'block-head' },
      h('div', {}, h('span', { class: 'label' }, 'For the lead and the manager'), h('h2', {}, 'Who & how much')),
      h('p', {}, 'Effort is counted in cases and never converted to hours: velocity and familiarity are not in the repository, and an invented duration is the number that gets quoted in a planning meeting.'),
    ),
    h('div', { class: 'split' },
      h('div', {},
        big,
        h('div', { class: 'label' }, 'Test cases, minimum'),
        h('ol', { class: 'lines' },
          ...e.lines.map((l) =>
            h('li', { class: 'rise' },
              h('span', { class: 'num' }, String(l.cases)),
              h('span', {}, l.reason, h('small', {}, l.examples.join(' · '))),
            ),
          ),
        ),
        h('p', { class: 'dim' }, e.note),
      ),
      h('div', {},
        h('div', { class: 'label', style: { display: 'block', 'margin-bottom': '16px' } }, 'Who to ask, worst tier first'),
        r.ownership.length
          ? h('ul', { class: 'owners' },
              ...r.ownership.map((o) =>
                h('li', { class: `rise t${o.topTier}` },
                  h('span', { class: 'who' }, o.owner),
                  h('span', { class: 'src' }, `${plural(o.files, 'file')} · ${o.source === 'CODEOWNERS' ? 'declared' : o.source === 'git-history' ? 'from git history' : 'nobody declared'}`),
                  h('span', { class: 'chip', style: { color: 'var(--tc)', 'box-shadow': 'inset 0 0 0 1.5px var(--tc)' } }, `Tier ${o.topTier}`),
                ),
              ),
            )
          : h('p', { class: 'dim' }, 'No ownership information was found.'),
      ),
    ),
  );
  onceSeen(section, () => {
    countUp(big, e.minimumCases, { duration: 900 });
    stagger(section.querySelectorAll('.rise'), { step: 40, delay: 200 });
  });
  return section;
}

// ------------------------------------------------------------------ trust ----

function trust(r) {
  const c = r.completeness;
  const total = Math.max(1, r.radius.length);
  const run = [...c.signalsRun].sort((a, b) => b.filesAdded - a.filesAdded || b.edges - a.edges);
  const bars = [];

  const section = h('section', { class: 'block', id: 'trust' },
    h('div', { class: 'block-head' },
      h('div', {}, h('span', { class: 'label' }, 'How much of this to believe'), h('h2', {}, 'Trust')),
      h('p', {}, 'The dangerous failure of an impact analyser is not being wrong — it is being confidently incomplete. So the result reports what it could not see, and which signals actually earned their place.'),
    ),
    h('div', { class: 'verdict-big' },
      h('span', { class: 'num' }, `${c.signalsRun.length}/${c.signalsRun.length + c.signalsAbsent.length}`),
      h('span', {}, 'signals contributed'),
    ),
    h('p', { class: 'verdict-text' }, c.verdict),
    h('div', { class: 'legend' },
      h('span', {}, h('i', { style: { background: 'var(--ink)' } }), 'Files only this signal found'),
      h('span', {}, h('i', { style: { background: 'var(--line-2)' } }), 'Files it touched at all (edges, capped at the radius)'),
    ),
    h('div', { class: 'signals' },
      ...run.map((s) => {
        const e = h('div', { class: 'e' });
        const u = h('div', { class: 'u' });
        bars.push([e, Math.min(1, s.edges / total), u, s.filesAdded < 0 ? 0 : s.filesAdded / total]);
        return h('div', { class: 'sig rise' },
          h('span', { class: 'n' }, s.signal),
          h('div', { class: 'track' }, e, u),
          h('span', { class: 'v' }, s.filesAdded < 0 ? `${plural(s.edges, 'edge')} · not measured` : `${s.filesAdded} unique · ${plural(s.edges, 'edge')}`),
        );
      }),
      ...c.signalsAbsent.map((s) =>
        h('div', { class: 'sig off rise' }, h('span', { class: 'n' }, s.signal), h('span', { class: 'why' }, s.why)),
      ),
    ),
    c.unreadable.length
      ? h('div', { class: 'limits' },
          h('div', { class: 'label' }, `Files no signal can read · ${c.unreadable.length}`),
          h('div', { class: 'limit' }, h('div', { class: 'm mono' }, c.unreadable.slice(0, 20).join('  ·  ') + (c.unreadable.length > 20 ? '  …' : ''))),
        )
      : null,
    r.limitations.length
      ? h('div', { class: 'limits' },
          h('div', { class: 'label' }, `Limitations · each one widened the radius, none narrowed it · ${r.limitations.length}`),
          ...r.limitations.map((l) => h('div', { class: 'limit rise' }, h('div', { class: 'w' }, l.what), h('div', { class: 'm' }, l.mitigation))),
        )
      : null,
  );

  onceSeen(section, () => {
    stagger(section.querySelectorAll('.rise'), { step: 25 });
    bars.forEach(([e, ew, u, uw], i) => {
      setTimeout(() => {
        e.style.setProperty('width', `${ew * 100}%`);
        u.style.setProperty('width', `${uw * 100}%`);
      }, reduce ? 0 : 150 + i * 60);
    });
  });
  return section;
}

// ------------------------------------------------------------ scroll spy ----

function scrollSpy() {
  const links = [...document.querySelectorAll('#subnav a')];
  const spy = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        for (const a of links) a.setAttribute('aria-current', String(a.dataset.id === e.target.id));
      }
    },
    { rootMargin: '-35% 0px -60% 0px' },
  );
  for (const s of document.querySelectorAll('section.block')) spy.observe(s);
}

// ------------------------------------------------------------------- boot ----

applyTheme(getTheme());
$('#home').addEventListener('click', renderRun);
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/input|textarea/i.test(document.activeElement?.tagName ?? '') && !state.data) {
    e.preventDefault();
    $('#head')?.focus();
  }
});

try {
  state.ctx = await (await fetch('/api/context')).json();
} catch {
  state.ctx = null;
}

// A link like /?head=feature-x&base=main opens straight onto a result, so the
// CLI can hand a reviewer a URL instead of instructions.
const params = new URLSearchParams(location.search);
if (params.get('sha')) analyse({ sha: params.get('sha') });
else if (params.get('head')) analyse({ head: params.get('head'), ...(params.get('base') ? { base: params.get('base') } : {}) });
else renderRun();
