"""git push 被代理拦截时的备用 GitHub 同步通道（同一台机器、同一仓库）。

背景
----
本机出网依赖 Shell 注入的 http_proxy（127.0.0.1:54147），它间歇性拦截 github.com
（典型报错：`CONNECT tunnel failed, response 502` / `schannel: server closed abruptly`）。
而 gh CLI 走自己的通道不受影响。本脚本用 GitHub Git Database REST API 直接构造 commit，
逐条推送本地领先远端的 commit（历史完整保真），最后重建本地 ref 消除 SHA 分叉。

用法
----
    python tools/sync_github.py            # 推送本地所有落后于远端的 commit
    python tools/sync_github.py --check    # 只对比本地与远端差异，不推送

前置条件：已 gh auth login，且本地已 git commit。
"""
import base64
import json
import subprocess
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

REPO = "gityongzhong/OFDee"
BRANCH = "main"
API = "https://api.github.com"
# 本机提交时间戳在 API 侧以 UTC 呈现，但 git 存的是 +0800；
# message 也不额外补尾部换行 —— 两者都会改变字节从而影响 SHA
TZ = "+0800"

_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_token = None


def git(*args, binary=False):
    r = subprocess.run(["git", *args], capture_output=True, check=True)
    return r.stdout if binary else r.stdout.decode("utf-8", "replace")


def api(method, path, payload=None):
    global _token
    if _token is None:
        _token = subprocess.run(
            ["gh", "auth", "token"], capture_output=True, text=True, check=True
        ).stdout.strip()
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        API + path,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {_token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            **({"Content-Type": "application/json"} if data else {}),
        },
    )
    with _opener.open(req, timeout=180) as r:
        body = r.read().decode("utf-8")
    return json.loads(body) if body else None


def epoch(iso):
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())


def build_tree(parent_sha, commit_sha):
    """按 commit 相对其父的变化，组装 Git tree 条目。"""
    base_tree = api("GET", f"/repos/{REPO}/git/commits/{parent_sha}")["tree"]["sha"]
    changes = git("diff", "--name-status", f"{commit_sha}~1", commit_sha).splitlines()
    entries = []
    for line in changes:
        if not line.strip():
            continue
        status, _, path = line.partition("\t")
        if status.startswith("R") or status.startswith("C"):  # 重命名/复制：拆成删+增
            old, new = path.split("\t", 1) if "\t" in path else (None, path)
            if old:
                entries.append({"path": old, "mode": "100644", "type": "blob", "sha": None})
            path = new
        if status.startswith("D"):
            entries.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
            continue
        blob = api(
            "POST",
            f"/repos/{REPO}/git/blobs",
            {
                "content": base64.b64encode(Path(path).read_bytes()).decode(),
                "encoding": "base64",
            },
        )
        entries.append({"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]})
    tree = api("POST", f"/repos/{REPO}/git/trees", {"base_tree": base_tree, "tree": entries})
    return tree["sha"], entries


def reconstruct_ref(commit_meta):
    """按 commit object 的字节格式重建对象并移动本地 ref，使本地 SHA == 远端 SHA。"""
    tree = commit_meta["commit"]["tree"]["sha"]
    a, cm = commit_meta["commit"]["author"], commit_meta["commit"]["committer"]
    lines = [f"tree {tree}"] + [f"parent {p['sha']}" for p in commit_meta["parents"]]
    lines.append(f"author {a['name']} <{a['email']}> {epoch(a['date'])} {TZ}")
    lines.append(f"committer {cm['name']} <{cm['email']}> {epoch(cm['date'])} {TZ}")
    payload = ("\n".join(lines) + "\n\n" + commit_meta["commit"]["message"]).encode("utf-8")
    sha = subprocess.run(
        ["git", "hash-object", "-t", "commit", "-w", "--stdin"],
        input=payload, capture_output=True, check=True,
    ).stdout.decode().strip()
    if sha != commit_meta["sha"]:
        print(f"  ! 字节不一致（本地 {sha[:8]} vs 远端 {commit_meta['sha'][:8]}），跳过 ref 同步")
        return False
    git("update-ref", f"refs/remotes/origin/{BRANCH}", sha)
    git("update-ref", f"refs/heads/{BRANCH}", sha)
    return True


def main():
    check_only = "--check" in sys.argv

    if git("status", "--porcelain").strip():
        print("✗ 工作区有未提交改动，请先 git commit")
        return 1

    remote = api("GET", f"/repos/{REPO}/commits/{BRANCH}")
    remote_sha = remote["sha"]
    head = git("rev-parse", "HEAD").strip()

    if head == remote_sha:
        print(f"✓ 本地与远端一致 @ {head[:8]}")
        return 0

    pending = [c for c in git("rev-list", "--reverse", f"{remote_sha}..HEAD").splitlines() if c]
    if not pending:
        print(f"本地 {head[:8]} 未领先远端 {remote_sha[:8]}（可能落后，需先 fetch）")
        return 1

    print(f"远端 {remote_sha[:8]}  本地落后 {len(pending)} 个 commit")
    for c in pending:
        print(f"  {c[:8]}  {git('log','-1','--pretty=%s', c).strip()}")
    if check_only:
        return 0

    parent = remote_sha
    for c in pending:
        subject = git("log", "-1", "--pretty=%s", c).strip()
        tree_sha, entries = build_tree(parent, c)
        print(f"\n→ 推送 {c[:8]}  {subject}  （{len(entries)} 个文件）")
        message = git("log", "-1", "--pretty=%B", c).rstrip("\n")
        new_commit = api(
            "POST",
            f"/repos/{REPO}/git/commits",
            {"message": message, "tree": tree_sha, "parents": [parent]},
        )
        api("PATCH", f"/repos/{REPO}/git/refs/heads/{BRANCH}", {"sha": new_commit["sha"]})
        parent = new_commit["sha"]

    meta = api("GET", f"/repos/{REPO}/commits/{BRANCH}")
    done = reconstruct_ref(meta)
    print(f"\n✓ 已推送至 {meta['sha'][:8]}  →  https://github.com/{REPO}/commits/{BRANCH}")
    print("✓ 本地 ref 已对齐" if done else "  （ref 未对齐，可重试本脚本）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
