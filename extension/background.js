import {
  aggregateNotification,
  fetchIssues,
  issueBrowseUrlFromIssue,
  issueNotification,
} from './jira.js';
import { collectNewIssues, pruneSeen, rememberIssues, scopeKey, SEEN_TTL_MS } from './state.js';

const ALARM_NAME = 'jira-poll';
const DEFAULT_INTERVAL_MINUTES = 5;
const MAX_INDIVIDUAL_NOTIFICATIONS = 3;
const NOTIFICATION_PREFIX = 'jira-issue:';

async function loadConfig() {
  const stored = await chrome.storage.local.get('config');
  return stored.config ?? {};
}

export function intervalMinutes(config) {
  const minutes = Number(config?.intervalMinutes);
  return Number.isFinite(minutes) && minutes >= 1 ? Math.round(minutes) : DEFAULT_INTERVAL_MINUTES;
}

async function ensureAlarm(config) {
  const current = await chrome.alarms.get(ALARM_NAME);
  const minutes = intervalMinutes(config);
  if (current && current.periodInMinutes === minutes) {
    return;
  }
  await chrome.alarms.clear(ALARM_NAME);
  if (config?.boardUrl) {
    await chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.5, periodInMinutes: minutes });
  }
}

async function setBadge(count) {
  await chrome.action.setBadgeBackgroundColor({ color: count > 0 ? '#d93025' : '#1a73e8' });
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
}

async function recordRun(result) {
  const lastRun = { at: Date.now(), ...result };
  await chrome.storage.local.set({ lastRun });
}

async function postWebhook(config, issues) {
  if (!config.webhookUrl) {
    return;
  }
  const payload = {
    status: config.status,
    board_url: config.boardUrl,
    issues: issues.map((issue) => ({
      key: issue.key,
      summary: issue.fields?.summary ?? '',
      url: issueBrowseUrlFromIssue(issue, config),
    })),
  };
  try {
    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      console.warn('Webhook responded with', response.status);
    }
  } catch (error) {
    console.warn('Webhook failed:', error);
  }
}

async function showNotifications(config, issues) {
  const notifications =
    issues.length > MAX_INDIVIDUAL_NOTIFICATIONS
      ? [aggregateNotification(issues, config)]
      : issues.map((issue) => issueNotification(issue, config));

  const map = {};
  for (const item of notifications) {
    const id = `${NOTIFICATION_PREFIX}${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    map[id] = item.url;
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: item.title,
      message: item.message,
      contextMessage: item.contextMessage,
      priority: 1,
    });
  }
  const stored = await chrome.storage.session.get('notificationUrls');
  await chrome.storage.session.set({
    notificationUrls: { ...(stored.notificationUrls ?? {}), ...map },
  });
}

async function poll() {
  const config = await loadConfig();
  if (!config.boardUrl || !config.status) {
    await recordRun({ skipped: true, total: 0, newCount: 0, error: null });
    return;
  }

  let fetched;
  try {
    fetched = await fetchIssues(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordRun({ total: 0, newCount: 0, error: message });
    await chrome.action.setBadgeBackgroundColor({ color: '#b00020' });
    await chrome.action.setBadgeText({ text: '!' });
    console.error('Jira poll failed:', message);
    return;
  }

  const now = Date.now();
  const scope = scopeKey(config.boardUrl, config.status);
  const stored = await chrome.storage.local.get('state');
  const state = stored.state ?? { scopes: {} };
  const scopeState = state.scopes[scope] ?? { initialized: false, seen: {} };

  if (!scopeState.initialized && !config.notifyExistingOnStart) {
    scopeState.seen = rememberIssues(scopeState.seen, fetched.issues, now);
    scopeState.initialized = true;
    state.scopes[scope] = scopeState;
    await chrome.storage.local.set({ state });
    await recordRun({ total: fetched.issues.length, newCount: 0, error: null, baseline: true });
    await setBadge(0);
    return;
  }

  const newIssues = collectNewIssues(scopeState.seen, fetched.issues);
  scopeState.seen = pruneSeen(
    rememberIssues(scopeState.seen, newIssues, now),
    now,
    SEEN_TTL_MS,
  );
  scopeState.initialized = true;
  state.scopes[scope] = scopeState;
  await chrome.storage.local.set({ state });
  await recordRun({ total: fetched.issues.length, newCount: newIssues.length, error: null });

  if (newIssues.length > 0) {
    await showNotifications(config, newIssues);
    await postWebhook(config, newIssues);
  }
  await setBadge(newIssues.length);
}

chrome.runtime.onInstalled.addListener(async () => {
  const config = await loadConfig();
  await ensureAlarm(config);
  await poll();
});

chrome.runtime.onStartup.addListener(async () => {
  const config = await loadConfig();
  await ensureAlarm(config);
  await poll();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await poll();
  }
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.config) {
    return;
  }
  await ensureAlarm(changes.config.newValue ?? {});
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const stored = await chrome.storage.session.get('notificationUrls');
  const url = stored.notificationUrls?.[notificationId];
  if (url) {
    await chrome.tabs.create({ url });
  }
  await chrome.notifications.clear(notificationId);
});

chrome.action.onClicked.addListener(async () => {
  await setBadge(0);
  await chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'poll-now') {
    poll()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === 'reset-state') {
    chrome.storage.local
      .remove('state')
      .then(() => setBadge(0))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  return false;
});
