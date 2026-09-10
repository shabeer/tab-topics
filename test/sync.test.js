// Unit and integration tests for Tab Topics cross-device sync.
// Uses Node's built-in test runner (node --test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as logic from '../extension/shared/logic.js';
import * as sync from '../extension/shared/sync.js';
import * as drive from '../extension/shared/drive.js';
import * as syncEngine from '../extension/shared/sync-engine.js';
import { memoryAdapter, loadState, saveState } from '../extension/shared/store.js';

describe('sync primitives and helpers', () => {
  it('generates unique device IDs', () => {
    const d1 = sync.createDeviceId();
    const d2 = sync.createDeviceId();
    assert.match(d1, /^dev_/);
    assert.notEqual(d1, d2);
  });

  it('computes server clock offset correctly', () => {
    const localNow = 1000000;
    const serverTime = 1005000;
    const offset = sync.computeClockOffset(serverTime, localNow);
    assert.equal(offset, 5000);
    assert.equal(sync.computeClockOffset(null), 0);
  });

  it('stamps records with deviceId and updatedAt', () => {
    const rec = { id: '1', title: 'test' };
    sync.stampRecord(rec, 'dev_123', 500, 'batch_abc');
    assert.equal(rec.deviceId, 'dev_123');
    assert.equal(rec.batchId, 'batch_abc');
    assert.ok(typeof rec.updatedAt === 'number');
  });

  it('creates and identifies tombstones', () => {
    const t = sync.createTombstone('entry_1', 'dev_123', 100);
    assert.equal(t.id, 'entry_1');
    assert.equal(t._deleted, true);
    assert.equal(sync.isTombstone(t), true);
    assert.equal(sync.isTombstone({ id: '2' }), false);
  });

  it('prunes tombstones older than maxAge', () => {
    const now = 2000000000000;
    const young = sync.createTombstone('young', 'dev_1', 0);
    young.deletedAt = now - 1000;

    const old = sync.createTombstone('old', 'dev_1', 0);
    old.deletedAt = now - (35 * 24 * 60 * 60 * 1000); // 35 days old

    const active = { id: 'live', name: 'Live' };
    const list = [young, old, active];

    const pruned = sync.pruneTombstones(list, now);
    assert.equal(pruned.length, 2);
    assert.ok(pruned.some((x) => x.id === 'young'));
    assert.ok(pruned.some((x) => x.id === 'live'));
    assert.ok(!pruned.some((x) => x.id === 'old'));
  });

  it('compares record versions with LWW and deterministic device tiebreak', () => {
    const older = { id: '1', updatedAt: 1000, deviceId: 'dev_b' };
    const newer = { id: '1', updatedAt: 2000, deviceId: 'dev_a' };
    assert.ok(sync.compareRecordVersions(newer, older) > 0);
    assert.ok(sync.compareRecordVersions(older, newer) < 0);

    // Same timestamp: tiebreak on deviceId
    const sameTimeA = { id: '1', updatedAt: 1000, deviceId: 'dev_a' };
    const sameTimeB = { id: '1', updatedAt: 1000, deviceId: 'dev_b' };
    assert.ok(sync.compareRecordVersions(sameTimeB, sameTimeA) > 0);
  });
});

describe('3-way collection merge', () => {
  it('merges non-conflicting additions from both local and remote', () => {
    const base = [{ id: '1', val: 'initial', updatedAt: 100 }];
    const local = [
      { id: '1', val: 'initial', updatedAt: 100 },
      { id: '2', val: 'added on local', updatedAt: 200 },
    ];
    const remote = [
      { id: '1', val: 'initial', updatedAt: 100 },
      { id: '3', val: 'added on remote', updatedAt: 300 },
    ];

    const { result, conflicts } = sync.mergeCollection(base, local, remote);
    assert.equal(conflicts, 0);
    assert.equal(result.length, 3);
    assert.ok(result.some((x) => x.id === '1'));
    assert.ok(result.some((x) => x.id === '2'));
    assert.ok(result.some((x) => x.id === '3'));
  });

  it('resolves concurrent edits on the same record using LWW', () => {
    const base = [{ id: '1', val: 'base', updatedAt: 100 }];
    const local = [{ id: '1', val: 'local edit', updatedAt: 250, deviceId: 'dev_local' }];
    const remote = [{ id: '1', val: 'remote edit', updatedAt: 350, deviceId: 'dev_remote' }];

    const { result, conflicts } = sync.mergeCollection(base, local, remote);
    assert.equal(conflicts, 1);
    assert.equal(result.length, 1);
    assert.equal(result[0].val, 'remote edit'); // remote is newer
  });

  it('handles tombstone deletion vs older edit', () => {
    const base = [{ id: '1', val: 'base', updatedAt: 100 }];
    const local = [{ id: '1', val: 'local edit', updatedAt: 200, deviceId: 'dev_1' }];
    const remoteTombstone = sync.createTombstone('1', 'dev_2');
    remoteTombstone.deletedAt = 300;

    const { result, conflicts } = sync.mergeCollection(base, local, [remoteTombstone]);
    assert.equal(conflicts, 1);
    assert.equal(result.length, 1);
    assert.equal(sync.isTombstone(result[0]), true);
  });

  it('resurrects if edit is newer than deletion tombstone', () => {
    const base = [{ id: '1', val: 'base', updatedAt: 100 }];
    const local = [{ id: '1', val: 'newer edit after delete', updatedAt: 500, deviceId: 'dev_1' }];
    const remoteTombstone = sync.createTombstone('1', 'dev_2');
    remoteTombstone.deletedAt = 300;

    const { result, conflicts } = sync.mergeCollection(base, local, [remoteTombstone]);
    assert.equal(conflicts, 1);
    assert.equal(result.length, 1);
    assert.equal(result[0].val, 'newer edit after delete');
  });
});

