// V5 lot 5 : tests de la fusion à 3 voies (node --test, aucune dépendance)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeStates, deepEqual } from '../src/sync-merge.js';

const task = (id, extra = {}) => ({ id, title: id, priority: 'must', completed: false, subtasks: [], ...extra });
const st = (items, extra = {}) => ({ schemaVersion: 14, items, caps: [], settings: { theme: 'light', pomoFocus: 25 }, ...extra });
const find = (items, id) => { for (const i of items) { if (i.id === id) return i; const f = find(i.subtasks || [], id); if (f) return f; } return null; };

test('rien de changé → identique', () => {
  const b = st([task('a')]);
  const { merged, conflicts } = mergeStates(b, b, b);
  assert.ok(deepEqual(merged, b)); assert.equal(conflicts.length, 0);
});

test('ordi renomme, téléphone coche → les deux gardés, aucun conflit', () => {
  const b = st([task('a')]);
  const l = st([task('a', { title: 'Nouveau titre' })]);
  const r = st([task('a', { completed: true, completedAt: 123 })]);
  const { merged, conflicts } = mergeStates(b, l, r);
  const a = find(merged.items, 'a');
  assert.equal(a.title, 'Nouveau titre'); assert.equal(a.completed, true); assert.equal(a.completedAt, 123);
  assert.equal(conflicts.length, 0);
});

test('tâches ajoutées des deux côtés → toutes gardées, ordre local puis insertion cloud', () => {
  const b = st([task('a'), task('b')]);
  const l = st([task('a'), task('x'), task('b')]);
  const r = st([task('a'), task('b'), task('y')]);
  const { merged } = mergeStates(b, l, r);
  assert.deepEqual(merged.items.map(i => i.id), ['a', 'x', 'b', 'y']);
});

test('routine cochée lundi sur l\'ordi, mardi sur le téléphone → deux jours cochés', () => {
  const b = st([task('m', { streak: true, history: ['2026-09-20'] })]);
  const l = st([task('m', { streak: true, history: ['2026-09-20', '2026-09-21'] })]);
  const r = st([task('m', { streak: true, history: ['2026-09-20', '2026-09-22'] })]);
  const { merged, conflicts } = mergeStates(b, l, r);
  assert.deepEqual([...find(merged.items, 'm').history].sort(), ['2026-09-20', '2026-09-21', '2026-09-22']);
  assert.equal(conflicts.length, 0);
});

test('jour décoché d\'un côté, autre jour coché de l\'autre → retrait et ajout combinés', () => {
  const b = st([task('m', { history: ['d1', 'd2'] })]);
  const l = st([task('m', { history: ['d1'] })]);
  const r = st([task('m', { history: ['d1', 'd2', 'd3'] })]);
  assert.deepEqual(find(mergeStates(b, l, r).merged.items, 'm').history, ['d1', 'd3']);
});

test('créneaux faits (slotHistory) fusionnés par jour', () => {
  const b = st([task('m', { slotHistory: { d1: ['08:00'] } })]);
  const l = st([task('m', { slotHistory: { d1: ['08:00', '20:00'] } })]);
  const r = st([task('m', { slotHistory: { d1: ['08:00'], d2: ['08:00'] } })]);
  assert.deepEqual(find(mergeStates(b, l, r).merged.items, 'm').slotHistory, { d1: ['08:00', '20:00'], d2: ['08:00'] });
});

test('supprimée d\'un côté, modifiée de l\'autre → gardée (modification)', () => {
  const b = st([task('a'), task('b')]);
  const l = st([task('b')]);                           // a supprimée localement
  const r = st([task('a', { title: 'A modifiée' }), task('b')]);
  const { merged } = mergeStates(b, l, r);
  assert.equal(find(merged.items, 'a').title, 'A modifiée');
});

test('supprimée d\'un côté, seulement déplacée de l\'autre → gardée entière, au nouvel endroit', () => {
  const b = st([task('p'), task('a')]);
  const l = st([task('p')]);
  const r = st([task('p', { subtasks: [task('a')] })]);
  const { merged } = mergeStates(b, l, r);
  assert.deepEqual(find(merged.items, 'a'), task('a'));
  assert.equal(find(merged.items, 'p').subtasks[0].id, 'a');
});

test('supprimée d\'un côté, inchangée de l\'autre → supprimée', () => {
  const b = st([task('a'), task('b')]);
  const l = st([task('b')]);
  const r = st([task('a'), task('b', { title: 'B' })]);
  const { merged } = mergeStates(b, l, r);
  assert.equal(find(merged.items, 'a'), null);
  assert.equal(find(merged.items, 'b').title, 'B');
});

test('sous-tâche déplacée d\'un côté, modifiée de l\'autre → un seul exemplaire, au nouvel endroit, modifiée', () => {
  const s = task('s', { priority: null });
  const b = st([task('p', { subtasks: [s] }), task('q')]);
  const l = st([task('p'), task('q', { subtasks: [s] })]);                                        // déplacée sous q
  const r = st([task('p', { subtasks: [{ ...s, title: 'S modifiée' }] }), task('q')]);            // modifiée sous p
  const { merged } = mergeStates(b, l, r);
  const all = JSON.stringify(merged.items).match(/"id":"s"/g) || [];
  assert.equal(all.length, 1);
  assert.equal(find(merged.items, 'q').subtasks[0].title, 'S modifiée');
  assert.equal(find(merged.items, 'p').subtasks.length, 0);
});

