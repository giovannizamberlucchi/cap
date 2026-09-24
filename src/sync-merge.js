// V5 lot 5 : fusion à 3 voies de l'état de Cap (base commune, version locale, version cloud).
// Module pur (ni React ni Supabase), testé par `npm test` (tests/sync-merge.test.js).
//
// Principe : champ par champ, on garde le côté qui a changé par rapport à la base. Si les deux ont
// changé le même champ différemment → vrai conflit : la modification la plus récente gagne
// (opts.localNewer), l'autre valeur est renvoyée dans `conflicts` (mise de côté, jamais perdue).
// - Arbres (tâches/sous-tâches, caps) : fusionnés nœud par nœud par id, parent et position compris
//   (un déplacement ne crée jamais de doublon).
// - Listes d'objets avec id : élément par élément. Listes de valeurs simples (jours cochés, créneaux…)
//   et d'objets sans id (journal de focus) : ensembles, ajouts et retraits des deux côtés combinés.
// - Suppression d'un côté + modification de l'autre : l'élément est gardé (une saisie ne se perd pas).
// - Compteurs (temps réel, pomodoros) : les incréments des deux côtés s'additionnent.

// Champs résolus sans être signalés comme conflit (horodatages techniques)
const SILENT_FIELDS = new Set(['completedAt', 'statusChangedAt', 'reachedAt', 'createdAt', 'updatedAt', 'schemaVersion']);
// Compteurs : on additionne les incréments des deux côtés
const COUNTER_FIELDS = new Set(['actualMinutes', 'pomosDone']);
// Arbres : clé de la liste des enfants
const TREES = { items: 'subtasks', caps: 'children' };

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a).filter(k => a[k] !== undefined), kb = Object.keys(b).filter(k => b[k] !== undefined);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

// Clé stable d'une valeur (ensembles d'objets sans id)
function stableKey(v) {
  if (!isObj(v) && !Array.isArray(v)) return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableKey).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableKey(v[k])).join(',') + '}';
}

// Ordre fusionné : l'ordre local, puis chaque id absent du local inséré juste avant l'élément qui le
// suit côté cloud (à la fin s'il n'a pas de successeur connu).
function mergeOrder(localIds, remoteIds, keep) {
  const out = localIds.filter(id => keep.has(id));
  const seen = new Set(out);
  for (let i = remoteIds.length - 1; i >= 0; i--) {
    const id = remoteIds[i];
    if (!keep.has(id) || seen.has(id)) continue;
    let pos = out.length;
    for (let j = i + 1; j < remoteIds.length; j++) {
      const k = out.indexOf(remoteIds[j]);
      if (k !== -1) { pos = k; break; }
    }
    out.splice(pos, 0, id);
    seen.add(id);
  }
  keep.forEach(id => { if (!seen.has(id)) out.push(id); });
  return out;
}

function makeCtx(opts) {
  return { localNewer: !!(opts && opts.localNewer), report: !(opts && opts.noReport), conflicts: [] };
}

function conflict(ctx, path, l, r, meta) {
  const keptLocal = ctx.localNewer;
  const kept = keptLocal ? l : r;
  const field = path[path.length - 1];
  if (ctx.report && !SILENT_FIELDS.has(field)) {
    ctx.conflicts.push({ path: path.join('.'), field, kept, other: keptLocal ? r : l, keptSide: keptLocal ? 'local' : 'cloud', ...(meta || {}) });
  }
  return kept;
}

// Fusion générique d'une valeur. `undefined` = absent de ce côté.
function merge3(b, l, r, path, ctx, meta) {
  if (deepEqual(l, r)) return l;
  if (deepEqual(b, l)) return r;
  if (deepEqual(b, r)) return l;
  const field = path[path.length - 1];
  // Suppression d'un côté, modification de l'autre → on garde la modification
  if (l === undefined) return r;
  if (r === undefined) return l;
  if (COUNTER_FIELDS.has(field) && typeof l === 'number' && typeof r === 'number') {
    const base = typeof b === 'number' ? b : 0;
    return base + (l - base) + (r - base);
  }
  if (isObj(l) && isObj(r)) return mergeObjects(isObj(b) ? b : undefined, l, r, path, ctx, meta);
  if (Array.isArray(l) && Array.isArray(r)) return mergeArrays(Array.isArray(b) ? b : [], l, r, path, ctx, meta);
  return conflict(ctx, path, l, r, meta);
}

