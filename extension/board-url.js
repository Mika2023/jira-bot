/**
 * Resolves one pasted Jira board URL into a base URL and a board ID.
 * Accepted forms:
 *   https://host/jira/software/c/projects/PROJ/boards/42
 *   https://host/secure/RapidBoard.jspa?rapidView=42
 *   https://host/jira/rest/agile/1.0/board/42/issue
 */

const BOARD_API_RE = /^(.*?)\/rest\/agile\/1\.0\/board\/(\d+)(?:\/issue)?$/;
const BOARD_PAGE_RE = /\/boards\/(\d+)(?:\/board)?$/;
const LEGACY_BOARD_PATH = '/secure/RapidBoard.jspa';

export class BoardUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BoardUrlError';
  }
}

function stripTrailingSlashes(value) {
  return value.replace(/\/+$/, '');
}

export function parseBoardUrl(rawUrl) {
  let url = String(rawUrl ?? '').trim();
  if (!url) {
    throw new BoardUrlError('Укажите адрес доски Jira');
  }
  if (!url.includes('://')) {
    url = `https://${url}`;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new BoardUrlError(
      'Адрес доски указан неверно. Пример: https://jira.example.com/jira/software/c/projects/PROJ/boards/42',
    );
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BoardUrlError('Адрес доски должен начинаться с https:// или http://');
  }

  const origin = `${parsed.protocol}//${parsed.host}`;
  const path = stripTrailingSlashes(parsed.pathname);
  const baseUrl = (prefix) => stripTrailingSlashes(origin + prefix);

  const apiMatch = BOARD_API_RE.exec(path);
  if (apiMatch) {
    return { baseUrl: baseUrl(apiMatch[1]), boardId: apiMatch[2] };
  }

  if (path.endsWith(LEGACY_BOARD_PATH)) {
    const boardId = (parsed.searchParams.get('rapidView') ?? '').trim();
    if (!/^\d+$/.test(boardId)) {
      throw new BoardUrlError(
        'В адресе нет параметра rapidView. Пример: https://jira.example.com/secure/RapidBoard.jspa?rapidView=42',
      );
    }
    return { baseUrl: baseUrl(path.slice(0, -LEGACY_BOARD_PATH.length)), boardId };
  }

  const pageMatch = BOARD_PAGE_RE.exec(path);
  if (pageMatch) {
    return { baseUrl: origin, boardId: pageMatch[1] };
  }

  throw new BoardUrlError(
    'Не удалось найти номер доски в адресе. Скопируйте адрес доски из браузера ' +
      '(например https://jira.example.com/jira/software/c/projects/PROJ/boards/42) ' +
      'или используйте REST-адрес https://jira.example.com/rest/agile/1.0/board/42/issue',
  );
}

export function issuesUrl(baseUrl, boardId) {
  return `${stripTrailingSlashes(baseUrl)}/rest/agile/1.0/board/${boardId}/issue`;
}

export function issueBrowseUrl(baseUrl, issueKey) {
  return `${stripTrailingSlashes(baseUrl)}/browse/${issueKey}`;
}
