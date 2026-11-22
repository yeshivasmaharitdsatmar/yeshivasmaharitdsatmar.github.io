// YG Fund – SMS bot (Supabase Edge Function "sms").
// The owner texts from a basic (kosher) phone; this answers with donor info and adds to-dos.
// Works with Textillion (JSON webhook with an HMAC signature, reply through the Textillion REST API), Telnyx (JSON
// webhook, reply through the Telnyx API) or Twilio (form webhook, TwiML reply).
// Only team members whose phone is saved in table `team` get an answer.
//
// Secrets (Supabase > Edge Functions > Secrets), never in the repo:
//   Textillion: TEXTILLION_API_KEY (tx_live_…, scope messages:send), TEXTILLION_WEBHOOK_SECRET (the webhook's signing secret)
//   Telnyx: TELNYX_API_KEY, TELNYX_PUBLIC_KEY      Twilio: TWILIO_AUTH_TOKEN
// Deploy with "Verify JWT" OFF (the phone company cannot send a Supabase login).

const ENV = (k: string) => (globalThis as any).Deno?.env.get(k) || (globalThis as any).process?.env?.[k] || '';
const SB_URL = () => ENV('SUPABASE_URL');
const SB_KEY = () => ENV('SUPABASE_SERVICE_ROLE_KEY') || ENV('SB_SECRET_KEY');
const TZ = 'America/New_York';
const MAX_REPLY = 480;   // ~7 Hebrew SMS parts

// ---------- small helpers ----------
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parse = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const todayS = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (s: string, n: number) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const addMonths = (s: string, n: number) => { const d = parse(s); const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + n); const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); d.setDate(Math.min(day, last)); return iso(d); };
const validD = (s: string) => !!s && s >= '1990-01-01' && s <= '2100-01-01';
const money = (n: number) => { const v = Math.round(Number(n || 0) * 100) / 100, c = Math.round(Math.abs(v) * 100) % 100 !== 0; return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: c ? 2 : 0, maximumFractionDigits: 2 }); };   // cents shown when there are any
const shortD = (s: string) => { if (!s) return '—'; const [y, m, d] = s.split('-'); return +m + '/' + +d + '/' + y.slice(2); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const digits10 = (p: string) => String(p || '').replace(/\D/g, '').slice(-10);
const FREQM: Record<string, number> = { m1: 1, m3: 3, m6: 6, m12: 12 };
const hebFmt = new Intl.DateTimeFormat('en-u-ca-hebrew', { month: 'long', day: 'numeric' });
const YT = [['Elul', 1], ['Kislev', 10], ['Adar', 1], ['Adar II', 1], ['Nisan', 1]];
function nextYomTov(from: string) {
  const d = parse(addDays(from, 14));
  for (let i = 0; i < 400; i++) {
    const p = hebFmt.formatToParts(d), mo = (p.find(x => x.type === 'month') || {} as any).value, dy = +(p.find(x => x.type === 'day') || {} as any).value;
    if (YT.some(t => t[0] === mo && t[1] === dy)) return iso(d);
    d.setDate(d.getDate() + 1);
  }
  return addMonths(from, 3);
}
const addFreq = (s: string, f: string) => f === 'yt' ? nextYomTov(s) : (FREQM[f] ? addMonths(s, FREQM[f]) : null);

// ---------- Supabase REST (service key; this runs on the server only) ----------
function sbHeaders(extra: Record<string, string> = {}) {
  const k = SB_KEY(), h: Record<string, string> = { apikey: k, ...extra };
  if (!k.startsWith('sb_')) h.Authorization = 'Bearer ' + k;   // legacy JWT key
  return h;
}
async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(SB_URL() + path, { ...init, headers: sbHeaders((init.headers || {}) as Record<string, string>) });
  if (!r.ok) throw new Error(path + ' ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r;
}

// ---------- data cache (kept while the function stays warm) ----------
const C: any = { jlsVer: -1, JD: null, IDX: null, lastId: 0, S: { acct: {}, task: {}, call: {}, hist: {}, shul: {}, settings: { s: { defFreq: 'm12', maxYears: 5 } } } };
async function load() {
  const meta = await (await rest('/rest/v1/jls_meta?id=eq.1&select=version')).json();
  const ver = meta[0] ? meta[0].version : 0;
  if (ver && ver !== C.jlsVer) {
    const blob = await (await rest('/storage/v1/object/jls/jls.json.gz')).blob();
    const txt = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
    C.JD = JSON.parse(txt); C.jlsVer = ver; buildIndex();
  }
  for (let g = 0; g < 200; g++) {
    const rows = await (await rest('/rest/v1/events?select=id,k,eid,p,by,at&id=gt.' + C.lastId + '&order=id.asc&limit=1000')).json();
    for (const r of rows) {
      if (!C.S[r.k]) continue;
      const cur = C.S[r.k][r.eid] || (C.S[r.k][r.eid] = {});
      Object.assign(cur, r.p);
      if (r.k === 'hist') { if (!cur.at) { cur.by = r.by; cur.at = r.at; } if (r.p && r.p.del) delete C.S.hist[r.eid]; }
    }
    if (rows.length) C.lastId = rows[rows.length - 1].id;
    if (rows.length < 1000) break;
  }
}
function buildIndex() {
  const by = new Map(), yg = new Map(), pl = new Map(), today = todayS();
  const prank = (d: string) => { d = (d || '').toLowerCase(); if (/cel|mobile|סעל/.test(d)) return /mother|wife|מאמע/.test(d) ? 1 : 0; if (/home|היים/.test(d)) return 2; return 3; };
  for (const a of C.JD.accounts) {
    a.ph.sort((x: any, y: any) => prank(x[0]) - prank(y[0]));
    a._s = (a.n + ' ' + a.h + ' ' + a.w + ' ' + a.wh + ' ' + a.a + ' #' + a.c + ' ' + a.ph.map((p: any) => p[1] + ' ' + p[1].replace(/\D/g, '')).join(' ')).toLowerCase();
    by.set(a.c, a);
  }
  for (const p of C.JD.payments) {
    const [, code, date, amt] = p;
    let g = yg.get(code); if (!g) yg.set(code, g = { total: 0, count: 0, last: '', lastAmt: 0, list: [] });
    g.total += amt; g.count++; g.list.push(p);
    if (validD(date) && date <= today && date > g.last) { g.last = date; g.lastAmt = amt; }
  }
  const eom = (() => { const d = parse(today); return iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)); })();
  for (const c of C.JD.pledges) {
    const [, code, due, amt, , bal, , , , hold] = c;
    let g = pl.get(code); if (!g) pl.set(code, g = { open: 0, dueNow: 0, total: 0 });
    g.total += amt;
    if (!hold && bal > 0.009) { g.open += bal; if (!due || due <= eom) g.dueNow += bal; }
  }
  C.IDX = { by, yg, pl };
}
const SET = () => C.S.settings.s || {};
function ask(code: number) {
  const st = C.S.acct[code] || {}, g = C.IDX.yg.get(code), set = SET();
  const freq = st.freq || (!g ? 'none' : (set.skipOnce && g.count === 1 ? 'once' : set.defFreq || 'm12'));
  let next = st.nextAsk || null;
  if (!next && freq !== 'none' && freq !== 'once' && g && g.last) {
    if (g.last >= addMonths(todayS(), -12 * (+set.maxYears || 5))) next = addFreq(g.last, freq);
  }
  return { freq, next, st };
}
const nm = (a: any) => a.h || a.n;
async function addEvents(rows: any[], by: string) {
  await rest('/rest/v1/events', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(rows.map(r => ({ ...r, by }))) });
}

