import { parseBoardUrl } from './board-url.js';
import { fetchIssues } from './jira.js';

const DEFAULTS = {
  boardUrl: '',
  status: 'Ревью СА выполнено',
  intervalMinutes: 5,
  authMode: 'session',
  username: '',
  password: '',
  token: '',
  webhookUrl: '',
  notifyExistingOnStart: false,
};

const form = document.getElementById('settings');
const message = document.getElementById('message');
const lastRunLabel = document.getElementById('lastRun');
const authBlocks = [...document.querySelectorAll('.auth-block')];
const authSelect = document.getElementById('authMode');

function setMessage(text, kind = '') {
  message.textContent = text;
  message.className = `message ${kind}`.trim();
}

function applyAuthVisibility() {
  for (const block of authBlocks) {
    block.hidden = block.dataset.auth !== authSelect.value;
  }
}

function fillForm(config) {
  document.getElementById('boardUrl').value = config.boardUrl ?? '';
  document.getElementById('status').value = config.status ?? '';
  document.getElementById('intervalMinutes').value = config.intervalMinutes ?? DEFAULTS.intervalMinutes;
  document.getElementById('authMode').value = config.authMode ?? DEFAULTS.authMode;
  document.getElementById('username').value = config.username ?? '';
  document.getElementById('password').value = config.password ?? '';
  document.getElementById('token').value = config.token ?? '';
  document.getElementById('webhookUrl').value = config.webhookUrl ?? '';
  document.getElementById('notifyExistingOnStart').checked = Boolean(config.notifyExistingOnStart);
  applyAuthVisibility();
}

function readForm() {
  return {
    boardUrl: document.getElementById('boardUrl').value.trim(),
    status: document.getElementById('status').value.trim(),
    intervalMinutes: Number(document.getElementById('intervalMinutes').value) || DEFAULTS.intervalMinutes,
    authMode: authSelect.value,
    username: document.getElementById('username').value.trim(),
    password: document.getElementById('password').value,
    token: document.getElementById('token').value.trim(),
    webhookUrl: document.getElementById('webhookUrl').value.trim(),
    notifyExistingOnStart: document.getElementById('notifyExistingOnStart').checked,
  };
}

function formattedTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleString('ru-RU');
  } catch {
    return String(timestamp);
  }
}

function renderLastRun(lastRun) {
  if (!lastRun) {
    lastRunLabel.textContent = 'Опрос ещё не выполнялся.';
    return;
  }
  if (lastRun.error) {
    lastRunLabel.textContent = `Последний опрос ${formattedTime(lastRun.at)} — ошибка: ${lastRun.error}`;
    return;
  }
  if (lastRun.baseline) {
    lastRunLabel.textContent = `Последний опрос ${formattedTime(lastRun.at)}: запомнено ${lastRun.total} задач, уведомления начнутся со следующей проверки.`;
    return;
  }
  lastRunLabel.textContent = `Последний опрос ${formattedTime(lastRun.at)}: задач в статусе ${lastRun.total}, новых ${lastRun.newCount}.`;
}

async function load() {
  const stored = await chrome.storage.local.get(['config', 'lastRun']);
  fillForm({ ...DEFAULTS, ...(stored.config ?? {}) });
  renderLastRun(stored.lastRun);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const config = readForm();
  try {
    parseBoardUrl(config.boardUrl);
  } catch (error) {
    setMessage(error.message, 'error');
    return;
  }
  if (!config.status) {
    setMessage('Укажите статус Jira', 'error');
    return;
  }
  await chrome.storage.local.set({ config, lastRun: null });
  await chrome.runtime.sendMessage({ type: 'poll-now' });
  setMessage('Настройки сохранены, опрос выполняется.', 'ok');
  const stored = await chrome.storage.local.get('lastRun');
  renderLastRun(stored.lastRun);
});

document.getElementById('test').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const config = readForm();
  button.disabled = true;
  setMessage('Проверяю Jira…');
  try {
    const { issues, baseUrl, boardId } = await fetchIssues(config);
    const sample = issues
      .slice(0, 5)
      .map((issue) => issue.key)
      .join(', ');
    setMessage(
      `Подключение работает: доска ${boardId} на ${baseUrl}, задач в статусе «${config.status}»: ${issues.length}` +
        (sample ? ` (например ${sample})` : ''),
      'ok',
    );
  } catch (error) {
    setMessage(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    button.disabled = false;
  }
});

document.getElementById('reset').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'reset-state' });
  setMessage('Состояние сброшено: задачи будут заново запомнены при следующем опросе.', 'ok');
});

authSelect.addEventListener('change', applyAuthVisibility);

load();
