/**
 * The prompt-inspector page served at GET /prompt (web-ui-module).
 *
 * Self-contained HTML: fetches /debug/context (same origin, same basic auth)
 * and renders the exact NormalizedRequest a live activation would send —
 * system prompt, compiled messages, tool definitions — with per-section token
 * estimates (chars/4; the same first-order heuristic the strategy budgets
 * with, before calibration). An "include injections" toggle refetches with
 * ?injections=1 and shows the dynamically gathered system injections (memory
 * RAG etc.) as a separate section, derived as the suffix the injected compile
 * added to the base system prompt. That variant is NOT side-effect-free (it
 * runs retrieval); the page says so next to the toggle.
 *
 * Read-only by design: connectome agents fire on events, not on a human's
 * send button, so a SillyTavern-style edit-before-send has no coherent hold
 * point here. Inspection only.
 */
export const PROMPT_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>prompt inspector</title>
<style>
:root{
  --surface:#FBFAF7; --ink:#211E19; --ink-2:#5C574D; --muted:#8A857C;
  --hair:#E8E4DB; --hair-2:#F0EDE5;
  --c-sys:#B45309; --c-inj:#7C5CBF; --c-msg:#4B78D6; --c-tool:#3E7D5C;
}
@media (prefers-color-scheme: dark){:root{
  --surface:#17191D; --ink:#E9E6DF; --ink-2:#B0ACA2; --muted:#8B8FA0;
  --hair:#2A2D34; --hair-2:#22252B;
  --c-sys:#C97426; --c-inj:#A98BE8; --c-msg:#6E9CEF; --c-tool:#5CA983;
}}
html{background:var(--surface)}
body{margin:0;background:var(--surface);color:var(--ink);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:28px 24px 80px}
h1{font-family:Palatino,"Iowan Old Style","Palatino Linotype",serif;
  font-size:26px;font-weight:600;margin:0 0 4px;text-wrap:balance}
.meta{color:var(--muted);font-size:13px;margin:0 0 20px}
.mono,pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:0 0 20px}
.tile{border:1px solid var(--hair);border-radius:6px;padding:11px 13px}
.tile .k{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.tile .v{font-size:22px;font-weight:600;margin-top:2px}
.tile .v small{font-size:12px;font-weight:400;color:var(--ink-2)}
.bar{display:flex;height:10px;border-radius:5px;overflow:hidden;border:1px solid var(--hair);margin:0 0 6px}
.bar div{height:100%}
.legend{display:flex;flex-wrap:wrap;gap:14px;align-items:center;padding:0 2px 18px;font-size:13px;color:var(--ink-2)}
.legend .sw{display:inline-block;width:14px;height:4px;border-radius:2px;vertical-align:middle;margin-right:6px}
.ctl{display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin:0 0 18px;font-size:13.5px;color:var(--ink-2)}
.ctl label{cursor:pointer;user-select:none}
.ctl .warn{color:var(--muted);font-size:12.5px}
details.sec{border:1px solid var(--hair);border-radius:6px;margin:0 0 10px;overflow:hidden}
details.sec>summary{cursor:pointer;list-style:none;display:flex;align-items:baseline;gap:10px;
  padding:10px 14px;font-size:14px;font-weight:600;background:var(--hair-2)}
details.sec>summary::-webkit-details-marker{display:none}
details.sec>summary .dot{width:9px;height:9px;border-radius:50%;flex:none;align-self:center}
details.sec>summary .est{margin-left:auto;font-weight:400;font-size:12.5px;color:var(--muted)}
details.sec .body{padding:12px 14px;overflow-x:auto}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.5}
.msg{border-top:1px solid var(--hair-2)}
.msg:first-child{border-top:none}
.msg>summary{cursor:pointer;list-style:none;display:flex;gap:10px;align-items:baseline;
  padding:7px 14px;font-size:13px}
