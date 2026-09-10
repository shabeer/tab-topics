// Unit tests for the pure logic layer (extension/shared/logic.js) and the
// storage adapter (extension/shared/store.js). Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import * as logic from '../extension/shared/logic.js';
import * as yt from '../extension/shared/youtube.js';
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
  assert.deepEqual(s.ytMeta, {});
  assert.equal(s.settings.closeAfterAdd, false);
  assert.equal(s.settings.ytApiKey, '');
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

  assert.equal(logic.matchUrl(s, 'https://example.com/x').id, r2.id); // r2 was added last, so it is at the top

  logic.updateRule(s, r2.id, { enabled: false });
  assert.equal(logic.matchUrl(s, 'https://example.com/x').id, r1.id); // falls through to r1

  logic.deleteRule(s, r1.id);
  assert.equal(logic.matchUrl(s, 'https://example.com/x'), null);
});

test('addRule inserts new rules at the top as highest priority', () => {
  const s = fresh();
  const t1 = s.topics[0];
  const t2 = addTopic(s, 'Second');
  const r1 = logic.addRule(s, { type: 'domain', value: 'example.com', topicId: t1.id });
  const r2 = logic.addRule(s, { type: 'urlPattern', value: '*example.com/special*', topicId: t2.id });

  assert.deepEqual(s.rules.map((r) => r.id), [r2.id, r1.id]);
  assert.equal(logic.matchUrl(s, 'https://example.com/special').id, r2.id);
});

