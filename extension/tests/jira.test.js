import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateNotification,
  authHeaders,
  fetchIssues,
  issueNotification,
  jqlForStatus,
} from '../jira.js';

const CONFIG = {
  boardUrl: 'https://jira.example.com/jira/software/c/projects/DEMO/boards/42',
  status: 'Ревью СА выполнено',
  authMode: 'session',
};

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

test('escapes quotes and backslashes in the JQL', () => {
  assert.equal(jqlForStatus('Ready for QA'), 'status = "Ready for QA"');
  assert.equal(jqlForStatus('A "quoted" \\ status'), 'status = "A \\"quoted\\" \\\\ status"');
});

test('builds basic and bearer auth headers', () => {
  assert.deepEqual(authHeaders({ authMode: 'session' }), {});
  assert.deepEqual(authHeaders({ authMode: 'basic', username: 'bot', password: 'secret' }), {
    Authorization: `Basic ${Buffer.from('bot:secret', 'utf8').toString('base64')}`,
  });
  assert.deepEqual(authHeaders({ authMode: 'bearer', token: 'pat' }), { Authorization: 'Bearer pat' });
  assert.throws(() => authHeaders({ authMode: 'basic' }), /логин и пароль/);
  assert.throws(() => authHeaders({ authMode: 'bearer' }), /Personal Access Token/);
});

test('reads every page of the board search', async () => {
  const calls = [];
  const pages = [
    { issues: [{ key: 'DEMO-1' }, { key: 'DEMO-2' }], total: 3 },
    { issues: [{ key: 'DEMO-3' }], total: 3 },
  ];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(pages[calls.length - 1]);
  };

  const result = await fetchIssues(CONFIG, { fetchImpl });

  assert.deepEqual(
    result.issues.map((issue) => issue.key),
    ['DEMO-1', 'DEMO-2', 'DEMO-3'],
  );
  assert.equal(calls.length, 2);
  const first = new URL(calls[0].url);
  assert.equal(`${first.origin}${first.pathname}`, 'https://jira.example.com/rest/agile/1.0/board/42/issue');
  assert.equal(first.searchParams.get('jql'), 'status = "Ревью СА выполнено"');
  assert.equal(first.searchParams.get('startAt'), '0');
  assert.equal(new URL(calls[1].url).searchParams.get('startAt'), '2');
  assert.equal(calls[0].options.credentials, 'include');
});

test('stops on an empty page even when the reported total is larger', async () => {
  const fetchImpl = async () => jsonResponse({ issues: [], total: 10 });
  const result = await fetchIssues(CONFIG, { fetchImpl });
  assert.deepEqual(result.issues, []);
});

test('reports friendly messages for HTTP errors', async () => {
  const fetchImpl = async () => jsonResponse({}, 401);
  await assert.rejects(fetchIssues(CONFIG, { fetchImpl }), /401/);
  await assert.rejects(fetchIssues(CONFIG, { fetchImpl }), /учётные данные/);
});

test('requires a board URL and a status', async () => {
  await assert.rejects(fetchIssues({ status: 'Done' }), /адрес доски/);
  await assert.rejects(fetchIssues({ boardUrl: CONFIG.boardUrl }), /статус/);
});

test('formats issue and aggregate notifications', () => {
  const issue = { key: 'DEMO-1', fields: { summary: 'Fix login' } };
  assert.deepEqual(issueNotification(issue, CONFIG), {
    title: 'Новая задача: DEMO-1',
    message: 'Fix login',
    contextMessage: 'Статус: Ревью СА выполнено',
    url: 'https://jira.example.com/browse/DEMO-1',
  });

  const aggregate = aggregateNotification([issue, { key: 'DEMO-2' }], CONFIG);
  assert.equal(aggregate.title, '2 новых задач в статусе «Ревью СА выполнено»');
  assert.equal(aggregate.message, 'DEMO-1, DEMO-2');
});
