// Unit tests for the pure logic layer (extension/shared/logic.js) and the
// storage adapter (extension/shared/store.js). Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import * as logic from '../extension/shared/logic.js';
import { memoryAdapter, loadState, saveState } from '../extension/shared/store.js';

function fresh() {
  return logic.newState();
}

function addTopic(state, name) {
  const t = logic.addTopic(state, name);
  assert.ok(t, `topic "${name}" should be created`);
  return t;
}

function save(state, url, topicId, title = url) {
  const r = logic.saveTab(state, { url, title }, topicId);
  assert.ok(r.entry, `saving ${url} should produce an entry`);
  return r.entry;
}

// --- state seeding & topics -------------------------------------------------

test('newState seeds NoTopic and General topics and empty collections', () => {
  const s = fresh();
  assert.equal(s.schemaVersion, 1);
  assert.deepEqual(s.topics.map((t) => t.name), ['NoTopic', 'General']);
  assert.deepEqual(s.entries, []);
  assert.deepEqual(s.rules, []);
  assert.equal(s.settings.closeAfterAdd, false);
});

test('ensureTopic find-or-creates the NoTopic catch-all case-insensitively', () => {
  const s = fresh();
  const existing = logic.ensureTopic(s, 'notopic');
  assert.equal(s.topics.length, 2); // found, not duplicated
  const again = logic.ensureTopic(s, 'NoTopic');
  assert.equal(again.id, existing.id);
});

test('addTopic rejects empty and duplicate names (case-insensitive)', () => {
  const s = fresh();
  assert.ok(logic.addTopic(s, 'News'));
  assert.equal(logic.addTopic(s, ''), null);
  assert.equal(logic.addTopic(s, 'news'), null);
});

test('renameTopic allows rename, rejects duplicate names', () => {
  const s = fresh();
  const a = addTopic(s, 'Alpha');
  const b = addTopic(s, 'Beta');
  assert.equal(logic.renameTopic(s, a.id, 'Alpha Prime'), true);
  assert.equal(logic.renameTopic(s, b.id, 'alpha prime'), false);
  assert.equal(logic.renameTopic(s, b.id, '  '), false);
});

test('deleteTopic requires a different move target and preserves queue placement', () => {
  const s = fresh();
  const general = s.topics[0];
  const news = addTopic(s, 'News');
  const e1 = save(s, 'https://a.example/1', news.id);
  const e2 = save(s, 'https://a.example/2', news.id);
  logic.moveEntry(s, e2.id, { queue: 'ordered' });

  assert.equal(logic.deleteTopic(s, news.id).ok, false); // no target
  assert.equal(logic.deleteTopic(s, news.id, news.id).ok, false); // same topic
  const res = logic.deleteTopic(s, news.id, general.id);
  assert.equal(res.ok, true);
  assert.equal(s.topics.length, 2); // General + NoTopic remain
  assert.equal(e1.topicId, general.id);
  assert.equal(e1.queue, 'to_be_ordered');
  assert.equal(e2.topicId, general.id);
  assert.equal(e2.queue, 'ordered'); // queue preserved on move
});

test('deleteTopic refuses to delete the last topic and drops its rules', () => {
  const s = fresh();
  const general = logic.findTopicByName(s, 'General');
  const noTopic = logic.findTopicByName(s, 'NoTopic');
  const other = addTopic(s, 'Other');
  logic.addRule(s, { type: 'domain', value: 'example.com', topicId: other.id });

  const res1 = logic.deleteTopic(s, general.id, other.id);
  assert.equal(res1.ok, true); // two topics remain (NoTopic + Other)
  assert.equal(s.rules.length, 1);

  assert.equal(logic.deleteTopic(s, noTopic.id, other.id).ok, true); // one remains (Other)
  assert.equal(logic.deleteTopic(s, other.id, 'whatever').reason, 'last-topic');

  const third = addTopic(s, 'Third');
  const res2 = logic.deleteTopic(s, other.id, third.id);
  assert.equal(res2.ok, true);
  assert.equal(s.rules.length, 0); // rule pointed at deleted topic is gone
});

// --- saving & duplicates ----------------------------------------------------

test('saveTab appends to to_be_ordered in save order', () => {
  const s = fresh();
  const t = s.topics[0];
  save(s, 'https://a.example/1', t.id);
  save(s, 'https://a.example/2', t.id);
  const list = logic.entriesInQueue(s, t.id, 'to_be_ordered');
  assert.deepEqual(list.map((e) => e.url), ['https://a.example/1', 'https://a.example/2']);
  assert.deepEqual(list.map((e) => e.position), [0, 1]);
});

test('saveTab rejects unknown topic', () => {
  const s = fresh();
  const r = logic.saveTab(s, { url: 'https://x.example' }, 'nope');
  assert.equal(r.entry, null);
});

