'use strict';
const app = $('#app'), NAMES = { like: 'Like API', info: 'Info API', level: 'Level API', jwt: 'JWT API' };
const DEF = { like: 'region,uid', info: 'region,uid', level: 'region,uid', jwt: 'uid,password' };
const TABS = [['overview', 'Overview'], ['limits', 'User Limits'], ['regions', 'Region Management'], ['like', 'Like API'], ['info', 'Info API'], ['level', 'Level API'], ['jwt', 'JWT API'], ['test', 'Connection Testing']];
let tab = 'overview';
function confirmBox(msg) { return new Promise(res => { const d = $('#dlg'); $('#dlgmsg').textContent = msg; d.showModal();
  $('#dlgok').onclick = () => { d.close(); res(true); }; $('#dlgno').onclick = () => { d.close(); res(false); }; d.oncancel = () => res(false); }); }
async function guard(r) { if (r.status === 401 && r.data.error === 'Unauthorized') { login(); return false; } return true; }

function login() {
  const pw = h('input', { id: 'pw', type: 'password', autocomplete: 'current-password', required: '' }), err = h('div', { class: 'status err', role: 'alert' }), btn = h('button', { class: 'btn primary', type: 'submit' }, 'Login');
  const eye = h('button', { class: 'btn sm', type: 'button', 'aria-label': 'Show password', onclick: () => { const s = pw.type === 'password'; pw.type = s ? 'text' : 'password'; eye.textContent = s ? 'Hide' : 'Show'; eye.setAttribute('aria-label', s ? 'Hide password' : 'Show password'); } }, 'Show');
  const f = h("form", { class: "glass" }, h('div', { class: 'row-a', }, h('img', { src: '/logo.webp', alt: '', width: 48, height: 48, class: 'logo-sm' }), h('h2', {}, 'Admin Login')),
    h('label', { for: 'pw' }, 'Admin password'), h('div', { class: 'pw' }, pw, eye), h('div', { class: 'row-a' }, btn, err));
  f.addEventListener('submit', async e => { e.preventDefault(); err.textContent = ''; btn.disabled = true; btn.replaceChildren(h('span', { class: 'spin' }), ' Checking…');
    const r = await api('/api/admin/login', { method: 'POST', body: { password: pw.value } });
    btn.disabled = false; btn.textContent = 'Login';
    if (r.ok) dash(); else err.textContent = r.status === 401 ? 'Incorrect password' : (r.data.error || 'Login failed'); });
  const w = h('div', { class: 'wrap', }, h('div', { id: 'lw' }, f)); app.replaceChildren(w); w.firstChild.style.maxWidth = '420px'; w.firstChild.style.margin = '70px auto'; pw.focus();
}
async function dash() {
  const me = await api('/api/admin/me'); if (!me.ok) return login();
  const side = h('div', { class: 'side', role: 'navigation', 'aria-label': 'Admin' },
    TABS.map(([k, l]) => h('button', { class: 'btn', type: 'button', 'aria-current': k === tab, onclick: () => { tab = k; dash(); } }, l)),
    h('button', { class: 'btn danger', type: 'button', onclick: async () => { await api('/api/admin/logout', { method: 'POST' }); login(); } }, 'Logout'));
  const content = h('section', { class: 'glass', 'aria-live': 'polite' }, h('div', { class: 'skel' }));
  app.replaceChildren(h('div', { class: 'wrap' }, h('div', { class: 'row-a' }, h('img', { src: '/logo.webp', alt: '', width: 40, height: 40 }), h('h1', {}, 'SUPER LIKES BOT · Admin')), h('div', { class: 'admin' }, side, content)));
  await ({ overview, limits, regions, test }[tab] || (() => apiPanel(tab)))(content);
}
const badge = a => h('span', { class: 'badge ' + (a.configured ? 'on' : 'off') }, a.configured ? 'Configured' : 'Not Configured');
const statusBadge = a => a.last_status ? h('span', { class: 'badge ' + (/^(Reachable|HTTP 2)/.test(a.last_status) ? 'on' : 'off') }, /^(Reachable|HTTP 2)/.test(a.last_status) ? 'Connection Successful' : 'Connection Failed: ' + a.last_status) : null;

