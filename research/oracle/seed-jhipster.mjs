// Make every relationship in the JHipster sample observable. An impact on "the
// bank account shown on an operation" cannot be seen if no operation has one,
// and the generated fake data links none. Seeding is verified by reading back,
// because PATCH answered 200 and silently dropped the relationship.
//
//   node research/oracle/seed-jhipster.mjs <baseUrl>
const base = process.argv[2];
const auth = await (await fetch(`${base}/api/authenticate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }) })).json();
const H = { Authorization: `Bearer ${auth.id_token}`, 'Content-Type': 'application/json' };
for (let i = 1; i <= 5; i++) {
  const op = await (await fetch(`${base}/api/operations/${i}`, { headers: H })).json();
  op.bankAccount = { id: i };
  const r = await fetch(`${base}/api/operations/${i}`, { method: 'PUT', headers: H, body: JSON.stringify(op) });
  if (!r.ok) { console.error(`seed failed: PUT /api/operations/${i} → ${r.status}`); process.exit(2); }
}
const all = await (await fetch(`${base}/api/operations?eagerload=true&size=100`, { headers: H })).json();
const linked = all.filter((o) => o.bankAccount).length;
if (linked < 5) { console.error(`seed not visible on read-back: ${linked} linked`); process.exit(2); }
console.log(`seeded: ${linked} operations linked to bank accounts`);