test('moveRule reorders rules and affects matchUrl evaluation priority', () => {
  const s = fresh();
  const t1 = s.topics[0];
  const t2 = addTopic(s, 'Second');
  const t3 = addTopic(s, 'Third');
  const r1 = logic.addRule(s, { type: 'domain', value: 'example.com', topicId: t1.id });
  const r2 = logic.addRule(s, { type: 'urlPattern', value: '*example.com/special*', topicId: t2.id });
  const r3 = logic.addRule(s, { type: 'urlPattern', value: '*example.com*', topicId: t3.id });

  // Because addRule adds at top, initial list is [r3, r2, r1]
  assert.deepEqual(s.rules.map((r) => r.id), [r3.id, r2.id, r1.id]);
  assert.equal(logic.matchUrl(s, 'https://example.com/special').id, r3.id);

  // Move r2 to the top (position 0)
  assert.equal(logic.moveRule(s, r2.id, 0), true);
  assert.deepEqual(s.rules.map((r) => r.id), [r2.id, r3.id, r1.id]);
  // Now r2 matches first for special URL
  assert.equal(logic.matchUrl(s, 'https://example.com/special').id, r2.id);

  // Move r2 to position clamped to end
  assert.equal(logic.moveRule(s, r2.id, 999), true);
  assert.deepEqual(s.rules.map((r) => r.id), [r3.id, r1.id, r2.id]);

  // Move r1 to position 0
  assert.equal(logic.moveRule(s, r1.id, 0), true);
  assert.deepEqual(s.rules.map((r) => r.id), [r1.id, r3.id, r2.id]);

  // Invalid rule id returns false
  assert.equal(logic.moveRule(s, 'invalid-id', 0), false);
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

test('exportState embeds keyboard shortcuts; importState ignores them', () => {
  const s = fresh();
  const shortcuts = [
    { command: 'save-tab', shortcut: 'Alt+Shift+U', description: 'Save current tab to a topic' },
    { command: 'add-note', shortcut: 'Alt+Shift+N', description: 'Add or edit the note on the current tab' },
  ];
  const exported = logic.exportState(s, { keyboardShortcuts: shortcuts });
  assert.deepEqual(exported.keyboardShortcuts, shortcuts);
  assert.equal(logic.exportState(s).keyboardShortcuts, null); // omitted extras

  // A file carrying shortcuts (even malformed ones) imports fine and changes
  // nothing beyond the regular topics/entries/rules data.
  const before = JSON.stringify(s);
  exported.keyboardShortcuts = [{ command: 'bogus', shortcut: 'Not+A+Real+Chord' }];
  const stats = logic.importState(s, exported);
  assert.equal(stats.topicsAdded, 0);
  assert.equal(stats.entriesAdded, 0);
  assert.equal(stats.rulesAdded, 0);
  assert.equal(JSON.stringify(s), before);
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

// --- YouTube video URL parsing ----------------------------------------------

const WATCH = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const UC_A = 'UC' + 'a'.repeat(22);
const UC_B = 'UC' + 'b'.repeat(22);

test('youtubeVideoIdOf parses all video URL shapes', () => {
  const f = logic.youtubeVideoIdOf;
  assert.equal(f('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(f('https://youtube.com/watch?t=42&v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ'); // v not first
  assert.equal(f('https://m.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(f('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(f('https://youtu.be/dQw4w9WgXcQ?t=30'), 'dQw4w9WgXcQ');
  assert.equal(f('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(f('https://www.youtube.com/live/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(f('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('youtubeVideoIdOf rejects non-video and malformed URLs', () => {
  const f = logic.youtubeVideoIdOf;
  assert.equal(f('https://www.youtube.com/@handle/videos'), null);
  assert.equal(f('https://www.youtube.com/channel/' + UC_A), null);
  assert.equal(f('https://www.youtube.com/watch'), null);
  assert.equal(f('https://www.youtube.com/watch?v=short'), null);
  assert.equal(f('https://notyoutube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(f('not a url'), null);
});

// --- channel-id / channel-name rules -----------------------------------------

test('ytChannelId rule matches enriched watch URLs exactly', () => {
  const s = fresh();
  const rule = logic.addRule(s, { type: 'ytChannelId', value: UC_A, topicId: s.topics[0].id });
  assert.ok(rule, 'valid UC id accepted');
  assert.equal(logic.ruleMatches(rule, WATCH, { channelId: UC_A }), true);
  assert.equal(logic.ruleMatches(rule, WATCH, { channelId: UC_B }), false);
  assert.equal(logic.ruleMatches(rule, WATCH), false); // no metadata yet
  assert.equal(logic.ruleMatches(rule, 'https://www.youtube.com/@whatever'), false);
});

test('ytChannelId rules reject malformed ids at add and update time', () => {
  const s = fresh();
  assert.equal(logic.addRule(s, { type: 'ytChannelId', value: 'not-a-valid-id', topicId: s.topics[0].id }), null);
  assert.equal(logic.addRule(s, { type: 'ytChannelId', value: 'UC123', topicId: s.topics[0].id }), null);
  const rule = logic.addRule(s, { type: 'ytChannelId', value: UC_A, topicId: s.topics[0].id });
  assert.equal(logic.updateRule(s, rule.id, { value: 'bad' }), false);
  assert.equal(rule.value, UC_A); // rejected patch left the value untouched
});

test('ytChannelName rule matches the channel title case-insensitively, exact only', () => {
  const s = fresh();
  const rule = logic.addRule(s, { type: 'ytChannelName', value: 'Veritasium', topicId: s.topics[0].id });
  assert.ok(rule);
  assert.equal(logic.ruleMatches(rule, WATCH, { channelName: 'veritasium' }), true);
  assert.equal(logic.ruleMatches(rule, WATCH, { channelName: 'Veritasium' }), true);
  assert.equal(logic.ruleMatches(rule, WATCH, { channelName: 'Veritasium 2' }), false); // no substring
  assert.equal(logic.ruleMatches(rule, WATCH), false);
});

test('ytChannel handle rules also match watch URLs through fetched metadata', () => {
  const s = fresh();
  const rule = logic.addRule(s, { type: 'ytChannel', value: '@Veritasium', topicId: s.topics[0].id });
  assert.equal(logic.ruleMatches(rule, WATCH, { handle: 'veritasium' }), true);
  assert.equal(logic.ruleMatches(rule, WATCH, { handle: 'someoneelse' }), false);
});

test('matchUrl matches channel rules for watch URLs once metadata is cached', () => {
  const s = fresh();
  const tech = addTopic(s, 'Tech');
  const rule = logic.addRule(s, { type: 'ytChannelName', value: 'Test Channel', topicId: tech.id });
  assert.equal(logic.matchUrl(s, WATCH), null); // nothing fetched yet

  s.ytMeta['dQw4w9WgXcQ'] = logic.normalizeYtMeta({
    channelId: UC_A,
    channelName: 'Test Channel',
    handle: '@testchannel',
    publishedAt: '2020-01-02T03:04:05Z',
    fetchedAt: 1,
  });
  assert.equal(logic.matchUrl(s, WATCH).id, rule.id);
  assert.equal(logic.ytMetaFor(s, 'https://youtu.be/dQw4w9WgXcQ').channelName, 'Test Channel');
});

// --- metadata fetching (shared/youtube.js) ------------------------------------

const okResponse = (items) => ({ ok: true, status: 200, json: async () => ({ items }) });
const errResponse = (status) => ({ ok: false, status, json: async () => ({}) });

function apiItem(overrides = {}) {
  return {
    id: 'dQw4w9WgXcQ',
    snippet: {
      channelId: UC_A,
      channelTitle: 'Test Channel',
      customUrl: '@TestChannel',
      publishedAt: '2020-01-02T03:04:05Z',
      ...overrides,
    },
  };
}

function fetchCounter(handler) {
  const counter = { calls: 0, lastUrl: null, lastOptions: null };
  counter.impl = async (url, options) => {
    counter.calls++;
    counter.lastUrl = url;
    counter.lastOptions = options;
    return handler(url, counter.calls, options);
  };
  return counter;
}

test('ensureYtMeta passes API key in X-Goog-Api-Key header and fetches once per video id', async () => {
  const s = fresh();
  s.settings.ytApiKey = 'TESTKEY';
  const counter = fetchCounter(() => okResponse([apiItem()]));

  const meta1 = await yt.ensureYtMeta(s, WATCH, { fetchImpl: counter.impl });
  assert.equal(counter.calls, 1);
  assert.equal(counter.lastUrl, 'https://www.googleapis.com/youtube/v3/videos?part=snippet&id=dQw4w9WgXcQ');
  assert.equal(counter.lastUrl.includes('key='), false);
  assert.equal(counter.lastOptions?.headers?.['X-Goog-Api-Key'], 'TESTKEY');
  assert.equal(meta1.videoId, 'dQw4w9WgXcQ');
  assert.equal(meta1.channelId, UC_A);
  assert.equal(meta1.channelName, 'Test Channel');
  assert.equal(meta1.handle, 'testchannel'); // customUrl normalized to bare handle
  assert.equal(meta1.publishedAt, '2020-01-02T03:04:05Z');
  assert.ok(meta1.fetchedAt > 0);

  // Same video via a different URL shape: served from the cache.
  const meta2 = await yt.ensureYtMeta(s, 'https://youtu.be/dQw4w9WgXcQ', { fetchImpl: counter.impl });
  assert.equal(counter.calls, 1);
  assert.deepEqual(meta2, meta1);
});

test('ensureYtMeta is a no-op without a key or for non-video URLs', async () => {
  const s = fresh(); // no key configured
  const counter = fetchCounter(() => okResponse([apiItem()]));
  assert.equal(await yt.ensureYtMeta(s, WATCH, { fetchImpl: counter.impl }), null);

  s.settings.ytApiKey = 'TESTKEY';
  assert.equal(await yt.ensureYtMeta(s, 'https://www.youtube.com/@handle/videos', { fetchImpl: counter.impl }), null);
  assert.equal(await yt.ensureYtMeta(s, 'https://example.com/x', { fetchImpl: counter.impl }), null);
  assert.equal(counter.calls, 0);
});

test('ensureYtMeta returns null on API errors and caches nothing', async () => {
  const s = fresh();
  s.settings.ytApiKey = 'TESTKEY';
  const counter = fetchCounter(() => errResponse(403));
  assert.equal(await yt.ensureYtMeta(s, WATCH, { fetchImpl: counter.impl }), null);
  assert.equal(counter.calls, 1);
  assert.deepEqual(s.ytMeta, {}); // failure is not cached — next save retries
});

test('ensureYtMeta tombstones unavailable videos to avoid refetch loops', async () => {
  const s = fresh();
  s.settings.ytApiKey = 'TESTKEY';
  const counter = fetchCounter(() => okResponse([])); // private/deleted video

  assert.equal(await yt.ensureYtMeta(s, WATCH, { fetchImpl: counter.impl }), null);
  assert.equal(await yt.ensureYtMeta(s, WATCH, { fetchImpl: counter.impl }), null);
  assert.equal(counter.calls, 1);
  assert.equal(s.ytMeta['dQw4w9WgXcQ'].unavailable, true);
  assert.equal(logic.ytMetaFor(s, WATCH), null); // tombstone reads as no metadata
});

test('pruneYtMeta caps the cache, dropping the stalest records', () => {
  const s = fresh();
  for (let i = 0; i < 5; i++) s.ytMeta['vid' + i] = { channelName: 'c' + i, fetchedAt: i };
  logic.pruneYtMeta(s, 3);
  assert.deepEqual(Object.keys(s.ytMeta).sort(), ['vid2', 'vid3', 'vid4']);
});

// --- entry stamping ------------------------------------------------------------

test('saveTab stamps entry.yt from the cache or explicit meta', () => {
  const s = fresh();
  s.ytMeta['dQw4w9WgXcQ'] = logic.normalizeYtMeta({ channelName: 'Chan', fetchedAt: 1 });

  const e = save(s, WATCH, s.topics[0].id);
  assert.equal(e.yt.channelName, 'Chan'); // auto-stamped from the warm cache

  // Explicit meta wins (fresh fetch beats stale cache).
  logic.saveTab(s, { url: WATCH }, s.topics[0].id, null, { channelName: 'New' });
  assert.equal(logic.findEntryByUrl(s, WATCH).yt.channelName, 'New');

  const plain = save(s, 'https://example.com/x', s.topics[0].id);
  assert.equal(plain.yt, undefined); // non-YouTube saves get no stamp
});

test('backfillYtStamps stamps entries enriched after save (bulk path)', () => {
  const s = fresh();
  const e = save(s, WATCH, s.topics[0].id);
  assert.equal(e.yt, undefined);
  s.ytMeta['dQw4w9WgXcQ'] = logic.normalizeYtMeta({ channelName: 'Chan', fetchedAt: 1 });
  logic.backfillYtStamps(s);
  assert.equal(e.yt.channelName, 'Chan');
});

test('bulk saving determines topics using YouTube channel and metadata when enriched', async () => {
  const s = fresh();
  s.settings.ytApiKey = 'TESTKEY';
  const scienceTopic = logic.addTopic(s, 'Science');
  const codingTopic = logic.addTopic(s, 'Coding');

  const rule1 = logic.addRule(s, { type: 'ytChannelName', value: 'Veritasium', topicId: scienceTopic.id });
  const rule2 = logic.addRule(s, { type: 'ytChannelId', value: UC_A, topicId: codingTopic.id });

  const url1 = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const url2 = 'https://www.youtube.com/watch?v=oHg5SJYRHA0';
  const url3 = 'https://example.com/article';

  const counter = fetchCounter((url) => {
    if (url.includes('dQw4w9WgXcQ')) {
      return okResponse([apiItem({ id: 'dQw4w9WgXcQ', channelId: UC_A, channelTitle: 'Coding Channel', publishedAt: '2021-05-10T12:00:00Z' })]);
    }
    if (url.includes('oHg5SJYRHA0')) {
      return okResponse([apiItem({ id: 'oHg5SJYRHA0', channelId: 'UC_OTHER_CHANNEL_ID_HERE', channelTitle: 'Veritasium', publishedAt: '2022-08-15T18:30:00Z' })]);
    }
    return okResponse([]);
  });

  // Before enrichment, watch URLs do not match YouTube channel rules
  assert.equal(logic.matchUrl(s, url1), null);
  assert.equal(logic.matchUrl(s, url2), null);

  // Bulk enrichment fetches metadata for YouTube URLs
  const urls = [url1, url2, url3];
  const ytUrls = urls.filter((u) => logic.youtubeVideoIdOf(u));
  await Promise.allSettled(ytUrls.map((u) => yt.ensureYtMeta(s, u, { fetchImpl: counter.impl })));

  // After enrichment, topic determination logic matches the rules
  const suggestion1 = logic.matchUrl(s, url1);
  assert.ok(suggestion1);
  assert.equal(suggestion1.topicId, codingTopic.id);
  assert.equal(suggestion1.id, rule2.id);

  const suggestion2 = logic.matchUrl(s, url2);
  assert.ok(suggestion2);
  assert.equal(suggestion2.topicId, scienceTopic.id);
  assert.equal(suggestion2.id, rule1.id);

  const suggestion3 = logic.matchUrl(s, url3);
  assert.equal(suggestion3, null);

  // Bulk saving with determined topics and cached metadata
  const meta1 = logic.ytMetaFor(s, url1);
  const meta2 = logic.ytMetaFor(s, url2);
  const meta3 = logic.ytMetaFor(s, url3);

  const res1 = logic.saveTab(s, { url: url1, title: 'Video 1' }, suggestion1.topicId, suggestion1.id, meta1);
  const res2 = logic.saveTab(s, { url: url2, title: 'Video 2' }, suggestion2.topicId, suggestion2.id, meta2);
  const res3 = logic.saveTab(s, { url: url3, title: 'Article 3' }, s.topics[0].id, null, meta3);

  assert.equal(res1.entry.topicId, codingTopic.id);
  assert.equal(res1.entry.suggestedByRuleId, rule2.id);
  assert.equal(res1.entry.yt.channelId, UC_A);
  assert.equal(res1.entry.yt.publishedAt, '2021-05-10T12:00:00Z');

  assert.equal(res2.entry.topicId, scienceTopic.id);
  assert.equal(res2.entry.suggestedByRuleId, rule1.id);
  assert.equal(res2.entry.yt.channelName, 'Veritasium');
  assert.equal(res2.entry.yt.publishedAt, '2022-08-15T18:30:00Z');

  assert.equal(res3.entry.topicId, s.topics[0].id);
  assert.equal(res3.entry.yt, undefined);
});

// --- export / import with YouTube data ------------------------------------------

test('maskApiKey preserves first and last 4 characters, masking the rest', () => {
  assert.equal(logic.maskApiKey('AIzaSyD1234567890abcdef'), 'AIza***************cdef');
  assert.equal(logic.maskApiKey('123456789'), '1234*6789');
  assert.equal(logic.maskApiKey('1234567890'), '1234**7890');
  assert.equal(logic.maskApiKey('12345678'), '********');
  assert.equal(logic.maskApiKey('SECRET'), '******');
  assert.equal(logic.maskApiKey(''), '');
  assert.equal(logic.maskApiKey(null), '');
});

test('exportState masks the API key in settings and strips cache but keeps entry stamps', () => {
  const s = fresh();
  s.settings.ytApiKey = 'AIzaSyD1234567890abcdef';
  s.ytMeta['dQw4w9WgXcQ'] = logic.normalizeYtMeta({ channelName: 'Chan', fetchedAt: 1 });
  const e = save(s, WATCH, s.topics[0].id);
  assert.ok(e.yt);

  const out = logic.exportState(s);
  assert.equal(out.settings.ytApiKey, 'AIza***************cdef');
  assert.equal(s.settings.ytApiKey, 'AIzaSyD1234567890abcdef'); // local state unmodified
  assert.equal(out.ytMeta, undefined);
  assert.equal(out.settings.closeAfterAdd, false);
  assert.equal(out.entries[0].yt.channelName, 'Chan');
});

test('importState carries entry stamps and keeps local API key on conflict', () => {
  const local = fresh();
  local.settings.ytApiKey = 'LOCALKEY';
  const incoming = {
    schemaVersion: 1,
    topics: [{ id: 't1', name: 'General', createdAt: 1 }],
    entries: [
      {
        id: 'e1',
        url: WATCH,
        title: 'v',
        dateAdded: 1,
        topicId: 't1',
        queue: 'to_be_ordered',
        position: 0,
        note: '',
        yt: { channelId: UC_A, channelName: 'Chan', handle: 'chan', publishedAt: '2020-01-02T03:04:05Z' },
      },
    ],
    rules: [],
    settings: { closeAfterAdd: true, ytApiKey: 'IMPORTEDKEY' },
  };
  logic.importState(local, incoming);
  assert.equal(local.settings.ytApiKey, 'LOCALKEY'); // local key kept on conflict
  assert.equal(logic.findEntryByUrl(local, WATCH).yt.channelName, 'Chan');
});

test('importState imports API key if local key is empty', () => {
  const local = fresh();
  assert.equal(local.settings.ytApiKey, '');
  const incoming = {
    schemaVersion: 1,
    topics: [{ id: 't1', name: 'General', createdAt: 1 }],
    entries: [],
    rules: [],
    settings: { ytApiKey: 'IMPORTEDKEY' },
  };
  logic.importState(local, incoming);
  assert.equal(local.settings.ytApiKey, 'IMPORTEDKEY');
});

test('loadState adds the ytMeta cache and key slot to pre-enrichment states', async () => {
  const s = fresh();
  delete s.ytMeta;
  delete s.settings.ytApiKey;
  const adapter = memoryAdapter(s);
  const loaded = await loadState(adapter);
  assert.deepEqual(loaded.ytMeta, {});
  assert.equal(loaded.settings.ytApiKey, '');
  assert.equal(loaded.settings.closeAfterAdd, false); // untouched
  const reloaded = await loadState(adapter); // persisted — stable across loads
  assert.deepEqual(reloaded.ytMeta, {});
  assert.equal(reloaded.settings.ytApiKey, '');
});

test('search also covers the YouTube channel name', () => {
  const s = fresh();
  const e = save(s, WATCH, s.topics[0].id, 'Some video title');
  e.yt = { channelName: 'Veritasium', publishedAt: '2020-01-02T03:04:05Z' };
  assert.deepEqual(logic.searchEntries(s, 'veritasium').map((r) => r.entry.url), [WATCH]);
  assert.deepEqual(logic.searchEntries(s, 'published'), []);
});

test('bulk filing skips tabs when topic selection is empty string', () => {
  const s = fresh();
  const t = s.topics[0];
  const rows = [
    { url: 'https://example.com/1', title: 'T1', selectValue: t.id },
    { url: 'https://example.com/2', title: 'T2', selectValue: '' }, // skipped
    { url: 'https://example.com/3', title: 'T3', selectValue: t.id },
  ];

  const filed = [];
  for (const row of rows) {
    if (row.selectValue === '') continue;
    logic.saveTab(s, { url: row.url, title: row.title }, row.selectValue);
    filed.push(row.url);
  }

  assert.deepEqual(filed, ['https://example.com/1', 'https://example.com/3']);
  const inQueue = logic.entriesInQueue(s, t.id, 'to_be_ordered');
  assert.equal(inQueue.length, 2);
  assert.equal(logic.findEntryByUrl(s, 'https://example.com/2'), null);
});
