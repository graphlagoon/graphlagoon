"""Tests for sharing utility functions (domain-based wildcard matching)."""

from graphlagoon.models.schemas import ShareRequest
from graphlagoon.utils.sharing import (
    PUBLIC_SHARE_EMAIL,
    is_domain_wildcard,
    is_public_share,
    extract_domain,
    email_matches_share,
    share_match_emails,
    user_has_share_access,
    user_has_write_access,
    validate_share_email,
)


# --- is_domain_wildcard ---


def test_is_domain_wildcard_true():
    assert is_domain_wildcard("*@stone.com.br") is True
    assert is_domain_wildcard("*@company.com") is True


def test_is_domain_wildcard_false():
    assert is_domain_wildcard("joao@stone.com.br") is False
    assert is_domain_wildcard("*@") is False
    assert is_domain_wildcard("*") is False
    assert is_domain_wildcard("") is False


# --- extract_domain ---


def test_extract_domain_regular_email():
    assert extract_domain("joao@stone.com.br") == "stone.com.br"


def test_extract_domain_wildcard():
    assert extract_domain("*@stone.com.br") == "stone.com.br"


def test_extract_domain_no_at():
    assert extract_domain("noemail") == ""


def test_extract_domain_case_insensitive():
    assert extract_domain("Joao@Stone.COM.BR") == "stone.com.br"


# --- email_matches_share ---


def test_exact_match():
    assert email_matches_share("joao@stone.com.br", "joao@stone.com.br") is True


def test_exact_no_match():
    assert email_matches_share("joao@stone.com.br", "maria@stone.com.br") is False


def test_wildcard_match():
    assert email_matches_share("joao@stone.com.br", "*@stone.com.br") is True
    assert email_matches_share("maria@stone.com.br", "*@stone.com.br") is True


def test_wildcard_no_match():
    assert email_matches_share("joao@gmail.com", "*@stone.com.br") is False


def test_wildcard_case_insensitive_domain():
    assert email_matches_share("joao@Stone.COM.BR", "*@stone.com.br") is True
    assert email_matches_share("joao@stone.com.br", "*@Stone.COM.BR") is True


# --- user_has_share_access ---


class FakeShare:
    def __init__(self, email, permission="read"):
        self.shared_with_email = email
        self.permission = permission


def test_user_has_share_access_exact():
    shares = [FakeShare("joao@stone.com.br")]
    assert user_has_share_access("joao@stone.com.br", shares) is True
    assert user_has_share_access("maria@stone.com.br", shares) is False


def test_user_has_share_access_wildcard():
    shares = [FakeShare("*@stone.com.br")]
    assert user_has_share_access("joao@stone.com.br", shares) is True
    assert user_has_share_access("maria@stone.com.br", shares) is True
    assert user_has_share_access("joao@gmail.com", shares) is False


def test_user_has_share_access_mixed():
    shares = [
        FakeShare("specific@other.com"),
        FakeShare("*@stone.com.br"),
    ]
    assert user_has_share_access("specific@other.com", shares) is True
    assert user_has_share_access("anyone@stone.com.br", shares) is True
    assert user_has_share_access("nobody@gmail.com", shares) is False


def test_user_has_share_access_empty():
    assert user_has_share_access("joao@stone.com.br", []) is False


# --- user_has_write_access ---


def test_user_has_write_access_exact():
    shares = [FakeShare("joao@stone.com.br", "write")]
    assert user_has_write_access("joao@stone.com.br", shares) is True


def test_user_has_write_access_read_only():
    shares = [FakeShare("joao@stone.com.br", "read")]
    assert user_has_write_access("joao@stone.com.br", shares) is False


def test_user_has_write_access_wildcard():
    shares = [FakeShare("*@stone.com.br", "write")]
    assert user_has_write_access("joao@stone.com.br", shares) is True
    assert user_has_write_access("maria@stone.com.br", shares) is True


def test_user_has_write_access_wildcard_read_only():
    shares = [FakeShare("*@stone.com.br", "read")]
    assert user_has_write_access("joao@stone.com.br", shares) is False


