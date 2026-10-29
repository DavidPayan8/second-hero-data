'use strict';
// Front del panel. Todo texto que viene de la BD o del servidor entra en el DOM con textContent, nunca con innerHTML.
const $ = (id) => document.getElementById(id);
function el(tag, props, ...hijos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const h of hijos.flat()) if (h !== null && h !== undefined && h !== false) e.append(h);
  return e;
}

async function api(ruta, opciones = {}) {
  const r = await fetch(ruta, {
    method: opciones.body ? 'POST' : 'GET',
    headers: opciones.body ? { 'content-type': 'application/json' } : {},
    body: opciones.body ? JSON.stringify(opciones.body) : undefined,
  });
  let datos = {};
  try { datos = await r.json(); } catch { /* cuerpo vacío */ }
  if (r.status === 401 && ruta !== '/api/login') { mostrarLogin(); throw new Error('Sesión caducada'); }
  if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);
  return datos;
}

// ---------- sesión y pestañas ----------
function mostrarLogin() {
  $('top').hidden = true; $('revision').hidden = true; $('visor').hidden = true; $('login').hidden = false;
}
async function entrar(usuario) {
  $('login').hidden = true; $('top').hidden = false; $('who').textContent = usuario;
  irA('revision');
  await cargarRevision();
}
function irA(tab) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('revision').hidden = tab !== 'revision';
  $('visor').hidden = tab !== 'visor';
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => irA(b.dataset.tab)));
$('logout').addEventListener('click', async () => { await api('/api/logout', { body: {} }); mostrarLogin(); });
$('login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  $('login-error').textContent = '';
  try {
    const r = await api('/api/login', { body: { usuario: f.get('usuario'), clave: f.get('clave') } });
    ev.target.reset();
    await entrar(r.usuario);
  } catch (e) { $('login-error').textContent = e.message; }
});

// ---------- revisión ----------
let empresas = [];
const AYUDA = 'Vincular: este ISIN es una acción de esta empresa y se guarda. Rechazar: no lo es, y no vuelve a proponerse. Pendiente: aún sin decidir.';
const ETIQUETA = { proposed: 'Pendiente', accepted: 'Vincular', rejected: 'Rechazar' };

function progreso() {
  const filas = empresas.flatMap((e) => e.filas);
  const hechas = filas.filter((f) => f.status !== 'proposed').length;
  $('progress-text').textContent = `Progreso: ${hechas} de ${filas.length}`;
  $('progress-fill').style.width = filas.length ? `${(100 * hechas) / filas.length}%` : '0';
}

function nodoFila(emp, f) {
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': `Decisión para ${f.isin}` });
  for (const estado of ['proposed', 'accepted', 'rejected']) {
    const activo = f.status === estado;
    seg.append(el('button', {
      type: 'button', class: activo ? `on-${estado}` : '', 'aria-pressed': String(activo),
      onclick: async () => {
        if (activo) return;
        seg.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        try {
          const nueva = await api('/api/revision/decision', { body: { lei: emp.lei, isin: f.isin, decision: estado } });
          emp.filas = emp.filas.map((x) => (x.isin === f.isin ? nueva : x));
          reemplazar(emp);
          progreso();
          $('revision-msg').textContent = '';
        } catch (e) { $('revision-msg').textContent = e.message; seg.querySelectorAll('button').forEach((b) => { b.disabled = false; }); }
      },
    }, ETIQUETA[estado]));
  }
  return el('div', { class: 'fila' },
    el('div', {}, el('div', { class: 'isin' }, f.isin), el('div', { class: 'sub' }, [f.symbol, f.type].filter(Boolean).join(' · '))),
    el('div', { class: 'aviso' }, el('span', { class: `tag ${f.aviso}` }, f.aviso === 'sugerido' ? 'Sugerido' : 'Revisar'), f.motivo),
    el('div', {}, seg, f.reviewedBy ? el('div', { class: 'por' }, `${f.reviewedBy}, ${new Date(f.reviewedAt).toLocaleString()}`) : null),
    el('div', { class: 'ayuda' }, AYUDA));
}

