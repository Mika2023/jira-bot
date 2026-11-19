"""Poll a Jira board and notify a Telegram chat about newly matching issues."""

from __future__ import annotations

import html
import logging
import os
import signal
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests

LOG = logging.getLogger("jira_bot")


class ConfigurationError(ValueError):
    pass


@dataclass(frozen=True)
class Config:
    jira_base_url: str
    jira_board_id: str
    jira_status: str
    jira_auth_mode: str
    jira_username: str | None
    jira_password: str | None
    jira_token: str | None
    telegram_bot_token: str
    telegram_chat_id: str
    poll_interval: int
    request_timeout: int
    database_path: Path
    notify_existing_on_start: bool

    @classmethod
    def from_env(cls) -> "Config":
        def required(name: str) -> str:
            value = os.getenv(name, "").strip()
            if not value:
                raise ConfigurationError(f"Required environment variable {name} is not set")
            return value

        auth_mode = os.getenv("JIRA_AUTH_MODE", "basic").strip().lower()
        if auth_mode not in {"basic", "bearer", "none"}:
            raise ConfigurationError("JIRA_AUTH_MODE must be basic, bearer, or none")

        username = os.getenv("JIRA_USERNAME", "").strip() or None
        password = os.getenv("JIRA_PASSWORD", "").strip() or None
        token = os.getenv("JIRA_TOKEN", "").strip() or None
        if auth_mode == "basic" and not (username and password):
            raise ConfigurationError("JIRA_USERNAME and JIRA_PASSWORD are required for basic auth")
        if auth_mode == "bearer" and not token:
            raise ConfigurationError("JIRA_TOKEN is required for bearer auth")

        try:
            poll_interval = int(os.getenv("POLL_INTERVAL_SECONDS", "60"))
            request_timeout = int(os.getenv("REQUEST_TIMEOUT_SECONDS", "20"))
        except ValueError as exc:
            raise ConfigurationError("Polling interval and request timeout must be integers") from exc
        if poll_interval < 5 or request_timeout < 1:
            raise ConfigurationError("POLL_INTERVAL_SECONDS must be >= 5 and REQUEST_TIMEOUT_SECONDS >= 1")

        return cls(
            jira_base_url=required("JIRA_BASE_URL").rstrip("/"),
            jira_board_id=required("JIRA_BOARD_ID"),
            jira_status=os.getenv("JIRA_STATUS", "Ревью СА выполнено").strip() or "Ревью СА выполнено",
            jira_auth_mode=auth_mode,
            jira_username=username,
            jira_password=password,
            jira_token=token,
            telegram_bot_token=required("TELEGRAM_BOT_TOKEN"),
            telegram_chat_id=required("TELEGRAM_CHAT_ID"),
            poll_interval=poll_interval,
            request_timeout=request_timeout,
            database_path=Path(os.getenv("DATABASE_PATH", "data/seen_issues.sqlite3")),
            notify_existing_on_start=os.getenv("NOTIFY_EXISTING_ON_START", "false").strip().lower()
            in {"1", "true", "yes", "on"},
        )


