/* 📱 SMS center (owner, v1.78) – view `smsc`, admins only, in both areas.
   Tuition: every family's own balance (this school year / everything); fundraising: open pledge balances; both: a general
   message (the same text for everybody). Messages go only to accounts marked as having agreed (acct.smsOk, verbal consent,
   marked per account or in bulk) and only to a cell phone. Sending goes through the Edge Function `smsout` (Twilio, the
   Messaging Service of the notifications campaign = setting smsSvc), 20 at a time; each send is noted in the history. */
'use strict';
const SMS_TPL = {
  tu: 'שלום {name}, א דערמאנונג פון ישיבת מהרי"ט ד\'סאטמאר: שכר לימוד באלאנס פאר היי-יאר {year}, אינגאנצן {total}. א שיינעם דאנק!',
  fund: 'שלום {name}, א פריינטליכע דערמאנונג פון ישיבת מהרי"ט ד\'סאטמאר: אייער פלעדזש באלאנס איז {balance}. א הארציגן יישר כח!',
  gen: ''
};
const SMS_STOP = 'Reply STOP to opt out';
const smsCell = a => { const p = (a && a.ph || []).find(x => /cel|mob|cell|סעל/i.test(x[0] || '')); const d = p ? String(p[1]).replace(/\D/g, '').slice(-10) : ''; return d.length === 10 ? d : ''; };
const smsFmtPh = d => '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
// segments: Hebrew/Yiddish (not GSM-7) = 70 characters in one SMS, 67 per part when longer; Latin 160 / 153
function smsSegs(t) { const uni = /[^\x00-\x7F£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà]/.test(t), n = [...t].length; return !n ? 0 : uni ? (n <= 70 ? 1 : Math.ceil(n / 67)) : (n <= 160 ? 1 : Math.ceil(n / 153)); }
const SMS_PER_SEG = 0.012;   // Twilio ~$0.0083 + carrier fee, per part
const smsOk = c => !!(S.acct[c] || {}).smsOk;
// tuition: the family's open amounts by school year (FIFO, like the Billing %): this year's bills due up to today, older ones, and the JLS total
function smsTuOpen(code) {
  const t = todayS(), y = tuSY(t), ch = [], pay = [];
  TU.charges.forEach(c => { if (+c[1] !== +code || c[7] || !c[3] || !c[2]) return; if (c[3] > 0) ch.push({ d: c[2], n: c[0], left: c[3], y: tuSY(c[2]) }); else pay.push({ d: c[2], a: -c[3] }); });
  TU.payments.forEach(p => { if (+p[1] !== +code || !(p[3] > 0)) return; const a = p[3] - (p[7] || 0); if (a > 0) pay.push({ d: p[2] || '', a }); });
  ch.sort((a, b) => a.d.localeCompare(b.d) || a.n - b.n); pay.sort((a, b) => a.d.localeCompare(b.d));
  let i = 0, free = 0;
  for (const p of pay) { let r = p.a; while (r > 0.004 && i < ch.length) { const x = Math.min(r, ch[i].left); ch[i].left -= x; r -= x; if (ch[i].left <= 0.004) i++; } free += r; }
  let yr = 0, old = 0, total = -free; ch.forEach(c => { total += c.left; if (c.y < y) old += c.left; else if (c.y === y && c.d <= t) yr += c.left; });
  const r2 = v => Math.round(v * 100) / 100;
  return { yr: r2(yr), old: r2(old), total: r2(total) };
}
// fundraising: open pledges of an account (optionally one campaign)
function smsPl(code, camp) {
  let bal = 0, due = 0; const eom = todayS().slice(0, 8) + '31';
  (JD.pledges || []).forEach(x => { if (+x[1] !== +code || x[9] || !(x[5] > 0.009) || (camp && +x[6] !== +camp)) return; bal += x[5]; if (!x[2] || x[2] <= eom) due += x[5]; });
  return { bal: Math.round(bal * 100) / 100, due: Math.round(due * 100) / 100 };
}
function smsState() { const s = ui.sms || (ui.sms = {}); if (!s.mode) s.mode = 'bal'; if (!s.who) s.who = AREA === 'tu' ? 'yr' : 'pl'; if (s.min == null) s.min = 1; if (s.stop == null) s.stop = true; return s; }
function smsTplKey() { const s = smsState(); return s.mode === 'gen' ? 'gen' : AREA === 'tu' ? 'tu' : 'fund'; }
function smsTpl() { const s = smsState(), k = smsTplKey(); if (s.text == null || s.textK !== k) { s.text = (SET()['smsTpl_' + k] != null ? SET()['smsTpl_' + k] : SMS_TPL[k]) || ''; s.textK = k; } return s.text; }
// the people this message goes to: [{code, a, cell, vals, body, skip}]
function smsRows() {
  const s = smsState(), tu = AREA === 'tu', bal = s.mode === 'bal', min = +s.min || 0, tpl = smsTpl();
  let codes;
  if (s.who === 'sel' && s.codes && s.codes.length) codes = s.codes.slice();
  else if (tu) codes = tuCalc().L.filter(f => f.cur || f.bal > 0.5).map(f => f.code);
  else if (s.who === 'yg') codes = [...IDX.yg.keys()];
  else { const set = new Set(); (JD.pledges || []).forEach(x => { if (!x[9] && x[5] > 0.009 && (!s.camp || +x[6] === +s.camp)) set.add(+x[1]); }); codes = [...set]; }
  const out = [], TF = tu ? new Map(tuCalc().L.map(f => [f.code, f])) : null;
  for (const c of new Set(codes.map(Number))) {
    const a = IDX.by.get(c); if (!a) continue;
    const r = { code: c, a, cell: smsCell(a), vals: {} };
    r.vals.name = a.h || a.n;
    if (tu) { const o = smsTuOpen(c); r.vals.year = money(Math.max(0, o.yr)); r.vals.total = money(Math.max(0, (TF.get(c) || {}).bal || 0)); r.vals.old = money(Math.max(0, o.old)); r.vals.due = money(Math.max(0, (TF.get(c) || {}).due || 0)); r.o = o; }
    else { const p = smsPl(c, s.camp); r.vals.balance = money(p.bal); r.vals.due = money(p.due); r.vals.campaign = s.camp ? ((JD.campaigns || {})[s.camp] || '') : ''; r.o = p; }
    if (bal && s.who !== 'sel') {
      const v = tu ? (s.who === 'tot' ? r.o.total : s.who === 'all' ? Infinity : r.o.yr) : (s.who === 'yg' ? Infinity : s.who === 'due' ? r.o.due : r.o.bal);
      if (!(v >= min)) continue;
    }
    r.body = tpl.replace(/\{(\w+)\}/g, (m, k) => r.vals[k] != null ? r.vals[k] : m).trim() + (s.stop ? '\n' + SMS_STOP : '');
    r.skip = (S.acct[c] || {}).smsNo ? 'אפגעזאגט (STOP)' : !smsOk(c) ? 'נישט מסכים' : !r.cell ? 'קיין סעלפאון' : '';
    out.push(r);
  }
  return out.sort((x, y) => (x.skip ? 1 : 0) - (y.skip ? 1 : 0) || (y.o.total || y.o.bal || 0) - (x.o.total || x.o.bal || 0));
}
function vSmsc() {
  if (!isAdmin()) { $('#main').innerHTML = '<div class="empty">🔒 Admins only</div>'; return; }
  if (AREA === 'tu' && !tuReady('smsc')) return;
  const s = smsState(), tu = AREA === 'tu', R = smsRows(), send = R.filter(r => !r.skip), segs = send.reduce((n, r) => n + smsSegs(r.body), 0);
  const sk = {}; R.filter(r => r.skip).forEach(r => sk[r.skip] = (sk[r.skip] || 0) + 1);
  const chip = (k, v, l) => `<button class="chip ${s[k] === v ? 'on' : ''}" onclick="ui.sms.${k}='${v}';vSmsc()">${l}</button>`;
  const camps = tu ? [] : [...new Set((JD.pledges || []).filter(x => !x[9] && x[5] > 0.009).map(x => +x[6]))].filter(Boolean).sort((a, b) => b - a);
  const tokens = s.mode === 'gen' ? ['name'] : tu ? ['name', 'year', 'total', 'old', 'due'] : ['name', 'balance', 'due', 'campaign'];
  const TL = { name: 'נאמען', year: 'באלאנס היי-יאר', total: 'באלאנס אינגאנצן', old: 'אלטע יארן', due: 'פעליג יעצט', balance: 'פלעדזש באלאנס', campaign: 'קאמפעין' };
  const svcOk = smsSvcOk(SET().smsSvc);
  $('#main').innerHTML = `<div class="row"><div><h2>📱 SMS – ${tu ? 'שכר לימוד' : 'פאנדרעיזינג'}</h2><p class="sub">שיקט נאר צו די וואס זענען <b>מסכים</b> (✓ ביי זיי) און האבן א <b>סעלפאון</b>. ${tu ? 'יעדער באקומט זיין אייגענעם באלאנס.' : 'יעדער באקומט זיין אייגענעם פלעדזש באלאנס.'}</p></div><div class="spacer"></div>
     <button class="btn ghost" onclick="smsSetForm()">⚙️ SMS settings</button></div>
   ${svcOk ? '' : `<div class="banner warn">⚠️ <div><b>שיקן איז נאך נישט אנגעשטעלט.</b> מען דארף א באזונדערע טוויליאו קאמפעין פאר מעלדונגען צו עלטערן/נדבנים. ווען זי איז אפרוווט, לייגט אריין איר Messaging Service SID (MG…) – אדער א ווערופייד טאול-פריי נומער (+18…) – ביי ⚙️ SMS settings.</div></div>`}
   <div class="box"><div class="row" style="flex-wrap:wrap;margin:0 0 8px">${chip('mode', 'bal', tu ? '💳 יעדנ\'ס באלאנס' : '💳 יעדנ\'ס פלעדזש')}${chip('mode', 'gen', '📢 כללות\'דיגע מעסעדזש')}<span class="bsep"></span>
     ${s.codes && s.codes.length ? chip('who', 'sel', '☑ אויסגעקליבן (' + s.codes.length + ')') : ''}
     ${tu ? chip('who', 'yr', 'באלאנס היי-יאר') + chip('who', 'tot', 'באלאנס אינגאנצן') + chip('who', 'all', 'אלע פאמיליעס') : chip('who', 'pl', 'אפענע פלעדזשעס') + chip('who', 'due', 'פעליג דעם חודש') + chip('who', 'yg', 'אלע YG נדבנים')}
     ${s.mode === 'bal' && !['all', 'yg', 'sel'].includes(s.who) ? `<label class="sub" style="margin:0">מינימום $<input type="number" value="${esc(s.min)}" style="width:80px" onchange="ui.sms.min=+this.value;vSmsc()"></label>` : ''}
     ${!tu && s.who !== 'yg' ? `<select class="mini" onchange="ui.sms.camp=+this.value||0;vSmsc()"><option value="">אלע קאמפעינס</option>${camps.map(n => `<option value="${n}" ${+s.camp === n ? 'selected' : ''}>${esc((JD.campaigns || {})[n] || '#' + n)}</option>`).join('')}</select>` : ''}</div>
    <label class="f">מעסעדזש<textarea id="smstx" rows="4" oninput="ui.sms.text=this.value;clearTimeout(window._smsT);window._smsT=setTimeout(smsRefresh,400)">${esc(smsTpl())}</textarea></label>
    <div class="row" style="flex-wrap:wrap;margin:6px 0 0">${tokens.map(k => `<button class="chip" onclick="smsIns('{${k}}')">+ ${TL[k]}</button>`).join('')}<span class="spacer"></span>
     <label class="sub" style="margin:0"><input type="checkbox" ${s.stop ? 'checked' : ''} onchange="ui.sms.stop=this.checked;vSmsc()"> "${SMS_STOP}"</label>
     <button class="btn ghost sm" onclick="smsSaveTpl()">Save text</button></div></div>
   <div id="smssum" class="box">${smsSummary(R, send, segs, sk)}</div>
   <div class="row" style="margin:6px 0"><button class="btn gold" ${svcOk && send.length ? '' : 'disabled'} onclick="smsSend()">📱 Send ${send.length.toLocaleString()} messages</button><span class="spacer"></span>
     <button class="btn ghost sm" onclick="smsConsent(true)">✓ Mark all shown as agreed</button></div>
   <div id="smslist">${smsList(R)}</div>`;
}
function smsSummary(R, send, segs, sk) {
  return `<b>${send.length.toLocaleString()}</b> וועלן באקומען · ${segs.toLocaleString()} SMS טיילן · בערך <b>${money(Math.round(segs * SMS_PER_SEG * 100) / 100)}</b>
   ${Object.keys(sk).length ? `<br><span class="dim">נישט געשיקט: ${Object.entries(sk).map(([k, v]) => k + ' ' + v).join(' · ')}</span>` : ''}`;
}
function smsList(R) {
  return `<table><thead><tr><th>נאמען</th><th>סעלפאון</th><th>מעסעדזש</th><th>SMS</th><th></th></tr></thead><tbody>${R.slice(0, 300).map(r => `<tr style="${r.skip ? 'opacity:.55' : ''}">
    <td><a class="name" onclick="${AREA === 'tu' ? `tuFamily(${r.code})` : `openAcct(${r.code})`}">${esc(r.vals.name)}</a> <small class="dim">#${r.code}</small></td>
    <td class="phn">${r.cell ? esc(smsFmtPh(r.cell)) : '—'}</td><td style="font-size:12.5px;white-space:pre-wrap;max-width:520px">${esc(r.body)}</td><td class="num">${smsSegs(r.body)}</td>
    <td>${r.skip ? `<span class="tag gray">${esc(r.skip)}</span>${r.skip === 'נישט מסכים' ? ` <button class="btn ghost sm" onclick="smsConsentOne(${r.code},true)">✓ Agreed</button>` : ''}` : `<button class="btn ghost sm" title="נישט מער מסכים" onclick="smsConsentOne(${r.code},false)">✕</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">קיינער</td></tr>'}</tbody></table>${R.length > 300 ? `<p class="sub">ווייזט 300 פון ${R.length.toLocaleString()} (אלע ווערן געשיקט)</p>` : ''}`;
}
function smsRefresh() { const R = smsRows(), send = R.filter(r => !r.skip), sk = {}; R.filter(r => r.skip).forEach(r => sk[r.skip] = (sk[r.skip] || 0) + 1); $('#smssum').innerHTML = smsSummary(R, send, send.reduce((n, r) => n + smsSegs(r.body), 0), sk); $('#smslist').innerHTML = smsList(R); }
function smsIns(t) { const e = $('#smstx'), p = e.selectionStart || e.value.length; e.value = e.value.slice(0, p) + t + e.value.slice(e.selectionEnd || p); ui.sms.text = e.value; e.focus(); smsRefresh(); }
async function smsSaveTpl() { await emit('settings', 's', { ['smsTpl_' + smsTplKey()]: $('#smstx').value }); toast('✓ Saved'); }
async function smsConsentOne(c, on) { await emit('acct', c, on ? { smsOk: true, smsOkAt: todayS(), smsOkBy: me } : { smsOk: false }); smsRefresh(); }
async function smsConsent(on) {
  const R = smsRows().filter(r => on ? !smsOk(r.code) && r.cell : smsOk(r.code)); if (!R.length) { toast('Nobody to change'); return; }
  if (!confirm(`${R.length} אקאונטס אנצייכענען אלס מסכים (מויל'דיג)?\nנאר אויב זיי האבן טאקע מסכים געווען צו באקומען טעקסטס.`)) return;
  await bulkEmit(R.map(r => ({ k: 'acct', eid: String(r.code), p: { smsOk: true, smsOkAt: todayS(), smsOkBy: me } })), R.length + ' marked as agreed');
}
// bulk bar: SMS to the selected / mark the selected as agreed
function bulkSms(k) { const s = smsState(); s.codes = selCodes(k).map(Number); s.who = 'sel'; go('smsc'); }
function bulkSmsOk(k, on) { const C = selCodes(k); if (on && !confirm(`${C.length} אקאונטס אנצייכענען אלס מסכים צו באקומען SMS (מויל'דיג)?`)) return; bulkEmit(C.map(c => ({ k: 'acct', eid: String(c), p: on ? { smsOk: true, smsOkAt: todayS(), smsOkBy: me } : { smsOk: false } })), C.length + (on ? ' marked as agreed' : ' unmarked')); }
const smsSvcOk = v => /^MG[0-9a-f]{32}$/i.test(v || '') || /^\+1(800|833|844|855|866|877|888)\d{7}$/.test(v || '');
function smsSetForm() {
  modal(`<h2>⚙️ SMS settings</h2>
   <label class="f">Messaging Service SID פון דער <b>מעלדונגען</b> קאמפעין (MG…), אדער א <b>טאול-פריי</b> נומער (+18…) וואס איז ווערופייד<input id="smssvc" style="direction:ltr" value="${esc(SET().smsSvc || '')}" placeholder="MG0123…"></label>
   <p class="sub">נישט דער "YG Fund SMS bot" service – דער איז נאר פאר ארבעטער. ליידיג = שיקן איז אפגעשטעלט.</p>
   <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn ghost" onclick="closeM()">Back</button><button class="btn" onclick="smsSetSave()">Save</button></div>`, 'narrow');
}
async function smsSetSave() { const v = $('#smssvc').value.trim(); if (v && !smsSvcOk(v)) { toast('⚠️ MG… or +18XX…'); return; } await emit('settings', 's', { smsSvc: v }); closeM(); render(); toast('✓ Saved'); }
async function smsSend() {
  const send = smsRows().filter(r => !r.skip); if (!send.length) return;
  const segs = send.reduce((n, r) => n + smsSegs(r.body), 0);
  if (!confirm(`שיקן ${send.length} SMS מעסעדזשעס (${segs} טיילן, בערך ${money(Math.round(segs * SMS_PER_SEG * 100) / 100)})?\n\nמען קען עס נישט צוריקנעמען.`)) return;
  let ok = 0, bad = 0; const errs = [];
  for (let i = 0; i < send.length; i += 20) {
    busy(`📱 שיקט… ${i} / ${send.length}`);
    try {
      const { data, error } = await sb.functions.invoke('smsout', { body: { area: AREA, msgs: send.slice(i, i + 20).map(r => ({ code: r.code, to: r.cell, body: r.body })) } });
      let m = error ? (error.message || String(error)) : data && data.error;
      if (error) try { const j = await error.context.json(); if (j && j.error) m = j.error; } catch (e) { }
      if (m) throw new Error(m);
      ok += data.sent || 0; bad += (data.failed || []).length; (data.failed || []).forEach(f => errs.push('#' + f.code + ': ' + f.error));
    } catch (e) { busy(false); toast('⚠️ ' + (e.message || e)); bad += send.length - i - ok; break; }
  }
  busy(false); await pullLog(); render();
  modal(`<h2>📱 SMS</h2><p><b>${ok}</b> געשיקט${bad ? ` · <b class="bal">${bad}</b> נישט` : ''}.</p>${errs.length ? `<div class="scroll" style="max-height:40vh;font-size:13px">${errs.map(esc).join('<br>')}</div>` : ''}<div class="row" style="justify-content:flex-end"><button class="btn" onclick="closeM()">Close</button></div>`, 'narrow');
}