function nodoEmpresa(emp) {
  const nombre = emp.filas.find((f) => f.name)?.name ?? emp.lei;
  return el('div', { class: 'empresa', 'data-lei': emp.lei },
    el('div', { class: 'empresa-h' }, el('b', {}, nombre), el('span', { class: 'sub' }, `LEI ${emp.lei} · informe ${emp.country ?? '?'}`)),
    emp.filas.map((f) => nodoFila(emp, f)));
}
function reemplazar(emp) {
  const viejo = $('empresas').querySelector(`[data-lei="${emp.lei}"]`);
  if (viejo) viejo.replaceWith(nodoEmpresa(emp));
}
function pintarEmpresas() {
  const solo = $('solo-pendientes').checked;
  $('empresas').replaceChildren(...empresas.filter((e) => !solo || e.filas.some((f) => f.status === 'proposed')).map(nodoEmpresa));
  progreso();
  if (!$('empresas').children.length) $('empresas').append(el('p', { class: 'msg' }, 'No hay empresas que mostrar.'));
}
async function cargarRevision() {
  $('revision-msg').textContent = 'Cargando…';
  try {
    empresas = (await api('/api/revision')).empresas;
    $('revision-msg').textContent = '';
    pintarEmpresas();
  } catch (e) { $('revision-msg').textContent = e.message; }
}
$('solo-pendientes').addEventListener('change', pintarEmpresas);

// "Aplicar sugerencias" pide una segunda pulsación (sin diálogos del navegador).
let confirmando = null;
$('aplicar').addEventListener('click', async () => {
  const boton = $('aplicar');
  const n = empresas.flatMap((e) => e.filas).filter((f) => f.status === 'proposed' && f.aviso === 'sugerido').length;
  if (!confirmando) {
    if (n === 0) { $('revision-msg').textContent = 'No hay sugerencias pendientes.'; return; }
    boton.textContent = `Confirmar: vincular ${n}`;
    $('revision-msg').textContent = `Se vincularán ${n} filas marcadas “Sugerido”. No se toca nada más. Pulsa de nuevo para confirmar.`;
    confirmando = setTimeout(() => { confirmando = null; boton.textContent = 'Aplicar sugerencias'; $('revision-msg').textContent = ''; }, 8000);
    return;
  }
  clearTimeout(confirmando); confirmando = null;
  boton.disabled = true;
  try {
    const r = await api('/api/revision/sugerencias', { body: {} });
    $('revision-msg').textContent = `Vinculadas ${r.cambiadas} filas.`;
    await cargarRevision();
  } catch (e) { $('revision-msg').textContent = e.message; }
  boton.disabled = false; boton.textContent = 'Aplicar sugerencias';
});

// ---------- visor ----------
let actual = null; // { resumen, hashOk, json }
let vista = 'arbol';
const MAX_HIJOS = 200;
const MAX_TEXTO = 2_000_000;

$('buscar-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('visor-msg').textContent = 'Buscando…';
  try {
    const lista = await api(`/api/blobs?q=${encodeURIComponent($('buscar-q').value)}`);
    $('visor-msg').textContent = lista.length ? `${lista.length} resultados` : 'Sin resultados.';
    $('resultados').replaceChildren(...lista.map((b) => el('li', { onclick: (e) => abrirBlob(b.contentHash, e.currentTarget) },
      el('div', { class: 'h' }, b.contentHash.slice(0, 16) + '…'),
      el('div', { class: 'sub' }, [b.source, b.endpoint].filter(Boolean).join(' · ') || 'sin llamada asociada'),
      el('div', { class: 'sub' }, `${b.bodyFormat} · ${(b.sizeBytes / 1024).toFixed(1)} KB${b.fetchedAt ? ' · ' + new Date(b.fetchedAt).toLocaleDateString() : ''}`))));
  } catch (e) { $('visor-msg').textContent = e.message; }
});

async function abrirBlob(hash, li) {
  document.querySelectorAll('.resultados li').forEach((x) => x.classList.toggle('sel', x === li));
  $('visor-msg').textContent = 'Abriendo…';
  try {
    actual = await api(`/api/blobs/${hash}`);
    $('visor-msg').textContent = '';
    $('detalle').hidden = false;
    const r = actual.resumen;
    $('meta').replaceChildren(
      el('span', { class: `badge ${actual.hashOk ? 'ok' : 'no'}` }, actual.hashOk ? 'hash correcto' : 'el hash NO coincide'),
      el('span', {}, el('span', { class: 'k' }, 'hash '), r.contentHash),
      el('span', {}, el('span', { class: 'k' }, 'formato '), r.bodyFormat),
      el('span', {}, el('span', { class: 'k' }, 'comprimido '), `${(r.sizeBytes / 1024).toFixed(1)} KB`),
      r.source ? el('span', {}, el('span', { class: 'k' }, 'fuente '), r.source) : null,
      r.endpoint ? el('span', {}, el('span', { class: 'k' }, 'endpoint '), r.endpoint) : null);
    const esTabla = Array.isArray(actual.json) && actual.json.length > 0 && actual.json.every((x) => x && typeof x === 'object' && !Array.isArray(x));
    $('vtab-tabla').disabled = !esTabla;
    if (!esTabla && vista === 'tabla') vista = 'arbol';
    pintarVista();
  } catch (e) { $('visor-msg').textContent = e.message; }
}

