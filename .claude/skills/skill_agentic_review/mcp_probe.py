"""Drive the local dev MCP server from a shell, and log every call.

The trial agents of skill_agentic_review use this as their only window on the
product: what an external agent sees (tools/list) and gets back (tool results).

    cd api && uv run python ../.claude/skills/skill_agentic_review/mcp_probe.py <command>

    token [--as EMAIL]            mint a dev agent token, print it (export GL_AGENT_TOKEN)
    surface                       server instructions, tool count, size of tools/list, biggest tools
    tools [NAME ...]              names + first description line; with names, full description + schema
    call TOOL '<json args>'       call a tool, print the result, append one line to the log
    report [LOG ...]              per-log totals: calls, errors, repeated calls, bytes returned

Environment: GL_URL (default http://localhost:8000/graphlagoon), GL_AGENT_TOKEN,
GL_PROBE_LOG (default ./mcp_probe.jsonl; give each trial its own file).
Local servers only: a trial writes cases and items as the token's owner.
"""

import argparse
import asyncio
import json
import os
import sys
import time
from collections import Counter
from urllib.parse import urlparse

URL = os.environ.get("GL_URL", "http://localhost:8000/graphlagoon").rstrip("/")
LOG = os.environ.get("GL_PROBE_LOG", "mcp_probe.jsonl")
DEV_USER = "dev@graphlagoon.local"


def _local_only() -> None:
    if urlparse(URL).hostname not in ("localhost", "127.0.0.1", "::1"):
        sys.exit(f"mcp_probe: {URL} is not a local server; trials write data and only run against local dev.")


def _token() -> str:
    token = os.environ.get("GL_AGENT_TOKEN")
    if not token:
        sys.exit("mcp_probe: set GL_AGENT_TOKEN (mint one with the 'token' command).")
    return token


def _session():
    import httpx2
    from mcp import Client
    from mcp.client.streamable_http import streamable_http_client

    http = httpx2.AsyncClient(headers={"Authorization": f"Bearer {_token()}"}, timeout=120)
    return Client(streamable_http_client(f"{URL}/mcp", http_client=http))


def _tokens(chars: int) -> int:
    return chars // 4  # rough; good enough to compare tools with each other


async def cmd_token(args) -> None:
    import httpx

    async with httpx.AsyncClient(timeout=30) as http:
        r = await http.post(
            f"{URL}/api/agent-tokens", json={"name": args.name}, headers={"X-Forwarded-Email": args.as_user}
        )
    if r.status_code >= 400:
        sys.exit(f"mcp_probe: could not mint a token ({r.status_code}): {r.text[:300]}")
    print(r.json()["token"])


async def _list_tools(client) -> list:
    return list((await client.list_tools()).tools)


def _dump(tool) -> dict:
    return tool.model_dump(mode="json", by_alias=True, exclude_none=True)


async def cmd_surface(args) -> None:
    async with _session() as client:
        tools = await _list_tools(client)
        instructions = client.instructions
    sizes = sorted(((len(json.dumps(_dump(t))), t.name) for t in tools), reverse=True)
    total = sum(size for size, _ in sizes)
    if instructions:
        print(f"instructions ({len(instructions)} chars):\n{instructions}\n")
    print(f"{len(tools)} tools; tools/list is {total} chars (~{_tokens(total)} tokens) in every agent's context")
    print("largest definitions:")
    for size, name in sizes[:10]:
        print(f"  {size:>6} chars  {name}")
    undescribed = [
        f"{t.name}.{param}"
        for t in tools
        for param, schema in (t.input_schema.get("properties") or {}).items()
        if not schema.get("description")
    ]
    print(f"parameters with no description: {len(undescribed)}")
    for name in undescribed[:40]:
        print(f"  {name}")


async def cmd_tools(args) -> None:
    async with _session() as client:
        tools = await _list_tools(client)
    if not args.names:
        for t in tools:
            print(f"{t.name}: {(t.description or '').strip().splitlines()[0] if t.description else ''}")
        return
    known = {t.name: t for t in tools}
    for name in args.names:
        if name not in known:
            print(f"no tool '{name}'")
            continue
        print(json.dumps(_dump(known[name]), indent=2, ensure_ascii=False))


async def cmd_call(args) -> None:
    try:
        arguments = json.loads(args.arguments)
    except json.JSONDecodeError as exc:
        sys.exit(f"mcp_probe: arguments are not JSON: {exc}")
    started = time.monotonic()
    is_error, text = False, ""
    try:
        async with _session() as client:
            result = await client.call_tool(args.tool, arguments)
        is_error = bool(result.is_error)
        text = "\n".join(getattr(c, "text", f"<{c.type} content>") for c in result.content)
    except Exception as exc:  # protocol-level failure: the agent sees this too
        while isinstance(exc, BaseExceptionGroup) and exc.exceptions:  # the transport wraps the cause
            exc = exc.exceptions[0]
        is_error, text = True, f"{type(exc).__name__}: {exc}"
    with open(LOG, "a", encoding="utf-8") as log:
        log.write(
            json.dumps(
                {
                    "tool": args.tool,
                    "args": arguments,
                    "is_error": is_error,
                    "chars": len(text),
                    "ms": round((time.monotonic() - started) * 1000),
                    "error": text[:400] if is_error else None,
                }
            )
            + "\n"
        )
    print(("ERROR\n" if is_error else "") + text)


def cmd_report(args) -> None:
    for path in args.logs or [LOG]:
        with open(path, encoding="utf-8") as log:
            calls = [json.loads(line) for line in log if line.strip()]
        errors = [c for c in calls if c["is_error"]]
        repeats = sum(n - 1 for n in Counter(json.dumps([c["tool"], c["args"]], sort_keys=True) for c in calls).values())
        chars = sum(c["chars"] for c in calls)
        print(
            f"{path}: {len(calls)} calls, {len(errors)} errors, {repeats} exact repeats, "
            f"{chars} chars returned (~{_tokens(chars)} tokens), {sum(c['ms'] for c in calls)} ms"
        )
        print("  sequence: " + " → ".join(c["tool"] + ("✗" if c["is_error"] else "") for c in calls))
        for c in errors:
            print(f"  ✗ {c['tool']}: {c['error']}")
        largest = max(calls, key=lambda c: c["chars"], default=None)
        if largest:
            print(f"  largest result: {largest['tool']} {largest['chars']} chars")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("token")
    p.add_argument("--as", dest="as_user", default=DEV_USER)
    p.add_argument("--name", default="agentic-review trial")
    sub.add_parser("surface")
    p = sub.add_parser("tools")
    p.add_argument("names", nargs="*")
    p = sub.add_parser("call")
    p.add_argument("tool")
    p.add_argument("arguments", nargs="?", default="{}")
    p = sub.add_parser("report")
    p.add_argument("logs", nargs="*")
    args = parser.parse_args()
    if args.command == "report":
        return cmd_report(args)
    _local_only()
    asyncio.run({"token": cmd_token, "surface": cmd_surface, "tools": cmd_tools, "call": cmd_call}[args.command](args))


if __name__ == "__main__":
    main()
