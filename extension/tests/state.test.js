import assert from 'node:assert/strict';
import test from 'node:test';

import { collectNewIssues, pruneSeen, rememberIssues, scopeKey } from '../state.js';

test('collects only issues that were not seen before', () => {
  const seen = { 'DEMO-1': 1 };
  const issues = [{ key: 'DEMO-1' }, { key: 'DEMO-2' }, { fields: {} }];
  assert.deepEqual(
    collectNewIssues(seen, issues).map((issue) => issue.key),
    ['DEMO-2'],
  );
});

test('remembers issues with the current timestamp', () => {
  const seen = rememberIssues({ 'DEMO-1': 1 }, [{ key: 'DEMO-2' }], 1000);
  assert.deepEqual(seen, { 'DEMO-1': 1, 'DEMO-2': 1000 });
});

test('prunes entries older than the TTL', () => {
  const now = 10_000;
  const seen = pruneSeen({ old: now - 5000, fresh: now - 10 }, now, 1000);
  assert.deepEqual(seen, { fresh: now - 10 });
});

test('scope key depends on the board URL and the status', () => {
  assert.equal(scopeKey(' https://a/boards/1 ', 'Done'), 'https://a/boards/1|Done');
  assert.notEqual(scopeKey('https://a/boards/1', 'Done'), scopeKey('https://a/boards/1', 'Review'));
});
