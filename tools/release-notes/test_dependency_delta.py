"""Tests for the release-notes dependency delta.

The fixtures deliberately mix cases that a careless implementation would treat
alike — a dev package beside a production one, an unchanged package beside a
bumped one, the same package resolved at two depths — so that a test failing
here names a real behaviour rather than a shape.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

# The module name has a hyphen, matching the other tools in this repo
# (update-sbom-doc.py, generate-coverage-doc.py), so it cannot be imported by
# name. Load it by path instead.
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "dependency_delta",
    Path(__file__).resolve().parent / "dependency-delta.py",
)
dd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dd)


def lock(packages, lockfile_version=3):
    return json.dumps({"lockfileVersion": lockfile_version, "packages": packages})


# ── package_name ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("path,expected", [
    ("node_modules/express", "express"),
    ("node_modules/@azure/msal-browser", "@azure/msal-browser"),
    # Nested copies report the LEAF, not the parent that pulled them in.
    ("node_modules/typed-rest-client/node_modules/qs", "qs"),
    ("node_modules/a/node_modules/@scope/b", "@scope/b"),
])
def test_package_name_extracts_the_leaf(path, expected):
    assert dd.package_name(path) == expected


@pytest.mark.parametrize("path", ["", "app/api", "node_modules/"])
def test_package_name_rejects_non_packages(path):
    assert dd.package_name(path) is None


# ── production_versions ──────────────────────────────────────────────────────

def test_production_versions_keeps_prod_and_drops_dev():
    """The whole point of the filter: both entries are real, one must survive.

    A mutant that ignores the `dev` flag passes a fixture containing only dev
    packages, and one that drops everything passes a fixture containing only
    production packages. Neither passes this.
    """
    text = lock({
        "": {"name": "api", "version": "5.0.0"},
        "node_modules/multer": {"version": "2.4.0"},
        "node_modules/eslint": {"version": "10.11.0", "dev": True},
    })
    assert dd.production_versions(text) == {"multer": "2.4.0"}


def test_production_versions_skips_workspace_links_and_versionless_entries():
    text = lock({
        "node_modules/@ui": {"resolved": "app/ui", "link": True},
        "node_modules/broken": {"resolved": "https://example.invalid/x.tgz"},
        "node_modules/real": {"version": "1.2.3"},
    })
    assert dd.production_versions(text) == {"real": "1.2.3"}


def test_production_versions_prefers_the_shallowest_copy():
    """Two versions of `qs` ship; the top-level one is what the notes name."""
    text = lock({
        "node_modules/qs": {"version": "6.16.0"},
        "node_modules/typed-rest-client/node_modules/qs": {"version": "6.15.1"},
    })
    assert dd.production_versions(text)["qs"] == "6.16.0"


def test_production_versions_prefers_shallowest_regardless_of_order():
    """Same fixture, deeper entry first — dict order must not decide."""
    text = lock({
        "node_modules/typed-rest-client/node_modules/qs": {"version": "6.15.1"},
        "node_modules/qs": {"version": "6.16.0"},
    })
    assert dd.production_versions(text)["qs"] == "6.16.0"


@pytest.mark.parametrize("text", ["", None, "not json", "[]"])
def test_production_versions_survives_unusable_input(text):
    assert dd.production_versions(text) == {}


def test_production_versions_ignores_lockfile_v1_shape():
    """v1 has `dependencies`, not `packages` — report nothing, don't guess."""
    text = json.dumps({
        "lockfileVersion": 1,
        "dependencies": {"express": {"version": "4.0.0"}},
    })
    assert dd.production_versions(text) == {}


# ── diff_versions ────────────────────────────────────────────────────────────

def test_diff_versions_separates_the_three_outcomes():
    old = {"same": "1.0.0", "bumped": "2.3.0", "gone": "1.1.1"}
    new = {"same": "1.0.0", "bumped": "2.4.0", "fresh": "0.1.0"}

    added, updated, removed = dd.diff_versions(old, new)

    assert added == ["fresh"]
    assert updated == [("bumped", "2.3.0", "2.4.0")]
    assert removed == ["gone"]


def test_diff_versions_ignores_an_unchanged_package():
    """`same` is in both maps at one version and must appear nowhere."""
    added, updated, removed = dd.diff_versions({"same": "1.0.0"}, {"same": "1.0.0"})
    assert (added, updated, removed) == ([], [], [])


def test_diff_versions_orders_by_name():
    old = {"b": "1", "a": "1"}
    new = {"b": "2", "a": "2"}
    _, updated, _ = dd.diff_versions(old, new)
    assert [name for name, _, _ in updated] == ["a", "b"]


# ── base_images ──────────────────────────────────────────────────────────────

def test_base_images_reads_the_digest_through_an_as_clause():
    text = (
        "FROM node:24-slim@sha256:" + "a" * 64 + " AS frontend-build\n"
        "RUN npm ci\n"
    )
    assert dd.base_images(text) == {"node:24-slim": "sha256:" + "a" * 64}