test('re-saving a URL moves it to the new topic, resets queue, keeps note', () => {
  const s = fresh();
  const a = s.topics[0];
  const b = addTopic(s, 'Beta');
  const e = save(s, 'https://a.example/1', a.id);
  logic.setNote(s, e.id, 'important note');
  logic.moveEntry(s, e.id, { queue: 'done' });

  const r = logic.saveTab(s, { url: 'https://a.example/1', title: 'New title' }, b.id);
  assert.equal(r.moved, true);
  assert.equal(r.entry.topicId, b.id);
  assert.equal(r.entry.queue, 'to_be_ordered'); // reset even from done
  assert.equal(r.entry.note, 'important note');
  assert.equal(r.entry.title, 'New title');
});

test('re-saving a URL compacts the source queue positions', () => {
  const s = fresh();
  const a = s.topics[0];
  const b = addTopic(s, 'Beta');
  save(s, 'https://a.example/1', a.id);
  save(s, 'https://a.example/2', a.id);
  save(s, 'https://a.example/3', a.id);
  logic.saveTab(s, { url: 'https://a.example/2' }, b.id);
  const list = logic.entriesInQueue(s, a.id, 'to_be_ordered');
  assert.deepEqual(list.map((e) => e.url), ['https://a.example/1', 'https://a.example/3']);
  assert.deepEqual(list.map((e) => e.position), [0, 1]);
});

// --- queue moves ------------------------------------------------------------

test('moveEntry to ordered, back to to_be_ordered, and into done', () => {
  const s = fresh();
  const t = s.topics[0];
  const e1 = save(s, 'https://a.example/1', t.id);
  const e2 = save(s, 'https://a.example/2', t.id);

  assert.equal(logic.moveEntry(s, e1.id, { queue: 'ordered' }), true);
  assert.deepEqual(logic.entriesInQueue(s, t.id, 'ordered').map((e) => e.id), [e1.id]);
  assert.deepEqual(logic.entriesInQueue(s, t.id, 'to_be_ordered').map((e) => e.id), [e2.id]);

  assert.equal(logic.moveEntry(s, e1.id, { queue: 'to_be_ordered' }), true); // move back
  assert.equal(logic.moveEntry(s, e2.id, { queue: 'done' }), true); // from to_be_ordered
  assert.equal(logic.moveEntry(s, e1.id, { queue: 'done' }), true); // from to_be_ordered too

  assert.equal(logic.moveEntry(s, 'missing', { queue: 'done' }), false);
  assert.equal(logic.moveEntry(s, e1.id, { queue: 'bogus' }), false);
});

test('moveEntry from ordered directly into done', () => {
  const s = fresh();
  const t = s.topics[0];
  const e = save(s, 'https://a.example/1', t.id);
  logic.moveEntry(s, e.id, { queue: 'ordered' });
  assert.equal(logic.moveEntry(s, e.id, { queue: 'done' }), true);
  assert.equal(e.queue, 'done');
});

test('moveEntry reorders within a queue at an explicit position', () => {
  const s = fresh();
  const t = s.topics[0];
  const e1 = save(s, 'https://a.example/1', t.id);
  const e2 = save(s, 'https://a.example/2', t.id);
  const e3 = save(s, 'https://a.example/3', t.id);

  logic.moveEntry(s, e3.id, { position: 0 }); // same queue, insert at top
  assert.deepEqual(
    logic.entriesInQueue(s, t.id, 'to_be_ordered').map((e) => e.url),
    ['https://a.example/3', 'https://a.example/1', 'https://a.example/2']
  );

  logic.moveEntry(s, e1.id, { position: 99 }); // clamped to append
  assert.deepEqual(
    logic.entriesInQueue(s, t.id, 'to_be_ordered').map((e) => e.url),
    ['https://a.example/3', 'https://a.example/2', 'https://a.example/1']
  );
});

test('deleteEntry removes the entry and compacts positions', () => {
  const s = fresh();
  const t = s.topics[0];
  const e1 = save(s, 'https://a.example/1', t.id);
  const e2 = save(s, 'https://a.example/2', t.id);
  const e3 = save(s, 'https://a.example/3', t.id);
  assert.equal(logic.deleteEntry(s, e2.id), true);
  const list = logic.entriesInQueue(s, t.id, 'to_be_ordered');
  assert.deepEqual(list.map((e) => e.url), ['https://a.example/1', 'https://a.example/3']);
  assert.deepEqual(list.map((e) => e.position), [0, 1]);
  assert.equal(logic.deleteEntry(s, e2.id), false);
});

// --- rules ------------------------------------------------------------------