describe('full state 3-way merge', () => {
  it('preserves NoTopic topic invariant at index 0', () => {
    const base = logic.newState();
    const local = logic.newState();
    const remote = logic.newState();

    local.topics.push({ id: 'top_1', name: 'Work', createdAt: 100, updatedAt: 200 });
    remote.topics.push({ id: 'top_2', name: 'Personal', createdAt: 100, updatedAt: 300 });

    const { mergedState } = sync.mergeStates(base, local, remote);
    assert.equal(mergedState.topics[0].name.toLowerCase(), 'notopic');
    assert.ok(mergedState.topics.some((t) => t.name === 'Work'));
    assert.ok(mergedState.topics.some((t) => t.name === 'Personal'));
  });

  it('reindexes queue positions sequentially across queues after merge', () => {
    const base = logic.newState();
    const topicId = base.topics[0].id;

    const local = JSON.parse(JSON.stringify(base));
    local.entries.push({
      id: 'e1',
      url: 'https://example.com/1',
      title: '1',
      topicId,
      queue: 'to_be_ordered',
      position: 5, // gap in position
      updatedAt: 200,
    });

    const remote = JSON.parse(JSON.stringify(base));
    remote.entries.push({
      id: 'e2',
      url: 'https://example.com/2',
      title: '2',
      topicId,
      queue: 'to_be_ordered',
      position: 10,
      updatedAt: 300,
    });

    const { mergedState } = sync.mergeStates(base, local, remote);
    const entries = mergedState.entries.filter((e) => e.topicId === topicId && e.queue === 'to_be_ordered');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].position, 0);
    assert.equal(entries[1].position, 1);
  });

  it('preserves YouTube metadata stamps and syncs settings', () => {
    const base = logic.newState();
    const topicId = base.topics[0].id;

    const local = JSON.parse(JSON.stringify(base));
    local.settings.ytApiKey = 'AIzaLocalKey';
    local.entries.push({
      id: 'e_yt',
      url: 'https://youtube.com/watch?v=12345678901',
      title: 'Video Title',
      topicId,
      queue: 'to_be_ordered',
      position: 0,
      updatedAt: 200,
      yt: {
        channelId: 'UC1234567890123456789012',
        channelName: 'Channel Name',
        publishedAt: '2026-01-01T00:00:00Z',
      },
    });

    const remote = logic.newState();
    remote.settings.closeAfterAdd = true;
    remote.settings.updatedAt = 500;

    const { mergedState } = sync.mergeStates(base, local, remote);
    assert.equal(mergedState.settings.ytApiKey, 'AIzaLocalKey');
    assert.equal(mergedState.settings.closeAfterAdd, true);

    const ytEntry = mergedState.entries.find((e) => e.id === 'e_yt');
    assert.ok(ytEntry);
    assert.equal(ytEntry.yt.channelName, 'Channel Name');
    assert.equal(ytEntry.yt.channelId, 'UC1234567890123456789012');
  });
});

