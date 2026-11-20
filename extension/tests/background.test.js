import assert from 'node:assert/strict';
import test from 'node:test';

/** Minimal in-memory chrome.* stub, enough to run the service worker logic. */
function createChromeStub() {
  const local = new Map();
  const session = new Map();
  const notifications = [];
  const listeners = { installed: [], startup: [], alarm: [] };
  const badge = { text: '' };

  const read = (store, keys) => {
    if (typeof keys === 'string') {
      return store.has(keys) ? { [keys]: store.get(keys) } : {};
    }
    const result = {};
    for (const key of keys ?? []) {
      if (store.has(key)) {
        result[key] = store.get(key);
      }
    }
    return result;
  };
  const write = (store, values) => {
    for (const [key, value] of Object.entries(values ?? {})) {
      store.set(key, value);
    }
  };

  const chrome = {
    storage: {
      local: {
        get: async (keys) => read(local, keys),
        set: async (values) => write(local, values),
        remove: async (key) => {
          local.delete(key);
        },
      },
      session: {
        get: async (keys) => read(session, keys),
        set: async (values) => write(session, values),
      },
      onChanged: { addListener: () => {} },
    },
    alarms: {
      get: async () => undefined,
      clear: async () => {},
      create: async () => {},
      onAlarm: { addListener: (listener) => listeners.alarm.push(listener) },
    },
    notifications: {
      create: async (id, options) => {
        notifications.push({ id, ...options });
      },
      clear: async () => {},
      onClicked: { addListener: () => {} },
    },
    action: {
      setBadgeText: async ({ text }) => {
        badge.text = text;
      },
      setBadgeBackgroundColor: async () => {},
      onClicked: { addListener: () => {} },
    },
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      openOptionsPage: async () => {},
      onInstalled: { addListener: (listener) => listeners.installed.push(listener) },
      onStartup: { addListener: (listener) => listeners.startup.push(listener) },
      onMessage: { addListener: () => {} },
    },
    tabs: { create: async () => {} },
  };

  return { chrome, local, notifications, listeners, badge };
}

test('baselines on the first poll, then notifies only about new issues', async () => {
  const env = createChromeStub();
  let issues = [{ key: 'DEMO-1', fields: { summary: 'First' } }];
  globalThis.chrome = env.chrome;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ issues, total: issues.length }),
  });

  await env.local.set('config', {
    boardUrl: 'https://jira.example.test/jira/software/c/projects/DEMO/boards/42',
    status: 'Ready for QA',
    intervalMinutes: 5,
  });

  await import('../background.js');

  await env.listeners.installed[0]();
  assert.equal(env.notifications.length, 0, 'existing issue must not be announced');
  assert.equal(env.local.get('lastRun').baseline, true);

  issues = [...issues, { key: 'DEMO-2', fields: { summary: 'New one' } }];
  await env.listeners.alarm[0]({ name: 'jira-poll' });

  assert.equal(env.notifications.length, 1);
  assert.equal(env.notifications[0].title, 'Новая задача: DEMO-2');
  assert.equal(env.notifications[0].message, 'New one');
  assert.equal(env.notifications[0].iconUrl, 'chrome-extension://test/icons/icon128.png');
  assert.equal(env.badge.text, '1');

  await env.listeners.alarm[0]({ name: 'jira-poll' });
  assert.equal(env.notifications.length, 1, 'the same issue must not be announced twice');

  issues = [
    { key: 'DEMO-3', fields: { summary: 'A' } },
    { key: 'DEMO-4', fields: { summary: 'B' } },
    { key: 'DEMO-5', fields: { summary: 'C' } },
    { key: 'DEMO-6', fields: { summary: 'D' } },
  ];
  await env.listeners.alarm[0]({ name: 'jira-poll' });
  assert.equal(env.notifications.length, 2);
  assert.equal(env.notifications[1].title, '4 новых задач в статусе «Ready for QA»');
  assert.equal(env.notifications[1].message, 'DEMO-3, DEMO-4, DEMO-5, DEMO-6');
});

test('keeps the badge and shows an error when Jira is unreachable', async () => {
  const env = createChromeStub();
  globalThis.chrome = env.chrome;
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });

  await env.local.set('config', {
    boardUrl: 'https://jira.example.test/jira/software/c/projects/DEMO/boards/42',
    status: 'Ready for QA',
  });

  const module = await import('../background.js?second');
  void module;

  await env.listeners.startup[0]();
  assert.equal(env.notifications.length, 0);
  assert.equal(env.badge.text, '!');
  assert.match(env.local.get('lastRun').error, /503/);
});