// ---------- find a donor by name / phone / #number ----------
function find(q: string, only?: Map<number, any>) {
  q = q.trim().toLowerCase();
  const num = q.replace(/^#/, '');
  if (/^\d{1,7}$/.test(num) && C.IDX.by.has(+num) && (!only || only.has(+num))) return [C.IDX.by.get(+num)];
  const words = q.split(/\s+/).filter(Boolean), qd = q.replace(/\D/g, '');
  let L = C.JD.accounts.filter((a: any) => (!only || only.has(a.c)) && ((words.length && words.every(w => a._s.includes(w))) || (qd.length >= 7 && a._s.includes(qd))));
  L.sort((x: any, y: any) => ((C.IDX.yg.get(y.c) || {}).total || 0) - ((C.IDX.yg.get(x.c) || {}).total || 0));
  return L;
}
function pickOne(q: string, only?: Map<number, any>): { a?: any, msg?: string } {
  if (!q.trim()) return { msg: 'שרייבט א נאמען נאכן ווארט.' };
  const L = find(q, only);
  if (!L.length) return { msg: 'נישט געפונען: ' + q };
  if (L.length === 1) return { a: L[0] };
  // exact Hebrew/English full-name match wins
  const ex = L.filter((a: any) => [a.h, a.n].some(v => (v || '').toLowerCase().endsWith(q.trim().toLowerCase())));
  if (ex.length === 1) return { a: ex[0] };
  return { msg: L.length + ' געפונען, שיקט נאכאמאל מיט דעם #נומער:\n' + L.slice(0, 6).map((a: any) => '#' + a.c + ' ' + nm(a) + (a.a ? ', ' + a.a.split(',')[0] : '')).join('\n') };
}

// ---------- commands ----------
const CMDS: [string[], string][] = [
  [['טעלעפאן', 'טעל', 'phone', 'tel', 'p'], 'phone'],
  [['אדרעס', 'address', 'addr', 'a'], 'address'],
  [['באלאנס', 'balance', 'bal', 'b'], 'balance'],
  [['אינפא', 'info', 'i'], 'info'],
  [['געגעבן', 'given', 'gave', 'g'], 'given'],
  [['היינט', 'today', 't'], 'today'],
  [['פלעדזשעס', 'pledges', 'pl'], 'pledges'],
  [['געקאלט', 'called', 'c'], 'called'],
  [['טאדו', 'טודו', 'todo', 'td', '+'], 'todo'],
  [['נאטיץ', 'note', 'n'], 'note'],
  [['שול', 'shul'], 'shul'],
  [['תלמידים', 'תלמיד', 'students', 'kids'], 'students'],
  [['באצאלט', 'paid'], 'given'],
  [['הילף', 'help', '?', 'h'], 'help']
];
const HELP = 'YG Fund SMS:\n' +
  'נאמען - אלע אינפא\n' +
  'טעלעפאן נאמען\n' +
  'אדרעס נאמען\n' +
  'געגעבן נאמען - נדבות לעצטע יאר\n' +
  'באלאנס נאמען\n' +
  'היינט - מיינע To-Do\n' +
  'פלעדזשעס\n' +
  'געקאלט נאמען\n' +
  'טאדו טעקסט - נייע To-Do\n' +
  'נאטיץ נאמען: טעקסט\n' +
  'שול - די ריי\n' +
  'שול נאמען - אינפא פון א שול';

// ---------- 🎓 tuition mode (owner, v1.70) ----------
// A team member whose name is checked in Settings > users "🎓 SMS" (setting smsTu {name: true}), or whose access is
// tuition only (team.perms = ['tuition']), gets tuition (שכר לימוד) answers: families from jls/jls-tuition.json.gz.
// Balance the JLS way: all bills not on hold − all payments not refunded (credit = negative).
const isTuMember = (m: any) => !!(SET().smsTu || {})[m.name] || (Array.isArray(m.perms) && m.perms.length > 0 && m.perms.every((p: string) => p === 'tuition'));
async function loadTU() {
  if (C.TU && C.TUver === C.jlsVer) return;
  let r: Response;
  try { r = await rest('/storage/v1/object/jls/jls-tuition.json.gz'); }
  catch (_) { C.TU = { payments: [], charges: [], students: [] }; C.TUF = new Map(); C.TUver = C.jlsVer; return; }
  const blob = await r.blob();
  C.TU = JSON.parse(await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text());
  const F = new Map<number, any>(), G = (c: number) => F.get(c) || (F.set(c, { ch: [], pay: [], kids: [] }), F.get(c));
  (C.TU.charges || []).forEach((c: any) => G(+c[1]).ch.push(c));
  (C.TU.payments || []).forEach((p: any) => G(+p[1]).pay.push(p));
  (C.TU.students || []).forEach((k: any) => G(+k[1]).kids.push(k));
  C.TUF = F; C.TUver = C.jlsVer;
}
function tuFam(code: number) {
  const f = C.TUF.get(code) || { ch: [], pay: [], kids: [] }, today = todayS();
  let bills = 0, billsDue = 0, paid = 0, last: any = null;
  for (const c of f.ch) { if (c[7]) continue; bills += +c[3] || 0; if (c[2] && c[2] <= today) billsDue += +c[3] || 0; }
  for (const p of f.pay) { if (p[7]) continue; paid += +p[3] || 0; if (p[2] && p[2] <= today && (!last || p[2] > last[2])) last = p; }
  const bal = Math.round((bills - paid) * 100) / 100;
  let due = Math.round((billsDue - paid) * 100) / 100; if (due < 0) due = Math.max(due, Math.min(bal, 0));
  return { f, bal, due, last };
}
const tuBalTxt = (n: number) => n < -0.004 ? 'קרעדיט ' + money(-n) : money(n);
const TUHELP = 'YG Fund SMS – שכר לימוד:\n' +
  'נאמען - אלע אינפא\n' +
  'טעלעפאן נאמען\n' +
  'אדרעס נאמען\n' +
  'באלאנס נאמען\n' +
  'געגעבן נאמען - באצאלונגען לעצטע יאר\n' +
  'תלמידים נאמען\n' +
  'היינט - מיינע To-Do\n' +
  'טאדו טעקסט - נייע To-Do\n' +
  'נאטיץ נאמען: טעקסט';
async function tuAnswer(cmd: string, rest: string, member: any): Promise<string> {
  await loadTU();
  const me = member.name, today = todayS();
  if (cmd === 'help') return TUHELP;
  if (cmd === 'todo') {
    if (!rest) return 'שרייבט: טאדו און וואס צו טון';
    await addEvents([{ k: 'task', eid: uid(), p: { title: rest, due: today, who: me, who2: '', code: '', pri: 'norm', note: '📱 SMS', repeat: '', done: false, priv: false, area: 'tu', cat: 'proj', from: me, created: new Date().toISOString() } }], me);
    return '✓ צוגעלייגט צו To-Do: ' + rest;
  }
  if (cmd === 'note') {
    const i = rest.indexOf(':');
    if (i < 1) return 'שרייבט: נאטיץ נאמען: טעקסט';
    const r = pickOne(rest.slice(0, i), C.TUF); if (!r.a) return r.msg!;
    const note = rest.slice(i + 1).trim(); if (!note) return 'וואס איז די נאטיץ?';
    await addEvents([{ k: 'hist', eid: uid(), p: { code: r.a.c, text: '📱 ' + note, area: 'tu' } }], me);
    return '✓ נאטיץ ביי ' + nm(r.a);
  }
  if (cmd === 'today') {
    const out: string[] = [];
    for (const [, x] of Object.entries(C.S.task) as any) {
      if (!x.title || x.done || x.del || x.area !== 'tu' || (x.due && x.due > today)) continue;
      if (x.priv && (x.owner || '').toLowerCase() !== member.email.toLowerCase()) continue;
      if (x.who === me || x.who2 === me) out.push('• ' + x.title);
    }
    const mine: string[] = [];
    for (const [c, st] of Object.entries(C.S.acct) as any) {
      if (st.tuWho !== me || !C.TUF.has(+c) || !C.IDX.by.has(+c)) continue;
      const t = tuFam(+c); if (t.due > 0.5) { const a = C.IDX.by.get(+c); mine.push('• ' + nm(a) + ' ' + money(t.due) + (a.ph[0] ? ' ' + a.ph[0][1] : '')); }
    }
    if (!out.length && !mine.length) return '🎉 גארנישט פאר היינט';
    return 'היינט (' + (out.length + mine.length) + '):\n' + out.slice(0, 8).concat(mine.slice(0, 6)).join('\n');
  }
  if (cmd === 'shul' && rest) return shulInfo(rest);
  if (['pledges', 'called', 'shul'].includes(cmd)) return TUHELP;
  const r = pickOne(rest, C.TUF); if (!r.a) return r.msg!;
  const a = r.a, T = tuFam(a.c);
  const phones = a.ph.slice(0, 3).map((x: any) => (x[0] ? x[0] + ' ' : '') + x[1]).join('\n') || 'קיין טעלעפאן';
  const kidsNow = T.f.kids.filter((k: any) => !k[8] || k[8] >= today);
  const kidTxt = (k: any) => ((k[4] || k[2] || '') + ' ' + (k[5] || k[3] || '')).trim() + (k[6] ? ' (' + k[6] + ')' : '');
  if (cmd === 'phone') return nm(a) + '\n' + phones;
  if (cmd === 'address') return nm(a) + '\n' + (a.a || 'קיין אדרעס');
  if (cmd === 'balance') return nm(a) + '\nבאלאנס: ' + tuBalTxt(T.bal) + (T.due > 0.5 ? '\nפעליג יעצט: ' + money(T.due) : '');
  if (cmd === 'students') return nm(a) + '\n' + (kidsNow.length ? kidsNow.map(kidTxt).join('\n') : 'קיין תלמידים יעצט');
  if (cmd === 'given') {
    const yearAgo = addMonths(today, -12);
    const L = T.f.pay.filter((p: any) => !p[7] && p[2] && p[2] >= yearAgo && p[2] <= today).sort((x: any, y: any) => y[2].localeCompare(x[2]));
    if (!L.length) return nm(a) + '\nלעצטע יאר: גארנישט באצאלט' + (T.last ? '\nלעצטע מאל: ' + money(T.last[3]) + ' ' + shortD(T.last[2]) : '');
    return nm(a) + '\nלעצטע יאר: ' + money(L.reduce((s: number, p: any) => s + (+p[3] || 0), 0)) + ' (' + L.length + ')\n' + L.slice(0, 6).map((p: any) => shortD(p[2]) + ' ' + money(p[3])).join('\n');
  }
  const last = Object.values(C.S.hist).filter((h: any) => h.code === a.c).sort((x: any, y: any) => (y.at || '').localeCompare(x.at || ''))[0] as any;
  return [nm(a) + ' #' + a.c, phones, a.a || '',
    'באלאנס: ' + tuBalTxt(T.bal) + (T.due > 0.5 ? ' · פעליג יעצט: ' + money(T.due) : ''),
    T.last ? 'לעצטע באצאלונג: ' + money(T.last[3]) + ' ' + shortD(T.last[2]) : 'קיין באצאלונגען',
    kidsNow.length ? '🎓 ' + kidsNow.map(kidTxt).join(', ') : '',
    last ? '💬 ' + String(last.text).slice(0, 60) : ''].filter(Boolean).join('\n');
}

// 🕍 "שול name" (v1.71): one shul's details – Yiddish/English/short name, address, rabbi, phone, nusach, donors.
function shulInfo(q: string) {
  const norm = (x: any) => String(x || '').toLowerCase().replace(/["'״׳\-]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = norm(q).split(' ').filter(Boolean);
  const L = Object.entries(C.S.shul).filter(([, x]: any) => !x.del).map(([id, x]: any) => ({ id, ...x }))
    .filter((s: any) => { const h = norm([s.name, s.eng, s.short, s.addr, s.rabbi].join(' ')); return words.every(w => h.includes(w)); });
  if (!L.length) return 'קיין שול געפונען: ' + q;
  if (L.length > 1) {
    const ex = L.filter((s: any) => [s.name, s.eng, s.short].some(v => norm(v) === norm(q)));
    if (ex.length !== 1) return L.length + ' שולן:\n' + L.slice(0, 8).map((s: any) => '• ' + s.name + (s.eng && s.eng !== s.name ? ' / ' + s.eng : '') + (s.zip ? ' ' + s.zip : '')).join('\n') + '\nשיקט מיט מער פונעם נאמען';
    L.splice(0, L.length, ex[0]);
  }
  const s: any = L[0], n = Object.values(C.S.acct).filter((a: any) => a.shul === s.id).length;
  return ['🕍 ' + s.name, s.eng && s.eng !== s.name ? s.eng : '', s.addr || '', s.rabbi ? 'רב: ' + s.rabbi : '', s.phone ? 'טעל: ' + s.phone : '', s.nusach ? 'נוסח: ' + s.nusach : '',
    n ? n + ' נדבנים' : '', s.paused ? '(אפגעשטעלט)' : '', s.notes ? '📝 ' + s.notes : ''].filter(Boolean).join('\n');
}

async function answer(text: string, member: any): Promise<string> {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) return isTuMember(member) ? TUHELP : HELP;
  let cmd = 'info', rest = t;
  if (t.startsWith('+')) { cmd = 'todo'; rest = t.slice(1); }
  else {
    const first = t.split(' ')[0].toLowerCase();
    const hit = CMDS.find(([ws]) => ws.includes(first));
    if (hit) { cmd = hit[1]; rest = t.slice(first.length); }
  }
  rest = rest.trim();
  if (isTuMember(member)) return tuAnswer(cmd, rest, member);
  const me = member.name, today = todayS();
  if (cmd === 'help') return HELP;

  if (cmd === 'todo') {
    if (!rest) return 'שרייבט: טאדו און וואס צו טון';
    await addEvents([{ k: 'task', eid: uid(), p: { title: rest, due: today, who: me, who2: '', code: '', pri: 'norm', note: '📱 SMS', repeat: '', done: false, priv: false } }], me);
    return '✓ צוגעלייגט צו To-Do: ' + rest;
  }
  if (cmd === 'note') {
    const i = rest.indexOf(':');
    if (i < 1) return 'שרייבט: נאטיץ נאמען: טעקסט';
    const r = pickOne(rest.slice(0, i)); if (!r.a) return r.msg!;
    const note = rest.slice(i + 1).trim(); if (!note) return 'וואס איז די נאטיץ?';
    await addEvents([{ k: 'hist', eid: uid(), p: { code: r.a.c, text: '📱 ' + note } }], me);
    return '✓ נאטיץ ביי ' + nm(r.a);
  }
  if (cmd === 'today') {
    const out: string[] = [];
    for (const [, x] of Object.entries(C.S.task) as any) {
      if (!x.title || x.done || x.del || !x.due || x.due > today) continue;
      if (x.priv && (x.owner || '').toLowerCase() !== member.email.toLowerCase()) continue;
      if (x.who === me || x.who2 === me) out.push('• ' + x.title);
    }
    const codes = new Set([...C.IDX.yg.keys(), ...Object.keys(C.S.acct).map(Number)]);
    let asks = 0; const askL: string[] = [];
    for (const code of codes) {
      if (!C.IDX.by.has(code)) continue;
      const k = ask(code);
      if (k.next && k.next <= today && (k.st.assigned || '') === me) { asks++; if (askL.length < 5) { const a = C.IDX.by.get(code); askL.push('• בעטן ' + nm(a) + (a.ph[0] ? ' ' + a.ph[0][1] : '')); } }
    }
    if (!out.length && !asks) return '🎉 גארנישט פאר היינט';
    return 'היינט (' + (out.length + asks) + '):\n' + out.slice(0, 8).concat(askL).join('\n');
  }
  if (cmd === 'pledges') {
    const mk = today.slice(0, 7), L: any[] = [];
    C.IDX.pl.forEach((g: any, c: number) => { if (g.open > 0.009 && C.IDX.by.has(c) && !(C.S.call[c + '|' + mk] || {}).v) L.push([c, g]); });
    L.sort((x, y) => y[1].dueNow - x[1].dueNow);
    if (!L.length) return '✓ אלע פלעדזשעס געקאלט דעם חודש';
    return 'פלעדזשעס (' + L.length + '):\n' + L.slice(0, 8).map(([c, g]) => { const a = C.IDX.by.get(c); return '• ' + nm(a) + ' ' + money(g.dueNow) + (a.ph[0] ? ' ' + a.ph[0][1] : ''); }).join('\n');
  }
  if (cmd === 'shul' && rest) return shulInfo(rest);
  if (cmd === 'shul' && SET().shulRot !== true) return 'די ריי פון מיטוואכן איז אפגעשטעלט.\nשיקט: שול נאמען – פאר אינפא פון א שול';
  if (cmd === 'shul') {
    const L = Object.entries(C.S.shul).filter(([, x]: any) => !x.del && !x.paused).map(([id, x]: any) => ({ id, ...x })).sort((a: any, b: any) => (a.ord || 0) - (b.ord || 0));
    if (!L.length) return 'קיין שולן';
    let st = SET().shulStart; if (!st) { const d = parse(today); st = addDays(today, (3 - d.getDay() + 7) % 7); }
    let k = today > st ? Math.ceil((parse(today).getTime() - parse(st).getTime()) / 864e5 / 14) : 0;
    const lines = [0, 1].map(i => { const s: any = L[(k + i) % L.length]; return shortD(addDays(st, 14 * (k + i))) + ' ' + s.name + (i === 0 && s.addr ? '\n' + s.addr : ''); });
    return '🕍 ' + lines.join('\n');
  }
  // donor commands (v1.71: a name that is no donor but a shul answers with the shul)
  const r = pickOne(rest); if (!r.a) { if (cmd === 'info' && /^נישט געפונען/.test(r.msg || '')) { const si = shulInfo(rest); if (!/^קיין שול/.test(si)) return si; } return r.msg!; }
  const a = r.a, g = C.IDX.yg.get(a.c), p = C.IDX.pl.get(a.c);
  const phones = a.ph.slice(0, 3).map((x: any) => (x[0] ? x[0] + ' ' : '') + x[1]).join('\n') || 'קיין טעלעפאן';
  const yearAgo = addMonths(today, -12);
  const lastYear = g ? g.list.filter((x: any) => validD(x[2]) && x[2] >= yearAgo && x[2] <= today && !x[9]) : [];
  const lyTotal = lastYear.reduce((s: number, x: any) => s + x[3], 0);
  if (cmd === 'phone') return nm(a) + '\n' + phones;
  if (cmd === 'address') return nm(a) + '\n' + (a.a || 'קיין אדרעס');
  if (cmd === 'balance') return nm(a) + '\nבאלאנס: ' + money(p ? p.open : 0) + (p && p.dueNow > 0.009 ? '\nפעליג יעצט: ' + money(p.dueNow) : '');
  if (cmd === 'given') {
    if (!lastYear.length) return nm(a) + '\nלעצטע יאר: גארנישט' + (g && g.last ? '\nלעצטע מאל: ' + money(g.lastAmt) + ' ' + shortD(g.last) : '');
    return nm(a) + '\nלעצטע יאר: ' + money(lyTotal) + ' (' + lastYear.length + ')\n' + lastYear.slice(0, 6).map((x: any) => shortD(x[2]) + ' ' + money(x[3])).join('\n');
  }
  if (cmd === 'called') {
    await addEvents([{ k: 'call', eid: a.c + '|' + today.slice(0, 7), p: { v: true } }, { k: 'hist', eid: uid(), p: { code: a.c, text: 'פלעדזש קאל: 📱 SMS' } }], me);
    return '✓ ' + nm(a) + ' אנגעמערקט געקאלט';
  }
  // info (default)
  const k = ask(a.c), last = Object.values(C.S.hist).filter((h: any) => h.code === a.c).sort((x: any, y: any) => (y.at || '').localeCompare(x.at || ''))[0] as any;
  return [nm(a) + ' #' + a.c, phones, a.a || '',
    'לעצטע יאר: ' + money(lyTotal) + ' · סך הכל: ' + money(g ? g.total : 0),
    g && g.last ? 'לעצטע: ' + money(g.lastAmt) + ' ' + shortD(g.last) : '',
    p && p.open > 0.009 ? 'באלאנס: ' + money(p.open) : '',
    k.next ? 'ווייטער בעטן: ' + shortD(k.next) : '',
    last ? '💬 ' + String(last.text).slice(0, 60) : ''].filter(Boolean).join('\n');
}

// ---------- webhook signature checks ----------
const b64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function twilioOk(req: Request, params: URLSearchParams) {
  const token = ENV('TWILIO_AUTH_TOKEN'), sig = req.headers.get('x-twilio-signature') || '';
  if (!token || !sig) return false;
  const url = ENV('SMS_PUBLIC_URL') || SB_URL() + '/functions/v1/sms';
  const data = url + [...params.keys()].sort().map(k => k + params.get(k)).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  return btoa(String.fromCharCode(...mac)) === sig;
}
async function telnyxOk(req: Request, raw: string) {
  const pub = ENV('TELNYX_PUBLIC_KEY'), sig = req.headers.get('telnyx-signature-ed25519') || '', ts = req.headers.get('telnyx-timestamp') || '';
  if (!pub || !sig || !ts) return false;
  if (Math.abs(Date.now() / 1000 - +ts) > 300) return false;
  const key = await crypto.subtle.importKey('raw', b64(pub), { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, b64(sig), new TextEncoder().encode(ts + '|' + raw));
}
// Textillion: X-Textillion-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the webhook signing secret>
const TX_API = () => ENV('TEXTILLION_API_URL') || 'https://ppslldtdmpdmsorbqbjl.supabase.co/functions/v1/api-v1';
async function textillionOk(req: Request, raw: string) {
  const sec = ENV('TEXTILLION_WEBHOOK_SECRET'), sig = req.headers.get('x-textillion-signature') || '';
  const t = (sig.match(/t=(\d+)/) || [])[1], v1 = (sig.match(/v1=([a-f0-9]+)/) || [])[1];
  if (!sec || !t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - +t) > 600) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(sec), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(t + '.' + raw)));
  const hex = [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex.length !== v1.length) return false;
  let d = 0; for (let i = 0; i < hex.length; i++) d |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  return d === 0;
}
// 📵 STOP / START (owner, v1.68): Twilio itself handles the opt-out and sends the confirmation; we only e-mail the
// admins (team.is_admin) who did it, so the office knows. Sent through Gmail like the other functions.
const OPT_STOP = /^(stop|stopall|unsubscribe|cancel|end|quit|revoke|optout)$/i, OPT_START = /^(start|unstop|yes)$/i;
async function mailAdmins(subject: string, html: string) {
  const gUser = ENV('GMAIL_USER'), gPass = ENV('GMAIL_APP_PASSWORD').replace(/\s+/g, ''); if (!gUser || !gPass) throw new Error('no Gmail secrets');
  const team = await (await rest('/rest/v1/team?select=email,name,is_admin')).json();
  const to = team.filter((t: any) => t.is_admin && t.email).map((t: any) => t.email).join(', '); if (!to) throw new Error('no admin e-mail');
  const nodemailer = (await import('npm:nodemailer@6.9.16')).default;
  const tr = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: gUser, pass: gPass }, connectionTimeout: 12000, greetingTimeout: 8000, socketTimeout: 15000 });
  await tr.sendMail({ from: ENV('EMAIL_FROM') || 'YG Fund <' + gUser + '>', to, subject, html });
}
// 💰 low Twilio balance (owner, v1.69): GET ?balance=1 (every 3 hours from .github/workflows/twbal.yml) reads the
// balance with the account SID (secret TWILIO_ACCOUNT_SID, else remembered from the last Twilio webhook as setting
// `twSid`) + TWILIO_AUTH_TOKEN, and e-mails the admins once when it is at or below setting `twLowAt` (default $0.50);
// `twLowSent` keeps it to one e-mail until the balance is above the line again.
const BY_AUTO = '⏰ אויטאמאטיש';
async function balanceCheck() {
  await load();
  const st = SET(), sid = ENV('TWILIO_ACCOUNT_SID') || st.twSid || '', tok = ENV('TWILIO_AUTH_TOKEN');
  if (!sid || !tok) return { error: 'no account SID yet (text the bot once) or no TWILIO_AUTH_TOKEN' };
  const r = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Balance.json', { headers: { Authorization: 'Basic ' + btoa(sid + ':' + tok) } });
  if (!r.ok) return { error: 'Twilio ' + r.status };
  const b = await r.json(), bal = +b.balance, line = st.twLowAt != null && st.twLowAt !== '' ? +st.twLowAt : 0.5;
  if (bal <= line && !st.twLowSent) {
    const html = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6"><p><b>💰 דער באלאנס ביי Twilio (דער SMS באט) איז נידעריג: <span dir="ltr">$${bal.toFixed(2)}</span></b></p>
      <p>ווען דער באלאנס ווערט 0, הערט דער SMS באט אויף צו ענטפערן.</p>
      <p>צו צולייגן געלט: <a href="https://console.twilio.com/us1/billing/manage-billing/billing-overview">Twilio &gt; Billing</a> &gt; <b>Add funds</b>.</p>
      <p style="color:#888;font-size:12px">דאס אימעיל קומט איין מאל. ווען דער באלאנס גייט ווידער העכער $${line.toFixed(2)} און פאלט נאכאמאל, קומט ווידער איינס.</p></div>`;
    await mailAdmins('💰 Twilio באלאנס נידעריג: $' + bal.toFixed(2), html);
    await addEvents([{ k: 'settings', eid: 's', p: { twLowSent: true, twLowMailAt: new Date().toISOString() } }], BY_AUTO);
    C.S.settings.s = Object.assign(C.S.settings.s || {}, { twLowSent: true });
    return { balance: bal, line, mailed: true };
  }
  if (bal > line && st.twLowSent) { await addEvents([{ k: 'settings', eid: 's', p: { twLowSent: false } }], BY_AUTO); C.S.settings.s.twLowSent = false; }
  return { balance: bal, line, mailed: false };
}
async function optMail(kind: 'STOP' | 'START', from: string, m: any) {
  try {
    const when = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'numeric', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' }).format(new Date());
    const d = digits10(from), ph = d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : from;
    const who = m ? m.name : 'א נומער וואס איז נישט אין די באניצערס';
    const stop = kind === 'STOP';
    const subject = (stop ? '📵 STOP' : '✅ START') + ' אויפן SMS באט – ' + (m ? m.name : ph);
    const html = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6"><p><b>${stop ? '📵 איינער האט געשיקט STOP צום SMS באט' : '✅ איינער האט געשיקט START צום SMS באט'}</b></p>
      <p>ווער: <b>${who.replace(/[<>&]/g, '')}</b><br>טעלעפאן: <span dir="ltr">${ph}</span><br>ווען: <span dir="ltr">${when}</span></p>
      <p style="color:#666">${stop ? 'פון יעצט באקומט דער נומער נישט מער קיין מעסעדזשעס פונעם באט. צו אנהייבן ווידער, דארף ער שיקן START.' : 'דער נומער באקומט ווידער ענטפערס פונעם באט.'}</p></div>`;
    await mailAdmins(subject, html);
  } catch (e) { console.error('opt-out mail', String((e as any)?.message || e)); }
}
const txSeen = new Set<string>();   // the same event can arrive twice (retries): answer once while warm
async function memberFor(from: string) {
  const team = await (await rest('/rest/v1/team?select=*')).json();
  const d = digits10(from);
  return d.length === 10 ? team.find((t: any) => t.phone && digits10(t.phone) === d) : null;
}
const clip = (s: string) => s.length > MAX_REPLY ? s.slice(0, MAX_REPLY - 1) + '…' : s;
const xml = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as any)[c]);
const twiml = (msg?: string) => new Response('<?xml version="1.0" encoding="UTF-8"?><Response>' + (msg ? '<Message>' + xml(msg) + '</Message>' : '') + '</Response>', { headers: { 'Content-Type': 'text/xml' } });

