// Edge Function `smsout` (v1.78): the app's 📱 SMS center sends balance / general text messages through Twilio.
// Deploy with "Verify JWT" OFF; the function itself checks that the caller is an admin in `team`.
// Sends from setting `smsSvc`: a Messaging Service SID (MG…, the notifications campaign) or a verified toll-free number
// (+18XX…). Never from the staff bot's service. Account SID = secret TWILIO_ACCOUNT_SID or setting `twSid`; secret TWILIO_AUTH_TOKEN.
// Body: {area: 'fund'|'tu', msgs: [{code, to (10 digits), body}]} (max 25). Writes a `hist` note per account;
// numbers that texted STOP (Twilio error 21610) get acct.smsNo so they are skipped next time.
const ENV = (k: string) => (globalThis as any).Deno?.env.get(k) || (globalThis as any).process?.env?.[k] || '';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
function svcHeaders(extra: Record<string, string> = {}) { const k = ENV('SUPABASE_SERVICE_ROLE_KEY'); const h: Record<string, string> = { apikey: k, ...extra }; if (!k.startsWith('sb_')) h.Authorization = 'Bearer ' + k; return h; }
async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(ENV('SUPABASE_URL') + path, { ...init, headers: svcHeaders((init.headers || {}) as Record<string, string>) });
  if (!r.ok) throw new Error(path.split('?')[0] + ' ' + r.status);
  return r;
}
const SVC_RE = /^MG[0-9a-f]{32}$/i, TF_RE = /^\+1(800|833|844|855|866|877|888)\d{7}$/;

export async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only', authToken: ENV('TWILIO_AUTH_TOKEN') ? 'set' : 'missing' }, 405);
  try {
    // who is calling: their own token → e-mail → must be an admin in team
    const auth = req.headers.get('Authorization') || '';
    const ur = await fetch(ENV('SUPABASE_URL') + '/auth/v1/user', { headers: { apikey: ENV('SUPABASE_ANON_KEY') || ENV('SUPABASE_SERVICE_ROLE_KEY'), Authorization: auth } });
    if (!ur.ok) return json({ error: 'not logged in' }, 401);
    const email = String((await ur.json()).email || '').toLowerCase();
    const team = await (await rest('/rest/v1/team?select=email,name,is_admin')).json();
    const t = team.find((x: any) => String(x.email || '').toLowerCase() === email);
    if (!t || !t.is_admin) return json({ error: 'admins only' }, 403);

    const ev = await (await rest('/rest/v1/events?select=p&k=eq.settings&eid=eq.s&order=id.asc')).json();
    const set: any = Object.assign({}, ...ev.map((e: any) => e.p || {}));
    const from = String(set.smsSvc || '').trim(), sid = ENV('TWILIO_ACCOUNT_SID') || set.twSid || '', tok = ENV('TWILIO_AUTH_TOKEN');
    if (!SVC_RE.test(from) && !TF_RE.test(from)) return json({ error: 'SMS sending is not set up (setting smsSvc)' }, 400);
    if (!/^AC[0-9a-f]{32}$/.test(sid) || !tok) return json({ error: 'Twilio account SID / auth token missing' }, 500);

    const b = await req.json(), area = b.area === 'tu' ? 'tu' : 'fund';
    const msgs = (Array.isArray(b.msgs) ? b.msgs : []).slice(0, 25);
    const sent: any[] = [], failed: any[] = [], rows: any[] = [], now = new Date().toISOString();
    for (const m of msgs) {
      const to = String(m.to || '').replace(/\D/g, '').slice(-10), body = String(m.body || '').slice(0, 1200), code = +m.code || 0;
      if (to.length !== 10 || !body) { failed.push({ code, error: 'bad number or empty text' }); continue; }
      const f = new URLSearchParams({ To: '+1' + to, Body: body });
      if (SVC_RE.test(from)) f.set('MessagingServiceSid', from); else f.set('From', from);
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, { method: 'POST', headers: { Authorization: 'Basic ' + btoa(sid + ':' + tok), 'Content-Type': 'application/x-www-form-urlencoded' }, body: f });
      const j: any = await r.json().catch(() => ({}));
      if (r.ok && j.sid) {
        sent.push({ code, sid: j.sid });
        if (code) rows.push({ k: 'hist', eid: 'sms-' + j.sid, p: { code, text: '📱 SMS: ' + body, area } });
      } else {
        failed.push({ code, error: (j.code ? j.code + ' ' : '') + (j.message || 'HTTP ' + r.status) });
        if (j.code === 21610 && code) rows.push({ k: 'acct', eid: String(code), p: { smsNo: true } });
        console.error('twilio', code, j.code, j.message);
      }
    }
    if (rows.length) await rest('/rest/v1/events', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(rows.map(r => ({ ...r, by: t.name || email }))) });
    return json({ sent: sent.length, failed });
  } catch (e) { console.error(e); return json({ error: String((e as any).message || e) }, 500); }
}
(globalThis as any).Deno?.serve(handle);