async function overview(c) {
  const r = await api('/api/admin/overview'); if (!await guard(r)) return; const d = r.data;
  c.replaceChildren(h('h2', {}, 'Overview'), h('div', { class: 'grid' },
    d.apis.map(a => h('div', { class: 'card' }, h('h3', {}, NAMES[a.name]), badge(a), ' ', statusBadge(a) || '', a.last_ok ? h('p', { class: 'status' }, 'Last success: ' + new Date(a.last_ok).toLocaleString()) : '')),
    h('div', { class: 'card' }, h('h3', {}, 'Regions'), h('p', {}, `${d.regions.active} active / ${d.regions.total} total`)),
    h('div', { class: 'card' }, h('h3', {}, 'Like limit'), h('p', {}, d.limit.enabled ? `${d.limit.max} per ${d.limit.periodSeconds} s` : 'Disabled'))));
}
async function limits(c) {
  const r = await api('/api/admin/limit'); if (!await guard(r)) return; const l = r.data;
  const en = h('input', { type: 'checkbox', id: 'en' }), max = h('input', { id: 'mx', type: 'number', min: 1, value: l.max }), per = h('input', { id: 'pr', type: 'number', min: 1, value: l.periodSeconds / 3600 || 1, step: 'any' }); en.checked = l.enabled;
  const save = async () => { const x = await api('/api/admin/limit', { method: 'PUT', body: { enabled: en.checked, max: +max.value, periodSeconds: Math.round(+per.value * 3600) } });
    x.ok ? (toast('Limit saved'), limits(c)) : toast(x.data.error, 'err'); };
  c.replaceChildren(h('h2', {}, 'User Limit Settings'), h('p', { class: 'status' }, 'Applies to Like requests only. Active: ' + (l.enabled ? `${l.max} per ${l.periodSeconds / 3600} h` : 'disabled (unlimited)')),
    h('label', { for: 'en' }, 'Enable Like limit'), en, h('label', { for: 'mx' }, 'Like requests allowed per user per period'), max,
    h('label', { for: 'pr' }, 'Period (hours)'), per, h('div', { class: 'row-a' }, h('button', { class: 'btn primary', onclick: save }, 'Save limit')));
}
async function regions(c) {
  const r = await api('/api/admin/regions'); if (!await guard(r)) return;
  const code = h('input', { id: 'rc', maxlength: 16, placeholder: 'Code required by your Like API' }), label = h('input', { id: 'rl', maxlength: 40, placeholder: 'Display name' });
  const list = r.data.map(x => h('div', { class: 'fr' }, h('span', { class: 'v' }, `${x.label} (${x.code}) `, h('span', { class: 'badge ' + (x.enabled ? 'on' : 'off') }, x.enabled ? 'Enabled' : 'Disabled')),
    h('span', {}, h('button', { class: 'btn sm', onclick: async () => { const n = prompt('New display name', x.label); if (n === null) return; const y = await api('/api/admin/regions/' + encodeURIComponent(x.code), { method: 'PUT', body: { label: n, enabled: x.enabled } }); y.ok ? (toast('Region updated'), regions(c)) : toast(y.data.error, 'err'); } }, 'Rename'), ' ',
      h('button', { class: 'btn sm', onclick: async () => { const y = await api('/api/admin/regions/' + encodeURIComponent(x.code), { method: 'PUT', body: { label: x.label, enabled: !x.enabled } }); y.ok ? regions(c) : toast(y.data.error, 'err'); } }, x.enabled ? 'Disable' : 'Enable'), ' ',
      h('button', { class: 'btn sm danger', onclick: async () => { if (!await confirmBox(`Delete region ${x.code}?`)) return; const y = await api('/api/admin/regions/' + encodeURIComponent(x.code), { method: 'DELETE' }); y.ok ? (toast('Region removed'), regions(c)) : toast(y.data.error, 'err'); } }, 'Delete'))));
  c.replaceChildren(h('h2', {}, 'Region Management'), list.length ? list : h('p', { class: 'status' }, 'No regions configured.'),
    h('h3', 'Add region'), h('label', { for: 'rc' }, 'Code'), code, h('label', { for: 'rl' }, 'Label'), label,
    h('div', { class: 'row-a' }, h('button', { class: 'btn primary', onclick: async () => { const y = await api('/api/admin/regions', { method: 'POST', body: { code: code.value.trim(), label: label.value } }); y.ok ? (toast('Region added'), regions(c)) : toast(y.data.error, 'err'); } }, 'Add region')));
}
async function apiPanel(name) {
  const c = $('section.glass'), r = await api('/api/admin/apis'); if (!await guard(r)) return; const a = r.data.find(x => x.name === name);
  const url = h('input', { id: 'u', placeholder: 'https://host/path?uid={uid}&region={region}' }), method = h('select', { id: 'm' }, h('option', {}, 'GET'), h('option', {}, 'POST')),
    bt = h('select', { id: 'bt' }, h('option', { value: 'none' }, 'No body'), h('option', { value: 'json' }, 'JSON'), h('option', { value: 'form' }, 'Form (urlencoded)')),
    body = h('textarea', { id: 'b', placeholder: '{"uid":"{uid}","region":"{region}"}' }), hd = h('textarea', { id: 'hd', placeholder: a.hasHeaders ? '(stored — leave blank to keep, type {} to clear)' : '{"x-api-key":"..."}' }),
    fl = h('input', { id: 'fl', value: a.fields ? a.fields.join(',') : DEF[name] });
  if (a.configured) { method.value = a.method; bt.value = a.bodyType; url.placeholder = a.endpoint + ' (re-enter full URL to change)'; }
  const save = async () => { const p = { url: url.value || (a.configured ? '' : ''), method: method.value, bodyType: bt.value, body: body.value, fields: fl.value };
    if (hd.value.trim()) p.headers = hd.value.trim() === '{}' ? '' : hd.value; if (!p.url) return toast('Enter the full endpoint URL', 'err');
    const x = await api('/api/admin/apis/' + name, { method: 'PUT', body: p }); x.ok ? (toast('API configuration saved'), apiPanel(name)) : toast(x.data.error, 'err'); };
  c.replaceChildren(h('h2', {}, NAMES[name]), badge(a), ' ', statusBadge(a) || '', a.configured ? h('p', { class: 'status' }, `Endpoint: ${a.endpoint} · ${a.method} · inputs: ${a.fields.join(', ')}${a.last_ok ? ' · last success ' + new Date(a.last_ok).toLocaleString() : ''}`) : h('p', { class: 'status' }, 'Not configured. Enter the endpoint details from your API provider’s documentation.'),
    h('label', { for: 'u' }, 'Endpoint URL (use {uid}, {region}… placeholders)'), url, h('label', { for: 'm' }, 'Method'), method,
    h('label', { for: 'fl' }, 'Public input fields (comma-separated; each becomes a {placeholder})'), fl, h('label', { for: 'bt' }, 'Body type'), bt, h('label', { for: 'b' }, 'Body template'), body,
    h('label', { for: 'hd' }, 'Secret headers (JSON, write-only, stored encrypted)'), hd,
    h('div', { class: 'row-a' }, h('button', { class: 'btn primary', onclick: save }, a.configured ? 'Update' : 'Save'),
      a.configured ? [h('button', { class: 'btn', onclick: async () => { const x = await api(`/api/admin/apis/${name}/test`, { method: 'POST' }); toast(x.data.message || x.data.error, x.data.ok ? 'ok' : 'err'); apiPanel(name); } }, 'Test connection'),
        h('button', { class: 'btn danger', onclick: async () => { if (!await confirmBox(`Remove the ${NAMES[name]} configuration?`)) return; const x = await api('/api/admin/apis/' + name, { method: 'DELETE' }); x.ok ? (toast('API removed', 'warn'), apiPanel(name)) : toast(x.data.error, 'err'); } }, 'Remove')] : ''));
}
async function test(c) {
  const r = await api('/api/admin/apis'); if (!await guard(r)) return;
  c.replaceChildren(h('h2', {}, 'API Connection Testing'), h('p', { class: 'status' }, 'Checks that each endpoint’s server is reachable. No Likes are sent.'),
    r.data.map(a => h('div', { class: 'fr' }, h('span', { class: 'v' }, NAMES[a.name] + ' ', badge(a), ' ', statusBadge(a) || ''),
      h('button', { class: 'btn sm', disabled: !a.configured, onclick: async e => { e.target.disabled = true; const x = await api(`/api/admin/apis/${a.name}/test`, { method: 'POST' }); toast(x.data.message || x.data.error, x.data.ok ? 'ok' : 'err'); test(c); } }, 'Test'))));
}
dash();
