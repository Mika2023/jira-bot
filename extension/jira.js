/**
 * Jira REST helpers shared by the service worker and the options page.
 * Everything here is browser-API free, so it can run under Node in tests.
 */

import { issueBrowseUrl, issuesUrl, parseBoardUrl } from './board-url.js';

const FIELDS = 'summary,status,issuetype,assignee,project';
const PAGE_SIZE = 50;
const MAX_PAGES = 40;

export class JiraRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'JiraRequestError';
    this.status = status;
  }
}

export function jqlForStatus(status) {
  const escaped = String(status).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `status = "${escaped}"`;
}

export function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function authHeaders(config = {}) {
  if (config.authMode === 'basic') {
    if (!config.username || !config.password) {
      throw new Error('Для basic-аутентификации нужны логин и пароль/API-токен');
    }
    return { Authorization: `Basic ${base64Utf8(`${config.username}:${config.password}`)}` };
  }
  if (config.authMode === 'bearer') {
    if (!config.token) {
      throw new Error('Для bearer-аутентификации нужен Personal Access Token');
    }
    return { Authorization: `Bearer ${config.token}` };
  }
  return {};
}

function describeStatus(status) {
  if (status === 401) {
    return 'Jira отклонила учётные данные (401). Проверьте логин/токен или войдите в Jira в этом браузере';
  }
  if (status === 403) {
    return 'Нет доступа к доске (403). Проверьте права или включите корпоративный VPN';
  }
  if (status === 404) {
    return 'Доска или REST-метод не найден (404). Проверьте адрес доски';
  }
  return `Jira вернула ошибку HTTP ${status}`;
}

/**
 * Reads every issue of the board that currently has the configured status.
 */
export async function fetchIssues(config, { fetchImpl = fetch } = {}) {
  if (!config?.boardUrl) {
    throw new Error('Не задан адрес доски Jira');
  }
  if (!config?.status) {
    throw new Error('Не задан статус Jira');
  }

  const { baseUrl, boardId } = parseBoardUrl(config.boardUrl);
  const endpoint = issuesUrl(baseUrl, boardId);
  const headers = { Accept: 'application/json', ...authHeaders(config) };
  const issues = [];
  let startAt = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      jql: jqlForStatus(config.status),
      fields: FIELDS,
      maxResults: String(PAGE_SIZE),
      startAt: String(startAt),
    });
    const response = await fetchImpl(`${endpoint}?${params.toString()}`, {
      method: 'GET',
      headers,
      credentials: 'include',
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new JiraRequestError(describeStatus(response.status), response.status);
    }

    const payload = await response.json();
    const pageIssues = Array.isArray(payload.issues) ? payload.issues : [];
    issues.push(...pageIssues);
    startAt += pageIssues.length;

    const total = Number(payload.total ?? 0);
    if (pageIssues.length === 0 || startAt >= total) {
      break;
    }
  }

  return { issues, baseUrl, boardId };
}

export function issueNotification(issue, config) {
  const fields = issue.fields ?? {};
  const summary = fields.summary || '(без названия)';
  return {
    title: `Новая задача: ${issue.key}`,
    message: summary,
    contextMessage: `Статус: ${config.status}`,
    url: issueBrowseUrlFromIssue(issue, config),
  };
}

export function issueBrowseUrlFromIssue(issue, config) {
  const { baseUrl } = parseBoardUrl(config.boardUrl);
  return issueBrowseUrl(baseUrl, issue.key);
}

export function aggregateNotification(issues, config) {
  const keys = issues.map((issue) => issue.key).filter(Boolean);
  return {
    title: `${keys.length} новых задач в статусе «${config.status}»`,
    message: keys.join(', '),
    contextMessage: 'Откройте доску в Jira, чтобы посмотреть подробности',
    url: parseBoardUrl(config.boardUrl).baseUrl,
  };
}
