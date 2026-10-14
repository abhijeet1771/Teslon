// Can an input on the Add Pet form reach the server? Run in a real browser,
// with the page's own bindings (PetFormPage.js:45,89,99,105,119) on the Vue
// version the app ships. A claim about what QA can trigger is checked here
// before it is written down — the first draft of IMPACT-ATLAS got this wrong.
//
//   npm pack vue@3.5.17 && tar xzf vue-3.5.17.tgz && cp package/dist/vue.global.prod.js research/form-guard/vue.js
//   node research/form-guard/check.mjs
import { chromium } from 'playwright';

const page = new URL('./page.html', import.meta.url);
const b = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH ? { executablePath: `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium` } : {});
const p = await b.newPage();
const cases = [
  { name: '   ', date: '2020-01-01', submit: 'click', label: 'name = three spaces, click Submit' },
  { name: '   ', date: '2020-01-01', submit: 'enter', label: 'name = three spaces, press Enter' },
  { name: 'Rex', date: '2030-01-01', submit: 'click', label: 'birth date in the future' },
];
for (const c of cases) {
  await p.goto(page.href);
  await p.fill('#pet-birth-date', c.date);
  await p.click('#pet-name'); await p.keyboard.type(c.name);
  if (c.submit === 'click') await p.click('#go'); else await p.keyboard.press('Enter');
  const sent = await p.evaluate(() => window.sent);
  console.log(`${c.label.padEnd(36)} reaches the server: ${sent.length ? 'yes ' + JSON.stringify(sent) : 'no'}`);
}
await b.close();
