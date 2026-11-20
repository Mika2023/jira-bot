import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from main import Config, JiraClient, SeenIssues, check_once


def config_for(path: Path, notify_existing: bool = False) -> Config:
    return Config(
        jira_base_url="https://jira.example.test",
        jira_board_id="42",
        jira_status="Review QA completed",
        jira_auth_mode="none",
        jira_username=None,
        jira_password=None,
        jira_token=None,
        jira_cookie=None,
        telegram_bot_token="not-a-real-token",
        telegram_chat_id="123",
        poll_interval=60,
        request_timeout=20,
        database_path=path,
        notify_existing_on_start=notify_existing,
    )


class StoreTests(unittest.TestCase):
    def test_issue_is_persisted_across_connections(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.sqlite3"
            store = SeenIssues(path)
            store.add("DEMO-1")
            store.mark_initialized()
            store.close()

            reopened = SeenIssues(path)
            self.assertTrue(reopened.has("DEMO-1"))
            self.assertTrue(reopened.is_initialized())
            reopened.close()


class PollingTests(unittest.TestCase):
    def test_first_scan_baselines_then_notifies_only_new_issues(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.sqlite3"
            config = config_for(path)
            store = SeenIssues(path)

            class Jira:
                issues = [{"key": "DEMO-1"}]

                def matching_issues(self):
                    return self.issues

            class Telegram:
                sent = []

                def send_issue(self, issue):
                    self.sent.append(issue["key"])

            jira, telegram = Jira(), Telegram()
            check_once(config, jira, telegram, store)
            self.assertEqual(telegram.sent, [])  # Existing issue is silently recorded.

            jira.issues = [{"key": "DEMO-1"}, {"key": "DEMO-2"}]
            check_once(config, jira, telegram, store)
            check_once(config, jira, telegram, store)
            self.assertEqual(telegram.sent, ["DEMO-2"])
            store.close()

    def test_notify_existing_on_first_scan(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.sqlite3"
            config = config_for(path, notify_existing=True)
            store = SeenIssues(path)

            class Jira:
                def matching_issues(self):
                    return [{"key": "DEMO-1"}]

            class Telegram:
                sent = []

                def send_issue(self, issue):
                    self.sent.append(issue["key"])

            telegram = Telegram()
            check_once(config, Jira(), telegram, store)
            self.assertEqual(telegram.sent, ["DEMO-1"])
            store.close()


class ConfigurationTests(unittest.TestCase):
    def test_status_can_be_changed_by_environment(self):
        env = {
            "JIRA_BASE_URL": "https://jira.example.test",
            "JIRA_BOARD_ID": "42",
            "JIRA_AUTH_MODE": "none",
            "TELEGRAM_BOT_TOKEN": "token",
            "TELEGRAM_CHAT_ID": "123",
            "JIRA_STATUS": "Ready for QA",
        }
        with patch.dict("os.environ", env, clear=True):
            config = Config.from_env()
        self.assertEqual(config.jira_status, "Ready for QA")

    def test_cookie_auth_uses_cookie_header(self):
        cookie = "JSESSIONID=session-secret; atlassian.xsrf.token=csrf-secret"
        env = {
            "JIRA_BASE_URL": "https://jira.example.test",
            "JIRA_BOARD_ID": "42",
            "JIRA_AUTH_MODE": "cookie",
            "JIRA_COOKIE": cookie,
            "TELEGRAM_BOT_TOKEN": "token",
            "TELEGRAM_CHAT_ID": "123",
        }
        with patch.dict("os.environ", env, clear=True):
            config = Config.from_env()
        client = JiraClient(config)
        self.assertEqual(client.session.headers["Cookie"], cookie)
        self.assertIsNone(client.session.auth)
        client.session.close()

    def test_cookie_auth_requires_cookie_value(self):
        env = {
            "JIRA_BASE_URL": "https://jira.example.test",
            "JIRA_BOARD_ID": "42",
            "JIRA_AUTH_MODE": "cookie",
            "TELEGRAM_BOT_TOKEN": "token",
            "TELEGRAM_CHAT_ID": "123",
        }
        with patch.dict("os.environ", env, clear=True):
            with self.assertRaisesRegex(ValueError, "JIRA_COOKIE is required"):
                Config.from_env()


if __name__ == "__main__":
    unittest.main()
