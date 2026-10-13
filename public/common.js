'use strict';
const $ = (s, r = document) => r.querySelector(s);
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) k === 'class' ? e.className = v : k.startsWith('on') ? e.addEventListener(k.slice(2), v) : e.setAttribute(k, v);
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
function toast(msg, type = 'ok') {
  let box = $('#toasts'); if (!box) { box = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: 'toast ' + type }, msg); box.append(t); setTimeout(() => t.remove(), 3200);
}
async function copyText(text, label = 'Copied!') {
  try { await navigator.clipboard.writeText(text); }
  catch { const t = h('textarea', { 'aria-hidden': 'true' }); t.value = text; document.body.append(t); t.select();
    const ok = document.execCommand('copy'); t.remove(); if (!ok) return toast('Copy failed', 'err'); }
  toast(label, 'ok');
}
async function api(path, opts = {}) {
  const o = { method: opts.method || 'GET', headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' };
  if (opts.body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opts.body); }
  let r, d; try { r = await fetch(path, o); } catch { return { status: 0, data: { error: 'Network error. Check your connection.' } }; }
  try { d = await r.json(); } catch { d = { error: 'Unexpected server response' }; }
  return { status: r.status, ok: r.ok, data: d };
}
function reveal() {
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('show'); io.unobserve(e.target); } }), { threshold: .1 });
  document.querySelectorAll('.reveal').forEach(e => io.observe(e));
}
// ----- response viewer: formatted tree + raw view, full & per-field copy. Uses textContent only. -----
function renderResponse(box, body, isJson) {
  box.replaceChildren();
  let data; if (isJson) { try { data = JSON.parse(body); } catch { isJson = false; } }
  const fmt = h('div'), raw = h('pre', { class: 'raw', tabindex: '0' }, body);
  const show = v => { fmt.hidden = v !== 'f'; raw.hidden = v !== 'r'; bf.setAttribute('aria-pressed', v === 'f'); br.setAttribute('aria-pressed', v === 'r'); };
  const bf = h('button', { class: 'btn sm', type: 'button', onclick: () => show('f') }, 'Formatted');
  const br = h('button', { class: 'btn sm', type: 'button', onclick: () => show('r') }, isJson ? 'Raw JSON' : 'Raw text');
  const cp = h('button', { class: 'btn sm primary', type: 'button', onclick: () => copyText(body, 'Full response copied!') }, 'Copy Full Response');
  box.append(h('div', { class: 'row-a tabs' }, isJson ? [bf, br] : [br], cp));
  if (isJson) { fmt.append(node(data, '', 'response')); box.append(fmt, raw); show('f'); } else { box.append(raw); show('r'); }
}
function node(v, path, label) {
  const copyBtn = text => h('button', { class: 'btn sm', type: 'button', 'aria-label': 'Copy ' + label, onclick: () => copyText(text, `Copied ${label}!`) }, 'Copy');
  if (v !== null && typeof v === 'object') {
    const isArr = Array.isArray(v), keys = isArr ? v.map((_, i) => i) : Object.keys(v);
    const wrap = h('div', {}, h('div', { class: 'fr' }, h('span', { class: 'k' }, label + (isArr ? ` [${keys.length}]` : '')), h('span', { class: 'v' }, keys.length ? '' : (isArr ? '[]' : '{}')), copyBtn(JSON.stringify(v, null, 2))));
    if (keys.length) wrap.append(h('div', { class: 'tree' }, keys.map(k => node(v[k], path + '.' + k, isArr ? `[${k}]` : k))));
    return wrap;
  }
  return h('div', { class: 'fr' }, h('span', { class: 'k', title: path }, label), h('span', { class: 'v' }, v === null ? 'null' : String(v)), copyBtn(v === null ? 'null' : String(v)));
}
