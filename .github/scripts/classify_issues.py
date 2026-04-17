#!/usr/bin/env python3
"""Issue classification script for the unified triage & auto-fix workflow.

Handles two modes:
  - "new":  classify a single newly opened issue
  - "nightly": re-evaluate open issues with needs-clarification / cant-autofix

Outputs a JSON array to stdout with classification results, and writes
GitHub Actions outputs (has_issues, matrix) to $GITHUB_OUTPUT.
"""

import json
import os
import re
import subprocess
import sys
import urllib.request

# ── Config ──────────────────────────────────────────────────────────────────
API_KEY = os.environ["ANTHROPIC_API_KEY"]
MODEL = os.environ.get("MODEL", "claude-sonnet-4-5-20250929")
REPO = os.environ.get("GITHUB_REPOSITORY", "")
GITHUB_OUTPUT = os.environ.get("GITHUB_OUTPUT", "")

SKIP_LABELS = {"auto-fixed", "fix-in-progress"}
STALE_LABELS = {"needs-clarification", "cant-autofix"}


def call_claude(prompt: str) -> dict | None:
    """Call the Anthropic Messages API and return the parsed JSON response."""
    payload = json.dumps({
        "model": MODEL,
        "max_tokens": 1024,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "x-api-key": API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        print(f"::warning::Claude API call failed: {e}", file=sys.stderr)
        return None

    text = data.get("content", [{}])[0].get("text", "")
    if not text:
        print("::warning::Claude API returned no text", file=sys.stderr)
        return None

    # Strip markdown fences
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)

    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        print(f"::warning::Failed to parse Claude response as JSON: {e}", file=sys.stderr)
        print(f"Raw text: {text[:500]}", file=sys.stderr)
        return None


def build_prompt(project_context: str, title: str, body: str,
                 comments: str = "", mode: str = "new") -> str:
    """Build the classification prompt."""
    if mode == "re-evaluate":
        mode_instructions = """This is a RE-EVALUATION of an existing issue. New comments have been added
since the last triage. Use the comments to determine if there is now enough
information to act on.

If the new comments resolve the ambiguity:
- Set actionable=true, add "ready-to-fix" to labels, remove "needs-clarification"
- Set "remove_labels" to ["needs-clarification"] and/or ["cant-autofix"]

If still unclear, keep actionable=false and set comment to null (do not
ask for clarification again — the user already got a comment last time)."""
        comments_block = f"\n**Comments since last triage:**\n{comments}"
    else:
        mode_instructions = "This is a NEW issue that was just opened."
        comments_block = ""

    return f"""You are a triage agent for the Identity Atlas project — a Docker-deployed
application that pulls authorization data from Microsoft Graph into PostgreSQL,
then surfaces it through a React role-mining UI.

Here is a summary of the project structure and features:
---
{project_context}
---

{mode_instructions}

**Title:** {title}
**Body:** {body}
{comments_block}

Your job is to classify and triage this issue. Respond with ONLY a JSON object
(no markdown fences, no explanation) with these fields:

{{
  "labels": ["..."],
  "remove_labels": ["..."],
  "priority": "critical|high|medium|low",
  "actionable": true/false,
  "comment": "..." or null
}}

Rules for labels (pick all that apply):
- "bug" — something is broken or behaves incorrectly
- "enhancement" — a new feature request or improvement suggestion
- "ui" — relates to the React frontend / visual appearance
- "demo-data" — relates to the demo dataset
- "needs-clarification" — issue lacks enough detail (always set actionable=false)
- "ready-to-fix" — issue is specific enough to implement right now (always set actionable=true). ONLY for bugs, never for enhancements/features.

Rules for priority:
- "critical" — system down, data loss, security vulnerability
- "high" — major feature broken, blocking users
- "medium" — degraded experience but workaround exists
- "low" — cosmetic, minor inconvenience, nice-to-have

Rules for actionable:
- true ONLY for bugs that describe a specific, reproducible problem with
  enough detail to know what code to change
- false for ALL feature requests/enhancements (they need manual design review)
- false for vague issues or issues needing more info

Rules for remove_labels:
- List labels that should be removed (e.g. ["needs-clarification", "cant-autofix"]
  when a re-evaluated issue now has enough info)
- Set to [] if no labels should be removed

Rules for comment:
- If actionable=false and needs-clarification: write a friendly comment asking
  for specifics (which page? what steps? what browser? screenshot?). English only.
- If the issue is an enhancement: write a brief comment acknowledging the feature
  request and noting it needs manual review before implementation. English only.
- If actionable=true: set comment to null
- Keep comments concise (3-5 lines max)

Important:
- Issues may be written in Dutch — you can still triage them
- Do NOT add "ready-to-fix" and "needs-clarification" at the same time
- Do NOT add "ready-to-fix" to feature requests / enhancements
- Output ONLY the JSON object, nothing else"""


def gh(*args) -> str:
    """Run a gh CLI command and return stdout."""
    result = subprocess.run(["gh", *args], capture_output=True, text=True)
    if result.returncode != 0:
        print(f"::warning::gh {' '.join(args)} failed: {result.stderr}", file=sys.stderr)
        return ""
    return result.stdout.strip()


def get_human_comments(issue_number: int) -> str:
    """Fetch the last 5 non-bot comments on an issue."""
    raw = gh("issue", "view", str(issue_number), "--repo", REPO, "--json", "comments")
    if not raw:
        return ""
    comments = json.loads(raw).get("comments", [])
    human = [c for c in comments
             if not c.get("author", {}).get("login", "").endswith("[bot]")]
    if not human:
        return ""
    return "\n\n".join(
        f"@{c.get('author', {}).get('login', 'unknown')} ({c.get('createdAt', '')}):\n{c.get('body', '')}"
        for c in human[-5:]
    )


def apply_labels(issue_number: int, result: dict):
    """Apply labels, remove labels, and post comments via gh CLI."""
    # Add classification labels
    for label in result.get("labels", []):
        label = label.strip()
        if label:
            gh("issue", "edit", str(issue_number), "--repo", REPO, "--add-label", label)

    # Add priority label
    priority = result.get("priority", "")
    if priority in ("critical", "high", "medium", "low"):
        gh("issue", "edit", str(issue_number), "--repo", REPO,
           "--add-label", f"priority:{priority}")

    # Remove labels
    for label in result.get("remove_labels", []):
        label = label.strip()
        if label:
            gh("issue", "edit", str(issue_number), "--repo", REPO, "--remove-label", label)

    # Post comment
    comment = result.get("comment")
    if comment and comment != "null":
        gh("issue", "comment", str(issue_number), "--repo", REPO, "--body", comment)


def write_output(key: str, value: str):
    """Write a key=value pair to $GITHUB_OUTPUT."""
    if GITHUB_OUTPUT:
        with open(GITHUB_OUTPUT, "a") as f:
            f.write(f"{key}={value}\n")


def main():
    # Read project context
    try:
        with open("CLAUDE.md") as f:
            project_context = "".join(f.readlines()[:200])
    except FileNotFoundError:
        project_context = "(CLAUDE.md not found)"

    event_name = os.environ.get("EVENT_NAME", "")
    fix_items = []

    if event_name == "issues":
        # ── New issue ──
        number = int(os.environ.get("ISSUE_NUMBER", "0"))
        title = os.environ.get("ISSUE_TITLE", "")
        body = os.environ.get("ISSUE_BODY", "")

        print(f"Classifying new issue #{number}...")
        prompt = build_prompt(project_context, title, body, mode="new")
        result = call_claude(prompt)

        if result:
            print(f"Classification: {json.dumps(result, indent=2)}")
            apply_labels(number, result)
            if result.get("actionable"):
                fix_items.append({
                    "number": number,
                    "title": title,
                    "body": body[:2000],
                })
    else:
        # ── Nightly / manual re-evaluation ──
        print("Nightly re-evaluation: scanning for stale issues...")

        raw = gh("issue", "list", "--repo", REPO, "--state", "open",
                 "--json", "number,title,body,labels", "--limit", "50")
        if not raw:
            print("No issues found")
            write_output("has_issues", "false")
            write_output("matrix", '{"include":[]}')
            return

        all_issues = json.loads(raw)
        eligible = []
        for issue in all_issues:
            label_names = {l["name"] for l in issue.get("labels", [])}
            if label_names & STALE_LABELS and not (label_names & SKIP_LABELS):
                eligible.append(issue)

        print(f"Found {len(eligible)} issue(s) to re-evaluate")

        for issue in eligible:
            number = issue["number"]
            title = issue["title"]
            body = (issue.get("body") or "")[:2000]

            comments = get_human_comments(number)
            if not comments:
                print(f"  #{number}: no human comments since last triage — skipping")
                continue

            print(f"  Re-evaluating #{number}...")
            prompt = build_prompt(project_context, title, body, comments, mode="re-evaluate")
            result = call_claude(prompt)

            if result:
                print(f"  #{number} result: {json.dumps(result, indent=2)}")
                apply_labels(number, result)
                if result.get("actionable"):
                    fix_items.append({
                        "number": number,
                        "title": title,
                        "body": body,
                    })

    # Write outputs
    if fix_items:
        print(f"\n{len(fix_items)} issue(s) ready for auto-fix")
        write_output("has_issues", "true")
        write_output("matrix", json.dumps({"include": fix_items}))
    else:
        print("\nNo actionable issues to fix")
        write_output("has_issues", "false")
        write_output("matrix", '{"include":[]}')


if __name__ == "__main__":
    main()
