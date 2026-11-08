#!/usr/bin/env python
"""Upload voice-pack files to the ModelScope repo a1078185271/oh-my-dota2-voicepacks.

Run with the GPT-SoVITS runtime python (it has the modelscope SDK):

    set MS_TOKEN=ms-xxxx
    D:\\AI\\GPT-SoVITS-v2pro-20250604\\runtime\\python.exe scripts\\ms-voicepack-upload.py --dry-run <args>

Usage:
    ms-voicepack-upload.py local_path:repo_path [local_path:repo_path ...]
    ms-voicepack-upload.py --manifest <local voicepacks.json>     # uploads to repo root as voicepacks.json
    ms-voicepack-upload.py --readme <local README.md>             # uploads the model card
    ms-voicepack-upload.py --delete <repo_glob> [...]              # DRY-RUN friendly, but see below
    ms-voicepack-upload.py --self-test                              # asserts a failed delete exits 1

Taking a pack down: first upload a voicepacks.json that no longer lists it (that is what
clients read), then delete the leftover weight files IN THE WEB UI. `--delete` exists but
the backend always answers 401 {"Code":10010101003,"Message":"the current token no longer
supports deletion operations"}; the script reports deleted=0 failed=N and exits 1.

The retrain release flow is documented in docs/VOICEPACKS.md. Token ALWAYS comes
from env MS_TOKEN; never hardcode it here or in shell history.
"""
import os
import sys
import time

TOKEN = os.environ.get("MS_TOKEN")
REPO = "a1078185271/oh-my-dota2-voicepacks"
RUNTIME_PY = r"D:\AI\GPT-SoVITS-v2pro-20250604\runtime\python.exe"

def token_problem(tok):
    """A token that arrived through `set MS_TOKEN=ms-08` is truncated, and the only
    symptom is a 400 from api.login that reads like a code bug."""
    if not tok:
        return "missing (env MS_TOKEN)"
    if not tok.startswith("ms-"):
        return f"bad shape: expected ms-<hex>, got {len(tok)} chars without the ms- prefix"
    if len(tok) < 20:
        return f"truncated: {len(tok)} chars, a full token is ~39"
    return ""


def report_delete(pattern, result):
    """Turn a ModelScope delete result into an exit code. The SDK returns
    failed_files instead of raising, so a swallowed 401 must still fail loudly."""
    result = result or {}
    deleted = result.get("deleted_files") or []
    failed = result.get("failed_files") or []
    print(f"DELETE_RESULT {pattern} deleted={len(deleted)} failed={len(failed)}", flush=True)
    if failed:
        print(f"DELETE_FAIL delete these in the web UI: {failed[:5]}")
        return 1
    if not deleted:
        print(f"DELETE_NOOP {pattern} nothing matched")
        return 0
    print(f"DELETE_OK {pattern}", flush=True)
    return 0


def self_test():
    """Failure-path test: a delete that reported failures must exit 1, not print OK."""
    cases = [
        ("ok", {"deleted_files": ["a"], "failed_files": []}, 0),
        ("failed", {"deleted_files": [], "failed_files": ["a"]}, 1),
        ("noop", {}, 0),
    ]
    bad = 0
    for name, result, want in cases:
        got = report_delete(name, result)
        if got != want:
            print(f"SELFTEST_FAIL {name} want={want} got={got}")
            bad += 1
    print("SELFTEST_OK" if not bad else "SELFTEST_FAILED")
    return 0 if not bad else 1



def main() -> int:
    args = [a for a in sys.argv[1:]]
    dry = "--dry-run" in args
    args = [a for a in args if a != "--dry-run"]
    manifest = None
    readme = None
    deletes = []
    if "--manifest" in args:
        i = args.index("--manifest")
        manifest = args[i + 1]
        del args[i : i + 2]
    if "--readme" in args:
        i = args.index("--readme")
        readme = args[i + 1]
        del args[i : i + 2]
    while "--delete" in args:
        i = args.index("--delete")
        deletes.append(args[i + 1])
        del args[i : i + 2]
    if "--self-test" in args:
        return self_test()
    problem = "" if dry else token_problem(TOKEN)
    if problem:
        print(f"TOKEN_FAIL {problem}")
        return 1
    if deletes:
        if dry:
            for pattern in deletes:
                print(f"PLAN delete {pattern}")
            print("DRY_RUN ok")
            return 0
        from modelscope.hub.api import HubApi

        api = HubApi()
        api.login(TOKEN)
        for pattern in deletes:
            print(f"DELETE_START {pattern}", flush=True)
            # NOTE: HubApi.delete_files takes no token kwarg (cookies only) and the backend
            # rejects token auth: {"Code":10010101003,"Message":"the current token no longer
            # supports deletion operations"} -> 401. Deletion now needs the web UI.
            result = api.delete_files(
                repo_id=REPO,
                repo_type="model",
                delete_patterns=pattern,
            ) or {}
            if report_delete(pattern, result) != 0:
                return 1
        print("ALL_OK")
        return 0
    pairs = []
    for a in args:
        if ":" not in a:
            print(f"BAD_ARG {a}: expected local_path:repo_path")
            return 1
        local, repo = a.rsplit(":", 1)
        pairs.append((local, repo.replace("\\", "/")))
    # manifest/readme LAST: files must exist in the repo before the manifest
    # points at them, or a client refreshing mid-upload sees broken downloads
    if manifest:
        pairs.append((manifest, "voicepacks.json"))
    if readme:
        pairs.append((readme, "README.md"))

    if not pairs:
        print(__doc__)
        return 1

    for local, repo in pairs:
        if not os.path.isfile(local):
            print(f"MISSING {local}")
            return 1
        print(f"PLAN {repo} <- {local} ({os.path.getsize(local)} bytes)")
    if dry:
        print("DRY_RUN ok")
        return 0

    from modelscope.hub.api import HubApi

    api = HubApi()
    api.login(TOKEN)
    for local, repo in pairs:
        t0 = time.time()
        print(f"UPLOAD_START {repo}", flush=True)
        try:
            # NOTE: upload_file takes keyword args only; positional args raise TypeError.
            api.upload_file(
                path_or_fileobj=local,
                path_in_repo=repo,
                repo_id=REPO,
                token=TOKEN,
                commit_message=f"update {repo}",
                disable_tqdm=True,
            )
        except Exception as e:  # noqa: BLE001 - report and keep going is worse, fail loud
            print(f"UPLOAD_FAIL {repo}: {type(e).__name__}: {e}")
            return 1
        print(f"UPLOAD_OK {repo} {time.time() - t0:.1f}s", flush=True)
    print("ALL_OK")
    print(f"verify: https://www.modelscope.cn/models/{REPO}/resolve/master/voicepacks.json")
    return 0


if __name__ == "__main__":
    if sys.executable.lower() != RUNTIME_PY.lower():
        print(f"WARNING: modelscope SDK lives in the GPT-SoVITS runtime; if import fails run:\n  {RUNTIME_PY} {' '.join(sys.argv)}")
    sys.exit(main())
