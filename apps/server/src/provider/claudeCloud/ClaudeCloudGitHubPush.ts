/**
 * Pushes a cloud session's commits through GitHub's REST API, as the session's git
 * proxy refuses git push to repositories outside its sources, and it starts with none.
 */
export const GITHUB_PUSH_SCRIPT = String.raw`
"""Pushes local commits to a GitHub branch through the REST API instead of git.

Usage: python3 github_push.py OWNER/NAME BRANCH [--rev REV] [--force] [--expect SHA] [--remote NAME]

Commits the remote-tracking refs already reach are taken as on GitHub; the rest
are recreated there blob by blob, and each tree and commit GitHub returns is
checked against the local one. The token is GITHUB_TOKEN, else GH_TOKEN.
"""

import argparse
import base64
import datetime
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

API = os.environ.get("GITHUB_API_URL", "https://api.github.com")


def git(*args, binary=False):
    out = subprocess.run(["git", *args], check=True, capture_output=True).stdout
    return out if binary else out.decode().strip()


class GitHub:
    def __init__(self, repository, token):
        self.base = f"{API}/repos/{repository}"
        self.token = token
        self.writes = 0

    def request(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        for attempt in range(6):
            request = urllib.request.Request(self.base + path, data=data, method=method)
            request.add_header("Authorization", f"Bearer {self.token}")
            request.add_header("Accept", "application/vnd.github+json")
            request.add_header("X-GitHub-Api-Version", "2022-11-28")
            if data is not None:
                request.add_header("Content-Type", "application/json")
            try:
                with urllib.request.urlopen(request) as response:
                    if method != "GET":
                        self.writes += 1
                    return json.load(response)
            except urllib.error.HTTPError as error:
                text = error.read().decode(errors="replace")
                limited = error.code == 429 or (error.code == 403 and "rate limit" in text.lower())
                if limited and attempt < 5:
                    wait = int(error.headers.get("Retry-After") or 60)
                    print(f"GitHub rate limit; retrying in {wait}s", file=sys.stderr)
                    time.sleep(wait)
                    continue
                error.body = text
                raise

    def ref(self, branch):
        try:
            return self.request("GET", f"/git/ref/heads/{branch}")["object"]["sha"]
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            raise


def person(line):
    # "Name <email> 1700000000 -0400"
    name, rest = line.split(" <", 1)
    email, rest = rest.split("> ", 1)
    seconds, offset = rest.split(" ")
    sign = -1 if offset[0] == "-" else 1
    zone = datetime.timezone(sign * datetime.timedelta(hours=int(offset[1:3]), minutes=int(offset[3:5])))
    date = datetime.datetime.fromtimestamp(int(seconds), zone).isoformat()
    return {"name": name, "email": email, "date": date}


def parse_commit(sha):
    raw = git("cat-file", "commit", sha, binary=True).decode()
    headers, message = raw.split("\n\n", 1)
    fields, signature, current = {}, None, None
    for line in headers.split("\n"):
        if line.startswith(" ") and current == "gpgsig":
            signature += "\n" + line[1:]
            continue
        key, value = line.split(" ", 1)
        current = key
        if key == "gpgsig":
            signature = value
        elif key in ("author", "committer"):
            fields[key] = person(value)
        elif key not in ("tree", "parent"):
            raise SystemExit(f"{sha} has a {key} header, which the GitHub API cannot recreate")
    return fields["author"], fields["committer"], message, signature


def tree_entries(parent, commit, blobs, github):
    raw = git("diff-tree", "-r", "-z", "--no-renames", "--no-commit-id", parent, commit, binary=True)
    parts = raw.decode().split("\0")
    entries = []
    for header, path in zip(parts[0::2], parts[1::2]):
        if not header:
            continue
        old_mode, new_mode, _, new_sha, status = header[1:].split(" ")
        if status == "D":
            kind = "commit" if old_mode == "160000" else "blob"
            entries.append({"path": path, "mode": old_mode, "type": kind, "sha": None})
            continue
        if new_mode == "160000":
            entries.append({"path": path, "mode": new_mode, "type": "commit", "sha": new_sha})
            continue
        if new_sha not in blobs:
            content = base64.b64encode(git("cat-file", "blob", new_sha, binary=True)).decode()
            made = github.request("POST", "/git/blobs", {"content": content, "encoding": "base64"})["sha"]
            if made != new_sha:
                raise SystemExit(f"GitHub stored {path} as blob {made}, not {new_sha}")
            blobs.add(new_sha)
        entries.append({"path": path, "mode": new_mode, "type": "blob", "sha": new_sha})
    return entries


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("repository", help="OWNER/NAME")
    parser.add_argument("branch")
    parser.add_argument("--rev", default="HEAD", help="what to push (default HEAD)")
    parser.add_argument("--force", action="store_true", help="allow a non-fast-forward update")
    parser.add_argument("--expect", help="only update the branch if GitHub has it at this SHA")
    parser.add_argument("--remote", default="origin", help="remote whose tracking ref to update")
    args = parser.parse_args()
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        raise SystemExit("Set GITHUB_TOKEN or GH_TOKEN")
    github = GitHub(args.repository, token)

    current = github.ref(args.branch)
    if args.expect is not None and current != args.expect:
        raise SystemExit(f"{args.branch} is at {current}, not {args.expect}; nothing was pushed")
    target = git("rev-parse", "--verify", f"{args.rev}^{{commit}}")
    pending = git("rev-list", "--reverse", "--topo-order", target, "--not", "--remotes").split()
    pushed, blobs = {}, set()
    for index, commit in enumerate(pending, 1):
        parents = git("rev-parse", f"{commit}^@").split()
        if not parents:
            raise SystemExit(f"{commit} is a root commit; push the first commit of a repository with git")
        tree = git("rev-parse", f"{commit}^{{tree}}")
        entries = tree_entries(parents[0], commit, blobs, github)
        if entries:
            base = git("rev-parse", f"{parents[0]}^{{tree}}")
            made = github.request("POST", "/git/trees", {"base_tree": base, "tree": entries})["sha"]
            if made != tree:
                raise SystemExit(f"GitHub built tree {made} for {commit}, not {tree}; nothing was pushed")
        author, committer, message, signature = parse_commit(commit)
        body = {
            "message": message,
            "tree": tree,
            "parents": [pushed.get(parent, parent) for parent in parents],
            "author": author,
            "committer": committer,
        }
        if signature is not None:
            body["signature"] = signature
        made = github.request("POST", "/git/commits", body)["sha"]
        if made != commit:
            print(f"warning: {commit[:12]} was recreated as {made[:12]}", file=sys.stderr)
        pushed[commit] = made
        print(f"[{index}/{len(pending)}] {made[:12]} {message.splitlines()[0] if message else ''}")
    head = pushed.get(target, target)

    if current is None:
        github.request("POST", "/git/refs", {"ref": f"refs/heads/{args.branch}", "sha": head})
    elif current != head:
        try:
            github.request("PATCH", f"/git/refs/heads/{args.branch}", {"sha": head, "force": args.force})
        except urllib.error.HTTPError as error:
            if error.code == 422 and not args.force:
                raise SystemExit(f"{args.branch} has commits {head[:12]} lacks; fetch and rebase, or pass --force")
            raise
    subprocess.run(["git", "update-ref", f"refs/remotes/{args.remote}/{args.branch}", head], check=False)
    print(f"{args.repository} {args.branch}: {(current or 'new')[:12]} -> {head[:12]}")
    if head != target:
        print(f"Local {target[:12]} differs from the pushed {head[:12]}; run: git reset --hard {head}")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as error:
        raise SystemExit(f"GitHub {error.code} on {error.url}: {getattr(error, 'body', '')}")
`.trimStart();