# --- validate_share_email ---


def test_validate_regular_email_valid():
    valid, msg = validate_share_email("joao@stone.com.br", [])
    assert valid is True
    assert msg == ""


def test_validate_regular_email_invalid():
    valid, msg = validate_share_email("noemail", [])
    assert valid is False
    assert "Invalid email" in msg


def test_validate_regular_email_starts_with_at():
    valid, msg = validate_share_email("@stone.com.br", [])
    assert valid is False


def test_validate_wildcard_allowed():
    valid, msg = validate_share_email("*@stone.com.br", ["stone.com.br"])
    assert valid is True
    assert msg == ""


def test_validate_wildcard_allowed_case_insensitive():
    valid, msg = validate_share_email(
        "*@Stone.COM.BR",
        ["stone.com.br"],
    )
    assert valid is True


def test_validate_wildcard_not_in_allowed():
    valid, msg = validate_share_email("*@gmail.com", ["stone.com.br"])
    assert valid is False
    assert "gmail.com" in msg
    assert "stone.com.br" in msg


def test_validate_wildcard_no_domains_configured():
    valid, msg = validate_share_email("*@stone.com.br", [])
    assert valid is False
    assert "not enabled" in msg


def test_validate_wildcard_multiple_allowed():
    valid, msg = validate_share_email(
        "*@company.com",
        ["stone.com.br", "company.com"],
    )
    assert valid is True


# --- public sharing ("*" sentinel) ---


def test_is_public_share():
    assert is_public_share("*") is True
    assert is_public_share("*@stone.com.br") is False
    assert is_public_share("joao@stone.com.br") is False
    assert is_public_share("") is False


def test_public_share_matches_any_email():
    assert email_matches_share("anyone@anywhere.com", PUBLIC_SHARE_EMAIL) is True
    assert email_matches_share("joao@stone.com.br", PUBLIC_SHARE_EMAIL) is True


def test_public_share_only_exact_sentinel():
    # Regression: only "*" is public; "*x" or "*@domain" keep their semantics
    assert email_matches_share("user@a.com", "*x") is False
    assert email_matches_share("user@a.com", "*@b.com") is False


def test_user_has_share_access_public():
    shares = [FakeShare(PUBLIC_SHARE_EMAIL)]
    assert user_has_share_access("anyone@anywhere.com", shares) is True


def test_public_share_never_grants_write():
    # Defense-in-depth: even a hand-inserted ("*", "write") row must not
    # grant write access to the world.
    shares = [FakeShare(PUBLIC_SHARE_EMAIL, "write")]
    assert user_has_write_access("anyone@anywhere.com", shares) is False


def test_public_share_does_not_block_other_write_shares():
    shares = [
        FakeShare(PUBLIC_SHARE_EMAIL, "read"),
        FakeShare("editor@stone.com.br", "write"),
    ]
    assert user_has_write_access("editor@stone.com.br", shares) is True
    assert user_has_write_access("viewer@gmail.com", shares) is False


def test_validate_public_share_always_valid():
    assert validate_share_email("*", []) == (True, "")
    assert validate_share_email("*", ["stone.com.br"]) == (True, "")


def test_validate_public_lookalike_invalid():
    valid, _ = validate_share_email("*x", [])
    assert valid is False


# --- share_match_emails ---


def test_share_match_emails_with_domain():
    assert share_match_emails("joao@stone.com.br") == [
        "joao@stone.com.br",
        "*",
        "*@stone.com.br",
    ]


def test_share_match_emails_without_domain():
    assert share_match_emails("noatsign") == ["noatsign", "*"]


# --- ShareRequest coercion ---


def test_share_request_public_coerces_write_to_read():
    req = ShareRequest(email="*", permission="write")
    assert req.permission == "read"


def test_share_request_regular_write_untouched():
    req = ShareRequest(email="joao@stone.com.br", permission="write")
    assert req.permission == "write"
