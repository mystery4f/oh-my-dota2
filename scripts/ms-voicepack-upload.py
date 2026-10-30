#!/usr/bin/env python
"""Upload voice-pack files to the ModelScope repo a1078185271/oh-my-dota2-voicepacks.

Run with the GPT-SoVITS runtime python (it has the modelscope SDK):

    set MS_TOKEN=ms-xxxx
    D:\\AI\\GPT-SoVITS-v2pro-20250604\\runtime\\python.exe scripts\\ms-voicepack-upload.py --dry-run <args>

Usage:
    ms-voicepack-upload.py local_path:repo_path [local_path:repo_path ...]
    ms-voicepack-upload.py --manifest <local voicepacks.json>     # uploads to repo root as voicepacks.json
    ms-voicepack-upload.py --readme <local README.md>             # uploads the model card

The retrain release flow is documented in docs/VOICEPACKS.md. Token ALWAYS comes
from env MS_TOKEN; never hardcode it here or in shell history.
"""
import os
import sys
import time

TOKEN = os.environ.get("MS_TOKEN")
REPO = "a1078185271/oh-my-dota2-voicepacks"
RUNTIME_PY = r"D:\AI\GPT-SoVITS-v2pro-20250604\runtime\python.exe"


def main() -> int:
    args = [a for a in sys.argv[1:]]
    dry = "--dry-run" in args
    args = [a for a in args if a != "--dry-run"]
    manifest = None
    readme = None
    if "--manifest" in args:
        i = args.index("--manifest")
        manifest = args[i + 1]
        del args[i : i + 2]
    if "--readme" in args:
        i = args.index("--readme")
        readme = args[i + 1]
        del args[i : i + 2]

    pairs = []
    if manifest:
        pairs.append((manifest, "voicepacks.json"))
    if readme:
        pairs.append((readme, "README.md"))
    for a in args:
        if ":" not in a:
            print(f"BAD_ARG {a}: expected local_path:repo_path")
            return 1
        local, repo = a.rsplit(":", 1)
        pairs.append((local, repo.replace("\\", "/")))

    if not pairs:
        print(__doc__)
        return 1
    if not TOKEN and not dry:
        print("MS_TOKEN missing (env)")
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
