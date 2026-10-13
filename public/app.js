'use strict';
const META = {
  like: ['⚡', 'Send Likes', 'Send likes to a player UID in your selected region.', 'Submit Likes'],
  info: ['🪪', 'Player Information', 'Look up public profile details for a player.', 'Get Player Info'],
  level: ['📈', 'Player Level', 'Check the level of a player account.', 'Get Player Level'],
  jwt: ['🔑', 'JWT API', 'Request a token through the configured JWT service.', 'Request JWT'],
};
let state, active, busy = false;
$('#menu').addEventListener('click', e => { const n = $('#nav'); const o = n.classList.toggle('open'); e.currentTarget.setAttribute('aria-expanded', o); });
async function init() {
  reveal();
  const r = await api('/api/features');
  if (!r.ok) { $('#cards').replaceChildren(h('div', { class: 'card' }, 'Could not load features. Please refresh.')); return; }
  state = r.data;
  $('#cards').replaceChildren(...state.features.map(f => {
    const m = META[f.name];
    return h('button', { class: 'card', type: 'button', 'aria-pressed': 'false', 'data-n': f.name, onclick: () => open(f.name) },
      h('span', { class: 'ic', 'aria-hidden': 'true' }, m[0]), h('h3', {}, m[1]), h('p', {}, m[2]),
      h('span', { class: 'badge ' + (f.configured ? 'on' : 'off') }, f.configured ? 'Available' : 'Unavailable'));
  }));
}
function open(name) {
  active = name; busy = false;
  document.querySelectorAll('#cards .card').forEach(c => c.setAttribute('aria-pressed', c.dataset.n === name));
  const panel = $('#panel'), f = state.features.find(x => x.name === name), m = META[name];
  panel.hidden = false; panel.classList.add('show'); panel.replaceChildren(h('h2', {}, m[1]));
  if (!f.configured) { panel.append(h('p', { class: 'status err' }, `The ${m[1]} is currently unavailable — it has not been configured yet.`)); return; }
  if (name === 'like' && state.likeLimit.enabled) panel.append(h('p', { class: 'status' }, `Limit: ${state.likeLimit.max} request(s) per ${period(state.likeLimit.periodSeconds)}.`));
  const form = h('form', { novalidate: '' }), inputs = {};
  for (const fld of f.fields) {
    const id = 'f-' + fld; let el;
    if (fld === 'region') {
      el = h('select', { id, required: '' }, h('option', { value: '' }, 'Select region'), state.regions.map(r => h('option', { value: r.code }, r.label)));
    } else el = h('input', { id, required: '', autocomplete: 'off', maxlength: 500, type: /pass|secret|token|key/i.test(fld) ? 'password' : 'text', inputmode: fld === 'uid' ? 'numeric' : 'text', placeholder: fld === 'uid' ? 'Player UID (digits)' : fld });
    inputs[fld] = el; form.append(h('label', { for: id }, fld === 'uid' ? 'Player UID' : fld[0].toUpperCase() + fld.slice(1)), el);
  }
  if (inputs.region && !state.regions.length) panel.append(h('p', { class: 'status err' }, 'No regions are configured yet.'));
  const btn = h('button', { class: 'btn primary', type: 'submit' }, m[3]), st = h('span', { class: 'status', role: 'status' }), out = h('div');
  form.append(h('div', { class: 'row-a' }, btn, st)); panel.append(form, out);
  form.addEventListener('submit', async e => {
    e.preventDefault(); if (busy) return;
    const fields = {};
    for (const k in inputs) { const v = inputs[k].value.trim(); if (!v) { st.className = 'status err'; st.textContent = `Please fill in ${k}.`; inputs[k].focus(); return; } fields[k] = v; }
    if (fields.uid && !/^\d{4,20}$/.test(fields.uid)) { st.className = 'status err'; st.textContent = 'UID must be 4-20 digits.'; inputs.uid.focus(); return; }
    busy = true; btn.disabled = true; btn.replaceChildren(h('span', { class: 'spin' }), ' Processing…'); st.className = 'status'; st.textContent = 'Request in progress…';
    out.replaceChildren(h('div', { class: 'skel' }), h('div', { class: 'skel' }));
    const r = await api('/api/run/' + name, { method: 'POST', body: { fields } });
    busy = false; btn.disabled = false; btn.textContent = m[3];
    if (active !== name) return;
    out.replaceChildren();
    if (r.data.body !== undefined) renderResponse(out, r.data.body, r.data.isJson);
    if (r.ok && r.data.ok) { st.className = 'status ok'; st.textContent = 'Request completed.'; toast('Request completed', 'ok'); }
    else { const msg = r.data.error || 'Request failed'; st.className = 'status err'; st.textContent = msg; toast(msg, r.status === 429 ? 'warn' : 'err'); }
  });
}
function period(s) { return s % 86400 === 0 ? (s / 86400 === 1 ? 'day' : s / 86400 + ' days') : s % 3600 === 0 ? (s / 3600 === 1 ? 'hour' : s / 3600 + ' hours') : s + ' seconds'; }
init();