async function handle(req: Request): Promise<Response> {
  if (req.method === 'GET' && new URL(req.url).searchParams.get('balance') === '1') {
    try { return new Response(JSON.stringify(await balanceCheck()), { headers: { 'Content-Type': 'application/json' } }); }
    catch (e) { return new Response(JSON.stringify({ error: String((e as any)?.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }
  }
  if (req.method !== 'POST') return new Response(JSON.stringify({ app: 'YG Fund SMS', textillion: { apiKey: ENV('TEXTILLION_API_KEY') ? 'set' : 'missing', webhookSecret: ENV('TEXTILLION_WEBHOOK_SECRET') ? 'set' : 'missing' }, telnyx: ENV('TELNYX_API_KEY') ? 'set' : 'missing', twilio: ENV('TWILIO_AUTH_TOKEN') ? 'set' : 'missing' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const raw = await req.text(), ct = req.headers.get('content-type') || '';
  try {
    if (ct.includes('application/x-www-form-urlencoded')) {          // ---- Twilio
      const params = new URLSearchParams(raw);
      if (!(await twilioOk(req, params))) return new Response('forbidden', { status: 403 });
      const m = await memberFor(params.get('From') || '');
      const word = (params.get('Body') || '').trim(), ot = (params.get('OptOutType') || '').toUpperCase();
      if (ot === 'STOP' || OPT_STOP.test(word)) { await optMail('STOP', params.get('From') || '', m); return twiml(); }   // Twilio answers STOP itself
      if (ot === 'START' || OPT_START.test(word)) { await optMail('START', params.get('From') || '', m); return twiml(); }
      if (!m) return twiml();                                          // not on the team: no answer
      await load();
      const asid = params.get('AccountSid') || '';
      if (/^AC[0-9a-f]{32}$/.test(asid) && SET().twSid !== asid) { await addEvents([{ k: 'settings', eid: 's', p: { twSid: asid } }], BY_AUTO); C.S.settings.s = Object.assign(C.S.settings.s || {}, { twSid: asid }); }
      return twiml(clip(await answer(params.get('Body') || '', m)));
    }
    if (req.headers.get('x-textillion-signature')) {                  // ---- Textillion
      if (!(await textillionOk(req, raw))) return new Response('forbidden', { status: 403 });
      const ev = JSON.parse(raw), d = ev.data || {};
      if (ev.type !== 'message.inbound' || !d.from) return new Response('ok');
      if (ev.id && txSeen.has(ev.id)) return new Response('ok');
      if (ev.id) txSeen.add(ev.id);
      const m = await memberFor(d.from);
      if (!m) return new Response('ok');
      await load();
      const reply = clip(await answer(d.body || '', m));
      const r = await fetch(TX_API() + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ENV('TEXTILLION_API_KEY'), ...(ev.id ? { 'Idempotency-Key': 'yg-' + ev.id } : {}) },
        body: JSON.stringify({ to: d.from, ...(d.to ? { from: d.to } : {}), body: reply }) });
      if (!r.ok) console.error('Textillion send', r.status, (await r.text()).slice(0, 300));
      return new Response('ok');
    }
    // ---- Telnyx
    if (!(await telnyxOk(req, raw))) return new Response('forbidden', { status: 403 });
    const ev = JSON.parse(raw).data || {};
    if (ev.event_type !== 'message.received') return new Response('ok');
    const pl = ev.payload || {}, from = (pl.from || {}).phone_number || '', to = ((pl.to || [])[0] || {}).phone_number || '';
    const m = await memberFor(from);
    if (!m) return new Response('ok');
    await load();
    const reply = clip(await answer(pl.text || '', m));
    await fetch('https://api.telnyx.com/v2/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ENV('TELNYX_API_KEY') }, body: JSON.stringify({ from: to, to: from, text: reply }) });
    return new Response('ok');
  } catch (e) {
    console.error(e);
    return ct.includes('urlencoded') ? twiml('⚠️ א טעות, פרובירט שפעטער') : new Response('error', { status: 200 });
  }
}

if ((globalThis as any).Deno) (globalThis as any).Deno.serve(handle);
export { handle, answer, load, C };