document.querySelectorAll('.vtab').forEach((b) => b.addEventListener('click', () => { if (!b.disabled) { vista = b.dataset.vista; pintarVista(); } }));
$('copiar').addEventListener('click', async () => {
  if (!actual) return;
  try { await navigator.clipboard.writeText(JSON.stringify(actual.json, null, 2)); $('visor-msg').textContent = 'Copiado.'; } catch { $('visor-msg').textContent = 'No se pudo copiar.'; }
});
$('descargar').addEventListener('click', () => {
  if (!actual) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(actual.json, null, 2)], { type: 'application/json' }));
  el('a', { href: url, download: `${actual.resumen.contentHash.slice(0, 12)}.json` }).click();
  URL.revokeObjectURL(url);
});

function pintarVista() {
  document.querySelectorAll('.vtab').forEach((b) => b.classList.toggle('active', b.dataset.vista === vista));
  const cont = $('vista');
  if (vista === 'texto') {
    const t = JSON.stringify(actual.json, null, 2);
    cont.replaceChildren(el('pre', {}, t.length > MAX_TEXTO ? t.slice(0, MAX_TEXTO) + '\n… (recortado; usa Descargar para ver todo)' : t));
  } else if (vista === 'tabla') {
    const filas = actual.json.slice(0, 500);
    const cols = [...new Set(filas.slice(0, 50).flatMap((f) => Object.keys(f)))];
    const celda = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    cont.replaceChildren(el('table', { class: 'datos' },
      el('thead', {}, el('tr', {}, cols.map((c) => el('th', {}, c)))),
      el('tbody', {}, filas.map((f) => el('tr', {}, cols.map((c) => el('td', { title: celda(f[c]) }, celda(f[c])))))),
    ), actual.json.length > 500 ? el('p', { class: 'msg' }, `Se muestran 500 de ${actual.json.length} filas.`) : null);
  } else {
    cont.replaceChildren(nodoJson(null, actual.json, true));
  }
}

function hoja(clave, valor) {
  const tipo = valor === null ? 'b' : typeof valor === 'string' ? 's' : typeof valor === 'number' ? 'n' : 'b';
  const txt = typeof valor === 'string' ? JSON.stringify(valor) : String(valor);
  return el('div', { class: 'leaf' }, clave === null ? null : el('span', { class: 'k' }, clave + ': '), el('span', { class: tipo }, txt));
}
function nodoJson(clave, valor, abierto) {
  if (valor === null || typeof valor !== 'object') return hoja(clave, valor);
  const esArray = Array.isArray(valor);
  const entradas = esArray ? valor.map((v, i) => [String(i), v]) : Object.entries(valor);
  const d = el('details', {}, el('summary', {},
    clave === null ? null : el('span', { class: 'k' }, clave + ': '), esArray ? `[${entradas.length}]` : `{${entradas.length}}`));
  const llenar = (desde) => {
    for (const [k, v] of entradas.slice(desde, desde + MAX_HIJOS)) d.append(nodoJson(k, v, false));
    if (desde + MAX_HIJOS < entradas.length) {
      const mas = el('button', { class: 'link mas', type: 'button', onclick: () => { mas.remove(); llenar(desde + MAX_HIJOS); } }, `Mostrar más (${entradas.length - desde - MAX_HIJOS} restantes)`);
      d.append(mas);
    }
  };
  let lleno = false;
  d.addEventListener('toggle', () => { if (d.open && !lleno) { lleno = true; llenar(0); } });
  if (abierto) d.open = true;
  return d;
}

// ---------- arranque ----------
(async () => {
  try { const me = await api('/api/me'); await entrar(me.usuario); } catch { mostrarLogin(); }
})();