describe('Google Drive REST client (drive.js)', () => {
  it('finds existing file in appDataFolder', async () => {
    const mockFetch = async (url) => {
      if (url.includes('/files?spaces=appDataFolder')) {
        return {
          ok: true,
          json: async () => ({
            files: [{ id: 'file_123', name: 'tabtopics-state.json', headRevisionId: 'rev_1', modifiedTime: '2026-09-10T12:00:00Z' }],
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const file = await drive.findOrCreateSyncFile('mock_token', { fetchImpl: mockFetch });
    assert.equal(file.id, 'file_123');
    assert.equal(file.created, false);
  });

  it('creates new file in appDataFolder if not found', async () => {
    let created = false;
    const mockFetch = async (url, opts) => {
      if (url.includes('/files?spaces=appDataFolder')) {
        return {
          ok: true,
          json: async () => ({ files: [] }),
        };
      }
      if (url.endsWith('/files?fields=id,name,headRevisionId,modifiedTime') && opts?.method === 'POST') {
        created = true;
        const body = JSON.parse(opts.body);
        assert.equal(body.name, 'tabtopics-state.json');
        assert.deepEqual(body.parents, ['appDataFolder']);
        return {
          ok: true,
          json: async () => ({ id: 'new_file_456', name: 'tabtopics-state.json', headRevisionId: 'rev_new' }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const file = await drive.findOrCreateSyncFile('mock_token', { fetchImpl: mockFetch });
    assert.equal(created, true);
    assert.equal(file.id, 'new_file_456');
    assert.equal(file.created, true);
  });

  it('downloads and uploads sync payloads', async () => {
    const mockPayload = { schemaVersion: 1, topics: [], entries: [], rules: [], settings: {} };
    let uploadedPayload = null;

    const mockFetch = async (url, opts) => {
      if (url.includes('/files/test_file_id?alt=media')) {
        return {
          ok: true,
          headers: new Map([['date', 'Thu, 10 Sep 2026 12:00:00 GMT']]),
          json: async () => mockPayload,
        };
      }
      if (url.includes('/files/test_file_id?fields=')) {
        return {
          ok: true,
          json: async () => ({ id: 'test_file_id', headRevisionId: 'rev_10' }),
        };
      }
      if (url.includes('/upload/drive/v3/files/test_file_id') && opts?.method === 'PATCH') {
        uploadedPayload = JSON.parse(opts.body);
        return {
          ok: true,
          headers: new Map([['date', 'Thu, 10 Sep 2026 12:05:00 GMT']]),
          json: async () => ({ id: 'test_file_id', headRevisionId: 'rev_11' }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const downloaded = await drive.downloadSyncState('mock_token', 'test_file_id', { fetchImpl: mockFetch });
    assert.deepEqual(downloaded.data, mockPayload);
    assert.equal(downloaded.headRevisionId, 'rev_10');

    const uploadRes = await drive.uploadSyncState('mock_token', 'test_file_id', { hello: 'world' }, { fetchImpl: mockFetch });
    assert.equal(uploadRes.headRevisionId, 'rev_11');
    assert.deepEqual(uploadedPayload, { hello: 'world' });
  });

  it('handles HTTP errors properly with DriveError', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    await assert.rejects(
      () => drive.findOrCreateSyncFile('invalid_token', { fetchImpl: mockFetch }),
      (err) => err instanceof drive.DriveError && err.status === 401
    );
  });
});

describe('high-level sync engine (sync-engine.js)', () => {
  it('returns disabled status when sync is not enabled', async () => {
    const mem = memoryAdapter();
    const res = await syncEngine.performSync({
      adapter: mem,
      getToken: async () => 'mock_token',
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'disabled');
  });

  it('runs complete sync cycle when enabled with memory adapter', async () => {
    const mem = memoryAdapter();
    const local = await loadState(mem);
    logic.addTopic(local, 'Projects');
    await saveState(mem, local);

    const meta = syncEngine.defaultSyncMeta();
    meta.enabled = true;
    await syncEngine.saveSyncMeta(mem, meta);

    const remoteState = logic.newState();
    logic.addTopic(remoteState, 'Reading');

    const mockFetch = async (url, opts) => {
      if (url.includes('/files?spaces=appDataFolder')) {
        return { ok: true, json: async () => ({ files: [{ id: 'f1', name: 'tabtopics-state.json' }] }) };
      }
      if (url.includes('/files/f1?alt=media')) {
        return {
          ok: true,
          headers: new Map([['date', 'Thu, 10 Sep 2026 12:00:00 GMT']]),
          json: async () => remoteState,
        };
      }
      if (url.includes('/files/f1?fields=')) {
        return { ok: true, json: async () => ({ id: 'f1', headRevisionId: 'r1' }) };
      }
      if (url.includes('/upload/drive/v3/files/f1')) {
        return {
          ok: true,
          headers: new Map([['date', 'Thu, 10 Sep 2026 12:00:05 GMT']]),
          json: async () => ({ id: 'f1', headRevisionId: 'r2' }),
        };
      }
      throw new Error(`Unexpected: ${url}`);
    };

    const res = await syncEngine.performSync({
      adapter: mem,
      getToken: async () => 'valid_token',
      fetchImpl: mockFetch,
    });

    assert.equal(res.ok, true);
    assert.ok(res.mergedState.topics.some((t) => t.name === 'Projects'));
    assert.ok(res.mergedState.topics.some((t) => t.name === 'Reading'));

    const updatedMeta = await syncEngine.loadSyncMeta(mem);
    assert.equal(updatedMeta.status, 'synced');
    assert.equal(updatedMeta.lastRemoteRevision, 'r2');
  });
});