test('domain rule matches exact host, www, and subdomains only', () => {
  const s = fresh();
  const rule = logic.addRule(s, { type: 'domain', value: 'example.com', topicId: s.topics[0].id });
  assert.ok(rule);
  assert.equal(logic.ruleMatches(rule, 'https://example.com/x'), true);
  assert.equal(logic.ruleMatches(rule, 'https://www.example.com/'), true);
  assert.equal(logic.ruleMatches(rule, 'https://sub.example.com/a?b=c'), true);
  assert.equal(logic.ruleMatches(rule, 'https://notexample.com/'), false);
  assert.equal(logic.ruleMatches(rule, 'https://example.org/'), false);
});

test('urlPattern rule with wildcards, case-insensitive', () => {
  const s = fresh();
  const rule = logic.addRule(s, { type: 'urlPattern', value: '*github.com/*/pulls', topicId: s.topics[0].id });
  assert.equal(logic.ruleMatches(rule, 'https://github.com/me/repo/pulls'), true);
  assert.equal(logic.ruleMatches(rule, 'https://GITHUB.COM/me/repo/pulls'), true);
  assert.equal(logic.ruleMatches(rule, 'https://github.com/me/repo'), false);
});

test('ytChannel rule matches handle/channel URLs, not bare watch URLs', () => {
  const s = fresh();
  const rule = logic.addRule(s, { type: 'ytChannel', value: '@Veritasium', topicId: s.topics[0].id });
  assert.equal(rule.value, 'veritasium'); // normalized
  assert.equal(logic.ruleMatches(rule, 'https://www.youtube.com/@Veritasium/videos'), true);
  assert.equal(logic.ruleMatches(rule, 'https://youtube.com/@veritasium'), true);
  assert.equal(logic.ruleMatches(rule, 'https://m.youtube.com/c/Veritasium'), true);
  assert.equal(logic.ruleMatches(rule, 'https://www.youtube.com/watch?v=abc'), false); // no handle in URL
  assert.equal(logic.ruleMatches(rule, 'https://example.com/@veritasium'), false);
});

test('disabled rules do not match; first enabled match wins', () => {
  const s = fresh();
  const t1 = s.topics[0];
  const t2 = addTopic(s, 'Second');
  const r1 = logic.addRule(s, { type: 'domain', value: 'example.com', topicId: t1.id });
  const r2 = logic.addRule(s, { type: 'urlPattern', value: '*example.com*', topicId: t2.id });

  assert.equal(logic.matchUrl(s, 'https://example.com/x').id, r1.id); // array order

  logic.updateRule(s, r1.id, { enabled: false });
  assert.equal(logic.matchUrl(s, 'https://example.com/x').id, r2.id); // falls through

  logic.deleteRule(s, r2.id);
  assert.equal(logic.matchUrl(s, 'https://example.com/x'), null);
});

test('addRule validates type, value, and topic', () => {
  const s = fresh();
  const t = s.topics[0];
  assert.equal(logic.addRule(s, { type: 'nope', value: 'x', topicId: t.id }), null);
  assert.equal(logic.addRule(s, { type: 'domain', value: '  ', topicId: t.id }), null);
  assert.equal(logic.addRule(s, { type: 'domain', value: 'example.com', topicId: 'zzz' }), null);
  assert.ok(logic.addRule(s, { type: 'domain', value: 'https://example.com/x', topicId: t.id })); // normalized
});

// --- search -----------------------------------------------------------------

test('search covers notes, titles, URLs, and topic names, case-insensitively', () => {
  const s = fresh();
  const reading = addTopic(s, 'Reading');
  save(s, 'https://example.com/kubernetes', reading.id, 'K8s deep dive');
  const noted = save(s, 'https://example.com/2', reading.id, 'Some title');
  logic.setNote(s, noted.id, 'check the VLAN config');
  save(s, 'https://other.example/x', s.topics[0].id, 'Unrelated');

  const asUrls = (q) => logic.searchEntries(s, q).map((r) => r.entry.url);
  assert.deepEqual(asUrls('vlan'), ['https://example.com/2']); // note
  assert.deepEqual(asUrls('k8s'), ['https://example.com/kubernetes']); // title
  assert.deepEqual(asUrls('other.example'), ['https://other.example/x']); // url
  assert.deepEqual(asUrls('read'), ['https://example.com/kubernetes', 'https://example.com/2']); // topic
  assert.deepEqual(asUrls('zzz-not-there'), []);
  assert.deepEqual(asUrls('   '), []);
});

// --- export / import --------------------------------------------------------