def test_base_images_collapses_repeated_stages_of_one_image():
    digest = "sha256:" + "b" * 64
    text = (
        f"FROM node:24-slim@{digest} AS frontend-build\n"
        f"FROM node:24-slim@{digest} AS runtime\n"
    )
    assert dd.base_images(text) == {"node:24-slim": digest}


def test_base_images_records_an_unpinned_tag_as_none():
    assert dd.base_images("FROM postgres:16\n") == {"postgres:16": None}


def test_base_images_skips_scratch():
    assert dd.base_images("FROM scratch\n") == {}


@pytest.mark.parametrize("text", ["", None, "RUN echo not-a-from-line\n"])
def test_base_images_on_input_without_a_from(text):
    assert dd.base_images(text) == {}


# ── short_digest ─────────────────────────────────────────────────────────────

def test_short_digest_matches_the_dependabot_form():
    assert dd.short_digest("sha256:0e0ff40c39bc087845bfb27465a0df4e") == "0e0ff40"


def test_short_digest_names_an_unpinned_image():
    assert dd.short_digest(None) == "unpinned"


# ── render_package_bullets ───────────────────────────────────────────────────

def test_bullets_lead_with_updates_then_additions_then_removals():
    bullets = dd.render_package_bullets(
        added=["fresh"],
        updated=[("bumped", "2.3.0", "2.4.0")],
        removed=["gone"],
        max_items=0,
    )
    assert bullets == [
        "- `bumped` 2.3.0 → 2.4.0",
        "- `fresh` added",
        "- `gone` removed",
    ]


def test_bullets_render_the_move_old_to_new():
    """Direction matters: reversing it would still be three valid bullets."""
    bullets = dd.render_package_bullets([], [("multer", "2.3.0", "2.4.0")], [], 0)
    assert bullets == ["- `multer` 2.3.0 → 2.4.0"]


def test_bullets_truncate_and_say_how_many_were_hidden():
    updated = [(f"pkg{i:02d}", "1.0.0", "1.1.0") for i in range(5)]
    bullets = dd.render_package_bullets([], updated, [], max_items=2)

    assert len(bullets) == 3
    assert bullets[-1] == "- …and 3 more — see the SBOM attached to this release"


def test_bullets_do_not_truncate_when_the_limit_is_not_reached():
    updated = [(f"pkg{i}", "1.0.0", "1.1.0") for i in range(2)]
    bullets = dd.render_package_bullets([], updated, [], max_items=5)
    assert len(bullets) == 2
    assert "more" not in bullets[-1]


def test_bullets_are_empty_when_nothing_changed():
    assert dd.render_package_bullets([], [], [], 0) == []


# ── render ───────────────────────────────────────────────────────────────────

def test_render_emits_nothing_when_no_section_has_bullets():
    """The caller appends unconditionally, so a bare heading must be impossible."""
    assert dd.render([("API runtime", []), ("Frontend", [])], []) == ""


def test_render_drops_empty_sections_but_keeps_populated_ones():
    out = dd.render(
        [("API runtime", ["- `multer` 2.3.0 → 2.4.0"]), ("Frontend", [])],
        [],
    )
    assert "## Dependency updates" in out
    assert "### API runtime" in out
    assert "### Frontend" not in out


def test_render_includes_container_images_section():
    out = dd.render([], ["- `node:24-slim` (app/api) `2fe369e` → `0e0ff40`"])
    assert "### Container images" in out
    assert "0e0ff40" in out


def test_render_starts_with_a_blank_line_so_it_appends_cleanly():
    out = dd.render([("API runtime", ["- `x` 1 → 2"])], [])
    assert out.startswith("\n## Dependency updates\n")
    assert out.endswith("\n")


# ── collect / main ───────────────────────────────────────────────────────────

def test_collect_reports_a_bump_across_a_fake_history(monkeypatch):
    """End-to-end over the git layer, with `git show` stubbed per (ref, path)."""
    old_lock = lock({
        "node_modules/multer": {"version": "2.3.0"},
        "node_modules/eslint": {"version": "10.10.0", "dev": True},
    })
    new_lock = lock({
        "node_modules/multer": {"version": "2.4.0"},
        "node_modules/eslint": {"version": "10.11.0", "dev": True},
    })
    old_docker = "FROM node:24-slim@sha256:" + "a" * 64 + " AS runtime\n"
    new_docker = "FROM node:24-slim@sha256:" + "b" * 64 + " AS runtime\n"

    files = {
        ("v1", "app/api/package-lock.json"): old_lock,
        ("v2", "app/api/package-lock.json"): new_lock,
        ("v1", "app/api/Dockerfile"): old_docker,
        ("v2", "app/api/Dockerfile"): new_docker,
    }
    monkeypatch.setattr(dd, "git_show", lambda ref, path: files.get((ref, path)))

    out = dd.collect("v1", "v2", max_items=0)

    assert "- `multer` 2.3.0 → 2.4.0" in out
    # The dev-only bump moved too, and must not be advertised as shipped.
    assert "eslint" not in out
    assert "- `node:24-slim` (app/api) `aaaaaaa` → `bbbbbbb`" in out