test('parent supprimé, sous-tâche modifiée ailleurs → parent ressuscité avec l\'enfant', () => {
  const s = task('s', { priority: null });
  const b = st([task('p', { subtasks: [s] })]);
  const l = st([]);
  const r = st([task('p', { subtasks: [{ ...s, completed: true }] })]);
  const { merged } = mergeStates(b, l, r);
  assert.equal(find(merged.items, 's').completed, true);
  assert.ok(find(merged.items, 'p'));
});

test('vrai conflit : même champ changé des deux côtés → la plus récente gagne, l\'autre mise de côté', () => {
  const b = st([task('a', { title: 'Base' })]);
  const l = st([task('a', { title: 'Local' })]);
  const r = st([task('a', { title: 'Cloud' })]);
  let res = mergeStates(b, l, r, { localNewer: true });
  assert.equal(find(res.merged.items, 'a').title, 'Local');
  assert.equal(res.conflicts.length, 1);
  assert.deepEqual({ f: res.conflicts[0].field, kept: res.conflicts[0].kept, other: res.conflicts[0].other, id: res.conflicts[0].itemId }, { f: 'title', kept: 'Local', other: 'Cloud', id: 'a' });
  res = mergeStates(b, l, r, { localNewer: false });
  assert.equal(find(res.merged.items, 'a').title, 'Cloud');
  assert.equal(res.conflicts[0].other, 'Local');
});

test('horodatages techniques : tranchés sans être signalés', () => {
  const b = st([task('a')]);
  const l = st([task('a', { completed: true, completedAt: 1 })]);
  const r = st([task('a', { completed: true, completedAt: 2 })]);
  const res = mergeStates(b, l, r, { localNewer: false });
  assert.equal(find(res.merged.items, 'a').completedAt, 2);
  assert.equal(res.conflicts.length, 0);
});

test('compteurs de temps : les incréments des deux côtés s\'additionnent', () => {
  const b = st([task('a', { actualMinutes: 10, pomosDone: 1 })]);
  const l = st([task('a', { actualMinutes: 35, pomosDone: 2 })]);
  const r = st([task('a', { actualMinutes: 20, pomosDone: 1 })]);
  const a = find(mergeStates(b, l, r).merged.items, 'a');
  assert.equal(a.actualMinutes, 45); assert.equal(a.pomosDone, 2);
});

test('réordonné localement, tâche ajoutée côté cloud → ordre local + nouvelle tâche', () => {
  const b = st([task('a'), task('b'), task('c')]);
  const l = st([task('c'), task('a'), task('b')]);
  const r = st([task('a'), task('b'), task('c'), task('d')]);
  assert.deepEqual(mergeStates(b, l, r).merged.items.map(i => i.id), ['c', 'a', 'b', 'd']);
});

test('arbre des caps fusionné comme les tâches', () => {
  const cap = (id, extra = {}) => ({ id, title: id, status: 'active', children: [], ...extra });
  const b = st([], { caps: [cap('o', { children: [cap('p')] })] });
  const l = st([], { caps: [cap('o', { children: [cap('p', { title: 'Projet renommé' }), cap('j')] })] });
  const r = st([], { caps: [cap('o', { status: 'paused', children: [cap('p')] })] });
  const { merged } = mergeStates(b, l, r);
  assert.equal(merged.caps[0].status, 'paused');
  assert.deepEqual(merged.caps[0].children.map(c => c.title), ['Projet renommé', 'j']);
});

test('collections par id (argent), réglages clé par clé, journal de focus en ensemble', () => {
  const e = (id, amount) => ({ id, amount, label: id });
  const b = st([], { money: { entries: [e('e1', 10)], flows: [] }, focusLog: [{ at: 1, min: 25, itemId: 'a' }] });
  const l = st([], { settings: { theme: 'dark', pomoFocus: 25 }, money: { entries: [e('e1', 10), e('e2', 5)], flows: [] }, focusLog: [{ at: 1, min: 25, itemId: 'a' }, { at: 2, min: 25, itemId: 'a' }] });
  const r = st([], { settings: { theme: 'light', pomoFocus: 30 }, money: { entries: [e('e1', 12)], flows: [] }, focusLog: [{ at: 1, min: 25, itemId: 'a' }, { at: 3, min: 10, itemId: 'b' }] });
  const { merged, conflicts } = mergeStates(b, l, r);
  assert.deepEqual(merged.settings, { theme: 'dark', pomoFocus: 30 });
  assert.deepEqual(merged.money.entries.map(x => [x.id, x.amount]), [['e1', 12], ['e2', 5]]);
  assert.deepEqual(merged.focusLog.map(x => x.at), [1, 2, 3]);
  assert.equal(conflicts.length, 0);
});

