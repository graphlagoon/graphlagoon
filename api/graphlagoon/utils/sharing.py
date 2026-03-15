"""Sharing utility functions for domain-based wildcard matching."""


def is_domain_wildcard(email: str) -> bool:
    """Check if an email string is a domain wildcard (e.g. *@stone.com.br)."""
    return email.startswith("*@") and len(email) > 2


def extract_domain(email: str) -> str:
    """Extract domain from an email or wildcard (e.g. joao@stone.com.br -> stone.com.br)."""
    if "@" not in email:
        return ""
    return email.split("@", 1)[1].lower()


def email_matches_share(user_email: str, shared_with_email: str) -> bool:
    """Check if a user_email matches a share entry.

    Handles both exact email matches and domain wildcards:
    - "joao@stone.com.br" matches "joao@stone.com.br" (exact)
    - "joao@stone.com.br" matches "*@stone.com.br" (wildcard)
    - "joao@gmail.com" does NOT match "*@stone.com.br"
    """
    if shared_with_email == user_email:
        return True
    if is_domain_wildcard(shared_with_email):
        return extract_domain(shared_with_email) == extract_domain(user_email)
    return False


def user_has_share_access(user_email: str, shares: list) -> bool:
    """Check if user_email matches any share in a list of share objects.

    Each share object must have a `shared_with_email` attribute.
    """
    return any(email_matches_share(user_email, s.shared_with_email) for s in shares)


def user_has_write_access(user_email: str, shares: list) -> bool:
    """Check if user_email has write permission via any matching share."""
    return any(
        email_matches_share(user_email, s.shared_with_email) and s.permission == "write"
        for s in shares
    )


def validate_share_email(
    email: str, allowed_share_domains: list[str]
) -> tuple[bool, str]:
    """Validate a share email/wildcard against allowed domains.

    Returns (is_valid, error_message).
    - Regular emails are always valid.
    - Wildcard emails (*@domain) require the domain to be in allowed_share_domains.
    """
    if is_domain_wildcard(email):
        domain = extract_domain(email)
        if not allowed_share_domains:
            return (
                False,
                "Domain wildcard sharing is not enabled. No allowed domains configured.",
            )
        allowed_lower = [d.lower() for d in allowed_share_domains]
        if domain not in allowed_lower:
            return False, (
                f"Domain '{domain}' is not in the allowed share domains: "
                f"{', '.join(allowed_share_domains)}"
            )
        return True, ""
    if "@" not in email or email.startswith("@"):
        return False, f"Invalid email format: {email}"
    return True, ""
