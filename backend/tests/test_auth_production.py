"""Production must not retain the public development login after an upgrade."""
import pytest
from fastapi import HTTPException

from backend import auth, db
from backend.models import UserUpdateRequest


@pytest.fixture(autouse=True)
def isolated_accounts(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "auth.db"))
    monkeypatch.setattr(db, "_SCHEMA_READY", False)
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("ENABLE_E2E_TEST_USER", "1")


@pytest.mark.parametrize("environment", ["production", "prod"])
def test_production_never_provisions_test_account(environment, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", environment)
    auth._ensure_test_user()
    assert auth._get_user_by_username("testuser") is None


def test_production_disables_existing_default_account_and_issued_token(monkeypatch):
    auth._ensure_test_user()
    before = auth._get_user_by_username("testuser")
    token = auth._create_access_token(auth._user_row_to_public(before))
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("ENABLE_E2E_TEST_USER", "0")

    auth._ensure_test_user()

    after = auth._get_user_by_username("testuser")
    assert after is not None and not after["active"]
    assert after["id"] == before["id"]
    assert after["password_hash"] == before["password_hash"]
    with pytest.raises(HTTPException) as error:
        auth._verify_token_and_get_user(token)
    assert error.value.status_code == 403


def test_production_preserves_testuser_with_custom_password(monkeypatch):
    auth._create_user("testuser", "custom-local-test-password", "user")
    before = dict(auth._get_user_by_username("testuser"))
    monkeypatch.setenv("ENVIRONMENT", "production")

    auth._ensure_test_user()

    assert dict(auth._get_user_by_username("testuser")) == before


def test_local_test_account_is_available_and_existing_password_is_not_reset():
    auth._ensure_test_user()
    assert auth._get_user_by_username("testuser")["active"]
    auth._update_user("testuser", UserUpdateRequest(password="custom-local-test-password"))
    before = dict(auth._get_user_by_username("testuser"))
    auth._ensure_test_user()
    assert dict(auth._get_user_by_username("testuser")) == before


def test_local_test_account_can_be_explicitly_disabled(monkeypatch):
    monkeypatch.setenv("ENABLE_E2E_TEST_USER", "0")
    auth._ensure_test_user()
    assert auth._get_user_by_username("testuser") is None