test('clés inconnues (version plus récente de l\'app) conservées et fusionnées', () => {
  const b = st([task('a', { futur: 1 })], { nouveauModule: { x: 1 } });
  const l = st([task('a', { futur: 1 })], { nouveauModule: { x: 1, y: 2 } });
  const r = st([task('a', { futur: 2 })], { nouveauModule: { x: 1 } });
  const { merged } = mergeStates(b, l, r);
  assert.equal(find(merged.items, 'a').futur, 2);
  assert.deepEqual(merged.nouveauModule, { x: 1, y: 2 });
});

test('sans base connue : union des tâches, écarts tranchés par la récence, aucun conflit signalé', () => {
  const l = st([task('a', { title: 'L' }), task('x')]);
  const r = st([task('a', { title: 'R' }), task('y')]);
  const res = mergeStates(null, l, r, { localNewer: false });
  assert.deepEqual(res.merged.items.map(i => i.id).sort(), ['a', 'x', 'y']);
  assert.equal(find(res.merged.items, 'a').title, 'R');
  assert.equal(res.conflicts.length, 0);
});

test('les entrées ne sont jamais modifiées (immutabilité)', () => {
  const b = st([task('a')]), l = st([task('a', { title: 'L' })]), r = st([task('a', { completed: true })]);
  const snap = JSON.stringify([b, l, r]);
  mergeStates(b, l, r);
  assert.equal(JSON.stringify([b, l, r]), snap);
});

test('même sous-tâche déplacée vers deux parents différents → un seul exemplaire', () => {
  const s = task('s', { priority: null });
  const b = st([task('p', { subtasks: [s] }), task('q'), task('r')]);
  const l = st([task('p'), task('q', { subtasks: [s] }), task('r')]);
  const r = st([task('p'), task('q'), task('r', { subtasks: [s] })]);
  const { merged } = mergeStates(b, l, r);
  assert.equal((JSON.stringify(merged.items).match(/"id":"s"/g) || []).length, 1);
});

test('fusion aléatoire (3000 cas) : pas de doublon, aucun ajout perdu, rien d\'intact supprimé', () => {
  let seed = 42;
  const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const clone = o => JSON.parse(JSON.stringify(o));
  const ids = t => { const out = []; const w = l => l.forEach(i => { out.push(i.id); w(i.subtasks || []); }); w(t); return out; };
  const nodesOf = t => { const out = []; const w = (l, parent) => l.forEach(i => { out.push({ node: i, list: l, parent }); w(i.subtasks || [], i); }); w(t, null); return out; };
  let uid = 0;
  const mutate = (items, tag) => {
    const touched = new Set(), added = new Set(), deleted = new Set();
    for (let k = 0; k < 1 + rnd(4); k++) {
      const all = nodesOf(items);
      const op = rnd(5);
      if (op === 0 || !all.length) { const id = `${tag}${uid++}`; items.push(task(id)); added.add(id); continue; }
      const { node, list } = all[rnd(all.length)];
      if (op === 1) { node.title = `${tag}-${uid++}`; touched.add(node.id); }
      else if (op === 2) { node.completed = !node.completed; touched.add(node.id); }
      else if (op === 3) { list.splice(list.indexOf(node), 1); ids([node]).forEach(i => deleted.add(i)); }
      else { // déplacement sous un autre nœud (pas un descendant)
        const targets = all.filter(x => !ids([node]).includes(x.node.id));
        if (!targets.length) continue;
        list.splice(list.indexOf(node), 1);
        targets[rnd(targets.length)].node.subtasks.push(node);
        touched.add(node.id);
      }
    }
    return { touched, added, deleted };
  };
  for (let n = 0; n < 3000; n++) {
    const base = [];
    for (let i = 0; i < 6; i++) base.push(task(`b${n}_${i}`, { subtasks: rnd(2) ? [task(`b${n}_${i}s`, { priority: null })] : [] }));
    const L = clone(base), R = clone(base);
    const ml = mutate(L, 'L'), mr = mutate(R, 'R');
    const { merged } = mergeStates(st(base), st(L), st(R), { localNewer: !!rnd(2) });
    const out = ids(merged.items);
    assert.ok(out.every(id => typeof id === 'string'), `nœud vide (cas ${n})`);
    assert.equal(new Set(out).size, out.length, `doublon (cas ${n})`);
    for (const id of [...ml.added, ...mr.added]) assert.ok(out.includes(id), `ajout perdu ${id} (cas ${n})`);
    for (const id of ids(base)) {
      const deletedSomewhere = ml.deleted.has(id) || mr.deleted.has(id);
      if (!deletedSomewhere) assert.ok(out.includes(id), `tâche intacte perdue ${id} (cas ${n})`);
    }
    // modifiée d'un côté (et pas supprimée ensuite de ce même côté) → présente, même si l'autre l'a supprimée
    for (const id of [...ml.touched].filter(i => !ml.deleted.has(i))) assert.ok(out.includes(id), `modification perdue ${id} (cas ${n})`);
    for (const id of [...mr.touched].filter(i => !mr.deleted.has(i))) assert.ok(out.includes(id), `modification perdue ${id} (cas ${n})`);
  }
});