class SeenIssues:
    """Small durable deduplication store, shared across restarts."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path)
        self.connection.execute(
            "CREATE TABLE IF NOT EXISTS seen_issues (issue_key TEXT PRIMARY KEY, first_seen_at TEXT DEFAULT CURRENT_TIMESTAMP)"
        )
        self.connection.execute(
            "CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL)"
        )
        self.connection.commit()

    def is_initialized(self) -> bool:
        return self.connection.execute(
            "SELECT 1 FROM metadata WHERE name = 'initial_scan_done'"
        ).fetchone() is not None

    def mark_initialized(self) -> None:
        self.connection.execute(
            "INSERT OR REPLACE INTO metadata(name, value) VALUES ('initial_scan_done', '1')"
        )
        self.connection.commit()

    def has(self, issue_key: str) -> bool:
        return self.connection.execute(
            "SELECT 1 FROM seen_issues WHERE issue_key = ?", (issue_key,)
        ).fetchone() is not None

    def add(self, issue_key: str) -> None:
        self.connection.execute("INSERT OR IGNORE INTO seen_issues(issue_key) VALUES (?)", (issue_key,))
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()


class JiraClient:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.session = requests.Session()
        self.session.headers.update({"Accept": "application/json"})
        if config.jira_auth_mode == "basic":
            self.session.auth = (config.jira_username, config.jira_password)
        elif config.jira_auth_mode == "bearer":
            self.session.headers["Authorization"] = f"Bearer {config.jira_token}"

    def matching_issues(self) -> list[dict[str, Any]]:
        """Read all issues currently on the configured board and in the configured status."""
        endpoint = f"{self.config.jira_base_url}/rest/agile/1.0/board/{self.config.jira_board_id}/issue"
        status_for_jql = self.config.jira_status.replace("\\", "\\\\").replace('"', '\\"')
        params: dict[str, Any] = {
            "jql": f'status = "{status_for_jql}"',
            "fields": "summary,status,issuetype,assignee,project",
            "maxResults": 100,
            "startAt": 0,
        }
        issues: list[dict[str, Any]] = []
        while True:
            response = self.session.get(endpoint, params=params, timeout=self.config.request_timeout)
            response.raise_for_status()
            payload = response.json()
            page = payload.get("issues", [])
            issues.extend(page)
            params["startAt"] += len(page)
            if not page or params["startAt"] >= payload.get("total", 0):
                break
        return issues


class TelegramClient:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.session = requests.Session()
        self.endpoint = f"https://api.telegram.org/bot{config.telegram_bot_token}/sendMessage"

    def send_issue(self, issue: dict[str, Any]) -> None:
        fields = issue.get("fields") or {}
        key = issue.get("key", "(unknown key)")
        summary = fields.get("summary") or "(без названия)"
        status = (fields.get("status") or {}).get("name", self.config.jira_status)
        project = fields.get("project") or {}
        project_name = project.get("name") or project.get("key") or "Jira"
        issue_url = f"{self.config.jira_base_url}/browse/{key}"
        message = (
            f"🆕 Новая задача в статусе «{html.escape(status)}»\n"
            f"{html.escape(project_name)}: <a href=\"{html.escape(issue_url, quote=True)}\">"
            f"{html.escape(key)}</a> — {html.escape(summary)}"
        )
        response = self.session.post(
            self.endpoint,
            json={
                "chat_id": self.config.telegram_chat_id,
                "text": message,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            },
            timeout=self.config.request_timeout,
        )
        response.raise_for_status()
        result = response.json()
        if not result.get("ok"):
            raise RuntimeError(f"Telegram API rejected a message: {result.get('description', 'unknown error')}")


def check_once(config: Config, jira: JiraClient, telegram: TelegramClient, store: SeenIssues) -> None:
    issues = jira.matching_issues()
    LOG.info("Jira returned %d issue(s) currently in status %r", len(issues), config.jira_status)

    first_scan = not store.is_initialized()
    if first_scan and not config.notify_existing_on_start:
        for issue in issues:
            if issue.get("key"):
                store.add(issue["key"])
        store.mark_initialized()
        LOG.info("Initial scan complete; existing issues recorded without notifications")
        return

    for issue in issues:
        key = issue.get("key")
        if not key or store.has(key):
            continue
        telegram.send_issue(issue)
        store.add(key)
        LOG.info("Sent Telegram notification for %s", key)

    if first_scan:
        store.mark_initialized()


def run() -> None:
    try:
        config = Config.from_env()
    except ConfigurationError as exc:
        LOG.error("Configuration error: %s", exc)
        raise SystemExit(2) from exc

    jira = JiraClient(config)
    telegram = TelegramClient(config)
    store = SeenIssues(config.database_path)
    stop_event = threading.Event()

    def stop_handler(_signum: int, _frame: Any) -> None:
        stop_event.set()

    signal.signal(signal.SIGTERM, stop_handler)
    signal.signal(signal.SIGINT, stop_handler)
    LOG.info("Jira board watcher started; status=%r, board=%s", config.jira_status, config.jira_board_id)
    try:
        while not stop_event.is_set():
            started = time.monotonic()
            try:
                check_once(config, jira, telegram, store)
            except (requests.RequestException, ValueError, RuntimeError) as exc:
                # Exception strings may include URLs; Telegram bot URLs contain the secret token.
                LOG.error("Polling failed (%s); will retry after the next interval", type(exc).__name__)
            remaining = max(0, config.poll_interval - (time.monotonic() - started))
            stop_event.wait(remaining)
    finally:
        store.close()
        jira.session.close()
        telegram.session.close()
        LOG.info("Jira board watcher stopped")


if __name__ == "__main__":
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    run()