test('exportState clones and importState merges with local-wins conflicts', () => {
  const local = fresh();
  const news = local.topics[0];
  const kept = save(local, 'https://same.example/kept', news.id);
  logic.setNote(local, kept.id, 'local note');

  const incoming = logic.newState();
  const incNews = incoming.topics[0]; // also named "General" — merges by name
  const tech = logic.addTopic(incoming, 'Tech');
  save(incoming, 'https://same.example/kept', incNews.id);
  const added = save(incoming, 'https://new.example/entry', tech.id);
  logic.moveEntry(incoming, added.id, { queue: 'done' });
  logic.addRule(incoming, { type: 'ytChannel', value: '@somechannel', topicId: tech.id });

  const stats = logic.importState(local, logic.exportState(incoming));
  assert.equal(stats.topicsAdded, 1); // Tech; General merged by name
  assert.equal(stats.entriesAdded, 1); // new.example entry
  assert.equal(stats.conflictsKeptLocal, 1); // same.example kept local
  assert.equal(stats.rulesAdded, 1);

  assert.equal(logic.findEntryByUrl(local, 'https://same.example/kept').note, 'local note');
  const imported = logic.findEntryByUrl(local, 'https://new.example/entry');
  assert.equal(imported.queue, 'done'); // queue preserved on import
  assert.equal(imported.topicId, tech.id); // remapped to imported topic id
});

test('importState merges by topic name and remaps entry topic ids', () => {
  const local = fresh();
  const localGeneral = local.topics[0];
  const other = logic.newState(); // also seeds "General", with a different id
  save(other, 'https://x.example/1', other.topics[0].id);
  const stats = logic.importState(local, logic.exportState(other));
  assert.equal(stats.topicsAdded, 0); // General and NoTopic matched by name
  assert.equal(local.topics.length, 2);
  assert.equal(logic.findEntryByUrl(local, 'https://x.example/1').topicId, localGeneral.id);
});

test('importState assigns a fresh id when an incoming topic id collides', () => {
  const local = fresh();
  const general = local.topics[0];
  const payload = {
    schemaVersion: 1,
    topics: [{ id: general.id, name: 'Fresh Name', createdAt: 1 }],
    entries: [
      { id: 'e1', url: 'https://y.example/2', title: 't', dateAdded: 1, topicId: general.id, queue: 'ordered', position: 0, note: '' },
    ],
    rules: [],
  };
  logic.importState(local, payload);
  assert.equal(local.topics.length, 3);
  const importedTopic = local.topics.find((t) => t.name === 'Fresh Name');
  assert.ok(importedTopic, 'imported topic exists');
  assert.notEqual(importedTopic.id, general.id); // collision avoided with a new id
  assert.equal(logic.findEntryByUrl(local, 'https://y.example/2').topicId, importedTopic.id);
});

test('importState throws on unrecognized payloads', () => {
  const s = fresh();
  assert.throws(() => logic.importState(s, null));
  assert.throws(() => logic.importState(s, { schemaVersion: 99 }));
  assert.throws(() => logic.importState(s, { schemaVersion: 1 }));
});

// --- store adapters ---------------------------------------------------------

test('memoryAdapter loadState initializes empty storage and round-trips saves', async () => {
  const adapter = memoryAdapter();
  const s1 = await loadState(adapter);
  assert.equal(s1.topics[0].name, 'NoTopic');
  assert.equal(s1.topics[1].name, 'General');
  const t = logic.addTopic(s1, 'Extra');
  await saveState(adapter, s1);
  const s2 = await loadState(adapter);
  assert.equal(s2.topics.length, 3);
  assert.ok(s2.topics.some((x) => x.id === t.id));
});

test('loadState recreates the NoTopic topic and places it at index 0 (migration)', async () => {
  const s = fresh();
  s.topics = s.topics.filter((t) => t.name !== 'NoTopic');
  const adapter = memoryAdapter(s);
  const loaded = await loadState(adapter);
  assert.equal(loaded.topics[0].name, 'NoTopic');
  assert.ok(logic.findTopicByName(loaded, 'NoTopic'), 'NoTopic recreated');
  const reloaded = await loadState(adapter); // persisted — no duplicate on next load
  assert.equal(reloaded.topics.filter((t) => t.name === 'NoTopic').length, 1);
});

test('loadState moves NoTopic to index 0 if present at non-zero index', async () => {
  const s = fresh();
  // Move NoTopic to the end
  s.topics = s.topics.filter((t) => t.name !== 'NoTopic');
  s.topics.push({ id: logic.uid(), name: 'NoTopic', createdAt: Date.now() });
  assert.notEqual(s.topics[0].name, 'NoTopic');
  const adapter = memoryAdapter(s);
  const loaded = await loadState(adapter);
  assert.equal(loaded.topics[0].name, 'NoTopic');
});

test('loadState rejects unknown schema versions by reinitializing', async () => {
  const adapter = memoryAdapter({ schemaVersion: 42, topics: [], entries: [], rules: [] });
  const s = await loadState(adapter);
  assert.equal(s.schemaVersion, 1);
  assert.equal(s.topics.length, 2);
});