.msg>summary::-webkit-details-marker{display:none}
.msg>summary .who{font-weight:600;min-width:110px}
.msg>summary .kinds{color:var(--muted);font-size:12px}
.msg>summary .est{margin-left:auto;color:var(--muted);font-size:12px}
.msg .body{padding:4px 14px 12px;overflow-x:auto}
.blk{margin:8px 0;padding:8px 10px;border:1px solid var(--hair-2);border-radius:5px}
.blk .bk{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
.err{color:#B4231F;white-space:pre-wrap}
#status{color:var(--muted);font-size:13px}
</style>
</head>
<body>
<div class="wrap">
<h1>prompt inspector</h1>
<p class="meta" id="meta">the exact request an activation would send, compiled now &mdash; loading&hellip;</p>
<div class="ctl">
  <label><input type="checkbox" id="inj"> include dynamic injections (memory RAG &mdash; runs retrieval; not side-effect-free)</label>
  <span id="status"></span>
</div>
<div class="tiles" id="tiles"></div>
<div class="bar" id="bar"></div>
<div class="legend" id="legend"></div>
<div id="out"></div>
</div>
<script>
'use strict';
const est = s => Math.round((s || '').length / 4);
const fmt = n => n.toLocaleString('en-US');
const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

// Base64 media is priced by providers per-image, not per-char; counting it
// as chars/4 turns a 100k-token window into a fictitious million. Estimate
// text-bearing blocks only and surface image counts separately.
function isImage(b){ return b.type === 'image' || (b.source && b.source.type === 'base64'); }
function blockText(b){
  if (b.type === 'text') return b.text || '';
  if (isImage(b)) return '';
  return JSON.stringify(b, stripMedia);
}
// JSON.stringify replacer: collapse long base64 runs to a size placeholder.
function stripMedia(k, v){
  if (typeof v === 'string' && v.length > 2048 && /^[A-Za-z0-9+/=\\r\\n]+$/.test(v)) {
    return '[base64 \\u2014 ' + Math.round(v.length / 1024) + 'kb stripped]';
  }
  return v;
}
function msgEst(m){ return (m.content || []).reduce((a,b) => a + est(blockText(b)), 0); }
function msgImages(m){ return (m.content || []).filter(isImage).length; }
function msgKinds(m){
  const k = {};
  for (const b of (m.content || [])) k[b.type] = (k[b.type] || 0) + 1;
  return Object.entries(k).map(([t,n]) => n > 1 ? t + '\\u00d7' + n : t).join(', ');
}

function renderBlock(b){
  const label = b.type + (b.name ? ' \\u00b7 ' + b.name : '');
  let text;
  if (b.type === 'text') text = b.text || '';
  else if (isImage(b)) text = '[image payload \\u2014 ' + Math.round(JSON.stringify(b).length / 1024) + 'kb base64, excluded from estimate]';
  else text = JSON.stringify(b, stripMedia, 2);
  return '<div class="blk"><div class="bk">' + esc(label) + '</div><pre>' + esc(text) + '</pre></div>';
}

let baseSystem = null; // system prompt from the transparent (no-injections) fetch

async function load(withInj){
  const status = document.getElementById('status');
  status.textContent = 'compiling\\u2026';
  document.getElementById('inj').disabled = true;
  try {
    // The injected view needs the base system prompt to split out the suffix.
    if (withInj && baseSystem === null) {
      const r0 = await fetch('/debug/context');
      if (!r0.ok) throw new Error('HTTP ' + r0.status + ': ' + await r0.text());
      baseSystem = (await r0.json()).request.system || '';
    }
    const r = await fetch('/debug/context' + (withInj ? '?injections=1' : ''));
    if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + await r.text());
    const data = await r.json();
    render(data, withInj);
    status.textContent = '';
  } catch (e) {
    status.textContent = '';
    document.getElementById('out').innerHTML = '<p class="err">failed to load: ' + esc(e.message || e) + '</p>';
  } finally {
    document.getElementById('inj').disabled = false;
  }
}

function render(data, withInj){
  const req = data.request;
  const fullSystem = req.system || '';
  let system = fullSystem, injected = '';
  if (withInj && baseSystem !== null && fullSystem.startsWith(baseSystem)) {
    system = baseSystem;
    injected = fullSystem.slice(baseSystem.length).replace(/^\\n/, '');
  }
  if (!withInj) baseSystem = fullSystem;

  const msgs = req.messages || [];
  const tools = req.tools || [];
  const eSys = est(system), eInj = est(injected);
  const eMsg = msgs.reduce((a,m) => a + msgEst(m), 0);
  const nImg = msgs.reduce((a,m) => a + msgImages(m), 0);
  const toolJson = t => JSON.stringify(t);
  const eTool = tools.reduce((a,t) => a + est(toolJson(t)), 0);
  const eTotal = eSys + eInj + eMsg + eTool;

  document.getElementById('meta').textContent =
    'agent: ' + data.agent + ' \\u00b7 ' + (data.transparent
      ? 'transparent preview (no inference, no writes)'
      : 'full-fidelity preview (injection hooks ran)')
    + ' \\u00b7 model: ' + (req.config && req.config.model || '?');

  const tiles = [
    ['est input total', eTotal, 'chars/4, pre-calibration'],
    ['system prompt', eSys, null],
    withInj ? ['injections', eInj, null] : null,
    ['history', eMsg, msgs.length + ' msgs'],
    ['tools', eTool, tools.length + ' defs'],
    nImg > 0 ? ['images', nImg, 'excluded from est'] : null,
  ].filter(Boolean);
  document.getElementById('tiles').innerHTML = tiles.map(([k,v,s]) =>
    '<div class="tile"><div class="k">' + k + '</div><div class="v">' + fmt(v)
    + (s ? ' <small>' + esc(s) + '</small>' : '') + '</div></div>').join('');

  const segs = [
    ['system', eSys, 'var(--c-sys)'],
    ['injections', eInj, 'var(--c-inj)'],
    ['history', eMsg, 'var(--c-msg)'],
    ['tools', eTool, 'var(--c-tool)'],
  ].filter(s => s[1] > 0);
  document.getElementById('bar').innerHTML = segs.map(([,v,c]) =>
    '<div style="width:' + (100 * v / Math.max(1, eTotal)) + '%;background:' + c + '"></div>').join('');
  document.getElementById('legend').innerHTML = segs.map(([n,v,c]) =>
    '<span><span class="sw" style="background:' + c + '"></span>' + n + ' \\u00b7 ' + fmt(v) + '</span>').join('');

  let h = '';
  h += sec('system prompt', 'var(--c-sys)', fmt(eSys) + ' est tok',
    '<pre>' + esc(system) + '</pre>', false);
  if (withInj) h += sec('dynamic injections (system position)', 'var(--c-inj)', fmt(eInj) + ' est tok',
    injected ? '<pre>' + esc(injected) + '</pre>' : '<pre>(none gathered this compile)</pre>', true);
  h += sec('messages', 'var(--c-msg)', msgs.length + ' msgs \\u00b7 ' + fmt(eMsg) + ' est tok',
    msgs.map((m,i) =>
      '<details class="msg"><summary><span class="who">' + esc(m.participant) + '</span>'
      + '<span class="kinds">' + esc(msgKinds(m)) + (m.cacheBreakpoint ? ' \\u00b7 cache\\u2713' : '') + '</span>'
      + '<span class="est">' + fmt(msgEst(m)) + '</span></summary>'
      + '<div class="body">' + (m.content || []).map(renderBlock).join('') + '</div></details>'
    ).join(''), true, true);
  h += sec('tools', 'var(--c-tool)', tools.length + ' defs \\u00b7 ' + fmt(eTool) + ' est tok',
    tools.map(t =>
      '<details class="msg"><summary><span class="who">' + esc(t.name) + '</span>'
      + '<span class="kinds">' + esc((t.description || '').split('\\n')[0].slice(0, 110)) + '</span>'
      + '<span class="est">' + fmt(est(toolJson(t))) + '</span></summary>'
      + '<div class="body"><pre>' + esc(JSON.stringify(t, null, 2)) + '</pre></div></details>'
    ).join(''), false, true);
  h += sec('raw request json (base64 media stripped)', 'var(--muted)', '',
    '<pre>' + esc(JSON.stringify(req, stripMedia, 2)) + '</pre>', false);
  document.getElementById('out').innerHTML = h;
}

function sec(title, color, estLabel, body, open, bare){
  return '<details class="sec"' + (open ? ' open' : '') + '><summary>'
    + '<span class="dot" style="background:' + color + '"></span>' + esc(title)
    + '<span class="est">' + estLabel + '</span></summary>'
    + (bare ? body : '<div class="body">' + body + '</div>') + '</details>';
}

document.getElementById('inj').addEventListener('change', e => load(e.target.checked));
load(false);
</script>
</body>
</html>`;