def test_collect_is_silent_when_nothing_shipped_changed(monkeypatch):
    same = lock({"node_modules/multer": {"version": "2.4.0"}})
    monkeypatch.setattr(
        dd, "git_show",
        lambda ref, path: same if path.endswith("package-lock.json") else None,
    )
    assert dd.collect("v1", "v2", max_items=0) == ""


def test_main_writes_nothing_without_a_previous_ref(monkeypatch, capsys):
    """A first release in a series has nothing to diff — and must not crash."""
    monkeypatch.setattr(dd, "collect", lambda *a, **k: "SHOULD NOT RUN")
    assert dd.main(["", "v5.10.0"]) == 0
    assert capsys.readouterr().out == ""


def test_main_prints_the_collected_section(monkeypatch, capsys):
    monkeypatch.setattr(dd, "collect", lambda *a, **k: "\n## Dependency updates\n")
    assert dd.main(["v5.9.1", "v5.10.0"]) == 0
    assert capsys.readouterr().out == "\n## Dependency updates\n"


def test_main_passes_the_section_cap_through(monkeypatch):
    seen = {}
    monkeypatch.setattr(
        dd, "collect",
        lambda prev, cur, max_items: seen.update(max_items=max_items) or "",
    )
    dd.main(["v1", "v2", "--max-per-section", "7"])
    assert seen["max_items"] == 7


def test_git_show_returns_none_for_a_missing_path():
    """Exercises the real subprocess against this repo's own history."""
    assert dd.git_show("HEAD", "no/such/file/anywhere.json") is None


def test_main_forces_utf8_stdout_for_the_arrow(monkeypatch):
    """The bullets carry "→"; a cp1252 stdout would raise instead of printing.

    CI is UTF-8 so this only ever bites a maintainer previewing on Windows,
    which is precisely why it needs a test rather than a code review.
    """
    calls = {}

    class FakeStdout:
        def reconfigure(self, encoding=None):
            calls["encoding"] = encoding

        def write(self, text):
            calls["written"] = text

    monkeypatch.setattr(sys, "stdout", FakeStdout())
    monkeypatch.setattr(dd, "collect", lambda *a, **k: "- `x` 1 → 2\n")

    dd.main(["v1", "v2"])

    assert calls["encoding"] == "utf-8"
    assert "→" in calls["written"]


# ── declared_dependencies / restrict ─────────────────────────────────────────

def test_declared_dependencies_excludes_dev_dependencies():
    """Both keys are populated, so a mutant merging them fails here."""
    manifest = json.dumps({
        "dependencies": {"react": "^19.0.0", "exceljs": "^4.4.0"},
        "devDependencies": {"vite": "^8.3.0"},
    })
    assert dd.declared_dependencies(manifest) == {"react", "exceljs"}


@pytest.mark.parametrize("manifest", [
    "", None, "not json", "[]", json.dumps({"devDependencies": {"vite": "1"}}),
])
def test_declared_dependencies_on_unusable_input(manifest):
    assert dd.declared_dependencies(manifest) == set()


def test_restrict_keeps_only_named_packages():
    versions = {"react": "19.0.0", "@rolldown/binding-darwin-x64": "1.2.8"}
    assert dd.restrict(versions, {"react"}) == {"react": "19.0.0"}


def test_collect_restricts_the_ui_to_declared_dependencies(monkeypatch):
    """The real defect this rule exists for.

    `@tailwindcss/vite` is a declared UI dependency, so npm marks its
    `@rolldown/binding-*` platform binaries production — but the UI ships
    compiled dist/, so those binaries reach no image and must not appear.
    react, declared and bundled, must.
    """
    def ui_lock(react_version, binding_version):
        return lock({
            "node_modules/react": {"version": react_version},
            "node_modules/@rolldown/binding-darwin-x64": {"version": binding_version},
        })

    manifest = json.dumps({
        "dependencies": {"react": "^19.0.0", "@tailwindcss/vite": "^4.0.0"},
        "devDependencies": {"vite": "^8.3.0"},
    })
    files = {
        ("v1", "app/ui/package-lock.json"): ui_lock("19.0.0", "1.1.5"),
        ("v2", "app/ui/package-lock.json"): ui_lock("19.2.0", "1.2.8"),
        ("v1", "app/ui/package.json"): manifest,
        ("v2", "app/ui/package.json"): manifest,
    }
    monkeypatch.setattr(dd, "git_show", lambda ref, path: files.get((ref, path)))

    out = dd.collect("v1", "v2", max_items=0)

    assert "- `react` 19.0.0 → 19.2.0" in out
    assert "rolldown" not in out


def test_collect_keeps_the_api_transitive_closure(monkeypatch):
    """The API has no manifest filter: `npm ci --omit=dev` ships all of it."""
    def api_lock(version):
        return lock({"node_modules/deep-transitive-thing": {"version": version}})

    files = {
        ("v1", "app/api/package-lock.json"): api_lock("1.0.0"),
        ("v2", "app/api/package-lock.json"): api_lock("1.1.0"),
    }
    monkeypatch.setattr(dd, "git_show", lambda ref, path: files.get((ref, path)))

    out = dd.collect("v1", "v2", max_items=0)
    assert "- `deep-transitive-thing` 1.0.0 → 1.1.0" in out
