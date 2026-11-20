import tempfile
import unittest
from pathlib import Path
from unittest import mock
from unittest.mock import patch

from main import (
    ConfigurationError,
    Config,
    JiraClient,
    SeenIssues,
    TelegramClient,
    check_once,
    parse_board_url,
)


def config_for(path: Path, notify_existing: bool = False) -> Config:
    return Config(
        jira_board_url="https://jira.example.test/jira/software/c/projects/DEMO/boards/42",
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


class BoardUrlTests(unittest.TestCase):
    def test_cloud_board_page_url(self):
        board = parse_board_url("https://demo.atlassian.net/jira/software/c/projects/DEMO/boards/42")
        self.assertEqual(board.base_url, "https://demo.atlassian.net")
        self.assertEqual(board.board_id, "42")

    def test_board_page_url_with_optional_board_suffix(self):
        board = parse_board_url(
            "https://demo.atlassian.net/jira/software/projects/DEMO/boards/42/board?atlOrigin=abc"
        )
        self.assertEqual(board.base_url, "https://demo.atlassian.net")
        self.assertEqual(board.board_id, "42")

    def test_server_context_path_is_kept_for_rest_url(self):
        board = parse_board_url("https://jira.example.test/jira/rest/agile/1.0/board/7/issue")
        self.assertEqual(board.base_url, "https://jira.example.test/jira")
        self.assertEqual(board.board_id, "7")
        self.assertEqual(
            board.issues_url,
            "https://jira.example.test/jira/rest/agile/1.0/board/7/issue",
        )

    def test_legacy_rapid_board_url(self):
        board = parse_board_url("https://jira.example.test/jira/secure/RapidBoard.jspa?rapidView=13")
        self.assertEqual(board.base_url, "https://jira.example.test/jira")
        self.assertEqual(board.board_id, "13")

    def test_url_without_board_id_is_rejected(self):
        with self.assertRaisesRegex(ConfigurationError, "Could not find a board ID"):
            parse_board_url("https://jira.example.test/jira/software/c/projects/DEMO")
        with self.assertRaisesRegex(ConfigurationError, "rapidView"):
            parse_board_url("https://jira.example.test/jira/secure/RapidBoard.jspa")


class ConfigurationTests(unittest.TestCase):
    def test_board_url_defines_base_url_and_board_id(self):
        env = {
            "JIRA_BOARD_URL": "https://jira.example.test/jira/rest/agile/1.0/board/42/issue",
            "JIRA_AUTH_MODE": "none",
            "TELEGRAM_BOT_TOKEN": "token",
            "TELEGRAM_CHAT_ID": "123",
        }
        with patch.dict("os.environ", env, clear=True):
            config = Config.from_env()
        self.assertEqual(config.jira_base_url, "https://jira.example.test/jira")
        self.assertEqual(config.jira_board_id, "42")
        self.assertEqual(config.jira_board_url, env["JIRA_BOARD_URL"])

    def test_status_can_be_changed_by_environment(self):
        env = {
            "JIRA_BOARD_URL": "https://jira.example.test/jira/software/c/projects/DEMO/boards/42",
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
            "JIRA_BOARD_URL": "https://jira.example.test/jira/software/c/projects/DEMO/boards/42",
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

    def test_matching_issues_uses_derived_board_endpoint(self):
        env = {
            "JIRA_BOARD_URL": "https://jira.example.test/jira/software/c/projects/DEMO/boards/42",
            "JIRA_AUTH_MODE": "none",
            "JIRA_STATUS": "Ready for QA",
            "TELEGRAM_BOT_TOKEN": "token",
            "TELEGRAM_CHAT_ID": "123",
        }
        response = mock.Mock()
        response.json.return_value = {"issues": [{"key": "DEMO-1"}], "total": 1}
        with patch.dict("os.environ", env, clear=True), patch("requests.Session.get", return_value=response) as get:
            client = JiraClient(Config.from_env())
            try:
                issues = client.matching_issues()
            finally:
                client.session.close()
        self.assertEqual([issue["key"] for issue in issues], ["DEMO-1"])
        self.assertEqual(
            get.call_args.args[0],
            "https://jira.example.test/rest/agile/1.0/board/42/issue",
        )
        self.assertEqual(get.call_args.kwargs["params"]["jql"], 'status = "Ready for QA"')

    def test_issue_link_keeps_context_path_from_board_url(self):
        env = {
            "JIRA_BOARD_URL": "https://jira.example.test/jira/rest/agile/1.0/board/42",
            "JIRA_AUTH_MODE": "none",
            "TELEGRAM_BOT_TOKEN": "token",
            "TELEGRAM_CHAT_ID": "123",
        }
        response = mock.Mock()
        response.json.return_value = {"ok": True}
        with patch.dict("os.environ", env, clear=True), patch("requests.Session.post", return_value=response) as post:
            telegram = TelegramClient(Config.from_env())
            try:
                telegram.send_issue({"key": "DEMO-1", "fields": {"summary": "Fix login"}})
            finally:
                telegram.session.close()
        text = post.call_args.kwargs["json"]["text"]
        self.assertIn('href="https://jira.example.test/jira/browse/DEMO-1"', text)
        self.assertIn("Fix login", text)

    def test_cookie_auth_requires_cookie_value(self):
        env = {
            "JIRA_BOARD_URL": "https://jira.example.test/jira/software/c/projects/DEMO/boards/42",
            "JIRA_AUTH_MODE": "cookie",
            "TELEGRAM_BOT_TOKEN": "token",
            "TELEGRAM_CHAT_ID": "123",
        }
        with patch.dict("os.environ", env, clear=True):
            with self.assertRaisesRegex(ValueError, "JIRA_COOKIE is required"):
                Config.from_env()


if __name__ == "__main__":
    unittest.main()