function mergeObjects(b, l, r, path, ctx, meta) {
  const out = {};
  const keys = new Set([...Object.keys(l), ...Object.keys(r), ...Object.keys(b || {})]);
  for (const k of keys) {
    const v = merge3(b ? b[k] : undefined, l[k], r[k], [...path, k], ctx, meta);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function mergeArrays(b, l, r, path, ctx, meta) {
  const all = [...b, ...l, ...r];
  if (all.length && all.every(x => isObj(x) && x.id !== undefined && x.id !== null)) return mergeById(b, l, r, path, ctx, meta);
  // Ensemble : (base ∪ ajouts des deux côtés) − retraits des deux côtés, ordre local d'abord
  const kb = new Set(b.map(stableKey)), kl = new Set(l.map(stableKey)), kr = new Set(r.map(stableKey));
  const out = [], seen = new Set();
  const push = v => { const k = stableKey(v); if (seen.has(k)) return; seen.add(k); out.push(v); };
  for (const v of l) { const k = stableKey(v); if (kr.has(k) || !kb.has(k)) push(v); }
  for (const v of r) { const k = stableKey(v); if (!kb.has(k)) push(v); }
  return out;
}

function mergeById(b, l, r, path, ctx, meta) {
  const mb = new Map(b.map(x => [x.id, x])), ml = new Map(l.map(x => [x.id, x])), mr = new Map(r.map(x => [x.id, x]));
  const kept = new Map();
  for (const id of new Set([...ml.keys(), ...mr.keys(), ...mb.keys()])) {
    const vb = mb.get(id), vl = ml.get(id), vr = mr.get(id);
    if (vl === undefined && vr === undefined) continue;
    if (vl === undefined && vb !== undefined && deepEqual(vb, vr)) continue; // supprimé localement
    if (vr === undefined && vb !== undefined && deepEqual(vb, vl)) continue; // supprimé côté cloud
    kept.set(id, merge3(vb, vl, vr, [...path, String(id)], ctx, { ...(meta || {}), title: (vl || vr).title || (vl || vr).name || (vl || vr).text }));
  }
  return mergeOrder(l.map(x => x.id), r.map(x => x.id), new Set(kept.keys())).map(id => kept.get(id));
}

// ---- Arbres (tâches / caps) ----
function flatten(list, childKey, parent = null, out = new Map()) {
  (list || []).forEach((node, index) => {
    if (!node || node.id === undefined) return;
    const { [childKey]: kids, ...fields } = node;
    out.set(node.id, { fields, parent, index });
    flatten(kids, childKey, node.id, out);
  });
  return out;
}
function childOrder(flat) {
  const m = new Map();
  [...flat.entries()].sort((a, b) => a[1].index - b[1].index).forEach(([id, n]) => {
    if (!m.has(n.parent)) m.set(n.parent, []);
    m.get(n.parent).push(id);
  });
  return m;
}

function mergeTree(b, l, r, childKey, path, ctx) {
  const fb = flatten(b, childKey), fl = flatten(l, childKey), fr = flatten(r, childKey);
  const nodes = new Map(); // id → { fields, parent }
  for (const id of new Set([...fl.keys(), ...fr.keys(), ...fb.keys()])) {
    const nb = fb.get(id), nl = fl.get(id), nr = fr.get(id);
    const same = (x, y) => x && y && x.parent === y.parent && deepEqual(x.fields, y.fields);
    if (!nl && !nr) continue;
    if (!nl && nb && same(nb, nr)) continue; // supprimé localement, inchangé côté cloud
    if (!nr && nb && same(nb, nl)) continue; // supprimé côté cloud, inchangé localement
    const title = ((nl || nr).fields.title) || '';
    const meta = { itemId: id, title, tree: path[0] };
    // Supprimé d'un côté, modifié (contenu ou position) de l'autre → on reprend la version modifiée entière
    const fields = !nl ? nr.fields : !nr ? nl.fields
      : merge3(nb && nb.fields, nl.fields, nr.fields, [...path, String(id)], ctx, meta);
    // Parent : celui du côté où le nœud existe encore ; s'il existe des deux côtés, fusion (sans signalement)
    const parent = !nl ? nr.parent : !nr ? nl.parent
      : merge3(nb ? nb.parent : undefined, nl.parent, nr.parent, [...path, String(id), 'parent'], { ...ctx, report: false, conflicts: [] }, meta);
    nodes.set(id, { fields, parent: parent === undefined ? null : parent });
  }
  // Parent supprimé mais enfant gardé : on ressuscite la chaîne des parents (rien ne se perd)
  let changed = true;
  while (changed) {
    changed = false;
    for (const [, n] of nodes) {
      if (n.parent !== null && !nodes.has(n.parent)) {
        const src = fl.get(n.parent) || fr.get(n.parent) || fb.get(n.parent);
        if (src) { nodes.set(n.parent, { fields: src.fields, parent: src.parent }); changed = true; }
        else n.parent = null;
      }
    }
  }
  // Pas de cycle possible : un nœud dont la chaîne boucle est remonté à la racine
  for (const [id, n] of nodes) {
    const seen = new Set([id]);
    let p = n.parent;
    while (p !== null && nodes.has(p)) {
      if (seen.has(p)) { n.parent = null; break; }
      seen.add(p);
      p = nodes.get(p).parent;
    }
  }
  const ol = childOrder(fl), or = childOrder(fr);
  const byParent = new Map();
  for (const [id, n] of nodes) {
    if (!byParent.has(n.parent)) byParent.set(n.parent, new Set());
    byParent.get(n.parent).add(id);
  }
  const build = (parent) => {
    const keep = byParent.get(parent) || new Set();
    return mergeOrder(ol.get(parent) || [], or.get(parent) || [], keep).map(id => ({ ...nodes.get(id).fields, [childKey]: build(id) }));
  };
  return build(null);
}

// Fusion de l'état complet. base peut être null (pas de version commune connue) : on fusionne alors
// sans signaler de conflit (les écarts sont tranchés par la récence).
export function mergeStates(base, local, remote, opts = {}) {
  const ctx = makeCtx({ ...opts, noReport: opts.noReport || !base });
  const b = base || {};
  const out = {};
  const keys = new Set([...Object.keys(local || {}), ...Object.keys(remote || {}), ...Object.keys(b)]);
  for (const k of keys) {
    let v;
    if (TREES[k] && (Array.isArray(local && local[k]) || Array.isArray(remote && remote[k]))) {
      v = mergeTree(b[k] || [], (local && local[k]) || [], (remote && remote[k]) || [], TREES[k], [k], ctx);
    } else {
      v = merge3(b[k], local ? local[k] : undefined, remote ? remote[k] : undefined, [k], ctx);
    }
    if (v !== undefined) out[k] = v;
  }
  return { merged: out, conflicts: ctx.conflicts };
}
