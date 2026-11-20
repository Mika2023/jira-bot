import assert from 'node:assert/strict';
import test from 'node:test';

import { BoardUrlError, issueBrowseUrl, issuesUrl, parseBoardUrl } from '../board-url.js';

test('parses a Jira Cloud board page URL', () => {
  const board = parseBoardUrl('https://demo.atlassian.net/jira/software/c/projects/DEMO/boards/42');
  assert.deepEqual(board, { baseUrl: 'https://demo.atlassian.net', boardId: '42' });
});

test('parses a board page URL with the optional /board suffix and query', () => {
  const board = parseBoardUrl(
    'https://demo.atlassian.net/jira/software/projects/DEMO/boards/42/board?atlOrigin=abc',
  );
  assert.deepEqual(board, { baseUrl: 'https://demo.atlassian.net', boardId: '42' });
});

test('keeps a context path from a REST board URL', () => {
  const board = parseBoardUrl('https://jira.example.com/jira/rest/agile/1.0/board/7/issue');
  assert.deepEqual(board, { baseUrl: 'https://jira.example.com/jira', boardId: '7' });
  assert.equal(
    issuesUrl(board.baseUrl, board.boardId),
    'https://jira.example.com/jira/rest/agile/1.0/board/7/issue',
  );
});

test('parses a legacy RapidBoard URL', () => {
  const board = parseBoardUrl('https://jira.example.com/jira/secure/RapidBoard.jspa?rapidView=13');
  assert.deepEqual(board, { baseUrl: 'https://jira.example.com/jira', boardId: '13' });
});

test('accepts a URL without a scheme and trailing slashes', () => {
  assert.deepEqual(parseBoardUrl('jira.example.com/boards/5/'), {
    baseUrl: 'https://jira.example.com',
    boardId: '5',
  });
});

test('rejects URLs without a board id', () => {
  assert.throws(
    () => parseBoardUrl('https://jira.example.com/jira/software/c/projects/DEMO'),
    BoardUrlError,
  );
  assert.throws(() => parseBoardUrl('https://jira.example.com/'), BoardUrlError);
  assert.throws(() => parseBoardUrl(''), /Укажите адрес доски/);
  assert.throws(() => parseBoardUrl('ftp://jira.example.com/boards/1'), /https/);
});

test('rejects a legacy URL without rapidView', () => {
  assert.throws(
    () => parseBoardUrl('https://jira.example.com/secure/RapidBoard.jspa'),
    /rapidView/,
  );
});

test('builds issue browse links', () => {
  assert.equal(
    issueBrowseUrl('https://jira.example.com/jira', 'DEMO-1'),
    'https://jira.example.com/jira/browse/DEMO-1',
  );
});
