// The script under test is Python run as a subprocess against a raw HTTP stand-in for GitHub.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { assert, describe, it } from "@effect/vitest";

import { GITHUB_PUSH_SCRIPT } from "./ClaudeCloudGitHubPush.ts";

const run = (cwd: string, command: string, args: ReadonlyArray<string>, input?: string) =>
  NodeChildProcess.execFileSync(command, args, { cwd, input, encoding: "utf8" }).trim();

const readBody = async (request: NodeHttp.IncomingMessage) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text === "" ? undefined : JSON.parse(text);
};

/**
 * The GitHub REST endpoints the script calls, over a bare repository: blobs,
 * trees and commits are written as git objects, so a mismatched one has a
 * different SHA, just as on GitHub.
 */
const fakeGitHub = async (bare: string, workTree: string) => {
  const git = (args: ReadonlyArray<string>, options: { input?: string; env?: object } = {}) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: bare,
      input: options.input,
      env: { ...process.env, ...options.env },
      encoding: "utf8",
    }).trim();
  let indexes = 0;
  const handle = async (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const body = await readBody(request);
    const path = request.url!.replace(/^\/repos\/acme\/app/, "");
    const ref = /^\/git\/refs?\/heads\/(.+)$/.exec(path)?.[1];
    const current = (branch: string) => {
      try {
        return git(["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
      } catch {
        return null;
      }
    };
    if (request.method === "GET" && ref !== undefined) {
      const sha = current(ref);
      return sha === null ? reply(404, {}) : reply(200, { object: { sha } });
    }
    if (request.method === "POST" && path === "/git/blobs") {
      const content = Buffer.from(body.content, "base64");
      const sha = NodeChildProcess.execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: bare,
        input: content,
      })
        .toString()
        .trim();
      return reply(201, { sha });
    }
    if (request.method === "POST" && path === "/git/trees") {
      const index = NodePath.join(bare, `index-${++indexes}`);
      // update-index wants a work tree, though it never reads one here.
      const env = { GIT_INDEX_FILE: index, GIT_WORK_TREE: workTree };
      git(["read-tree", body.base_tree], { env });
      for (const entry of body.tree) {
        git(
          entry.sha === null
            ? ["update-index", "--force-remove", entry.path]
            : ["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.sha},${entry.path}`],
          { env },
        );
      }
      const sha = git(["write-tree"], { env });
      NodeFS.rmSync(index, { force: true });
      return reply(201, { sha });
    }
    if (request.method === "POST" && path === "/git/commits") {
      const sha = git(
        ["commit-tree", body.tree, ...body.parents.flatMap((p: string) => ["-p", p]), "-F", "-"],
        {
          input: body.message,
          env: {
            GIT_AUTHOR_NAME: body.author.name,
            GIT_AUTHOR_EMAIL: body.author.email,
            GIT_AUTHOR_DATE: body.author.date,
            GIT_COMMITTER_NAME: body.committer.name,
            GIT_COMMITTER_EMAIL: body.committer.email,
            GIT_COMMITTER_DATE: body.committer.date,
          },
        },
      );
      return reply(201, { sha });
    }
    if (request.method === "POST" && path === "/git/refs") {
      git(["update-ref", body.ref, body.sha]);
      return reply(201, {});
    }
    if (request.method === "PATCH" && ref !== undefined) {
      const was = current(ref)!;
      try {
        if (!body.force) git(["merge-base", "--is-ancestor", was, body.sha]);
      } catch {
        return reply(422, { message: "Update is not a fast forward" });
      }
      git(["update-ref", `refs/heads/${ref}`, body.sha]);
      return reply(200, {});
    }
    return reply(404, {});
  };
  const server = NodeHttp.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as NodeNet.AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
};

const setup = async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-github-push-"));
  const bare = NodePath.join(root, "remote.git");
  const clone = NodePath.join(root, "clone");
  run(root, "git", ["init", "-q", "--bare", "-b", "main", bare]);
  run(root, "git", ["clone", "-q", bare, clone]);
  for (const [key, value] of [
    ["user.name", "Ada"],
    ["user.email", "ada@example.com"],
    ["commit.gpgsign", "false"],
  ]) {
    run(clone, "git", ["config", key!, value!]);
  }
  NodeFS.writeFileSync(NodePath.join(clone, "README.md"), "hello\n");
  NodeFS.writeFileSync(NodePath.join(clone, "LICENSE"), "MIT\n");
  run(clone, "git", ["add", "-A"]);
  run(clone, "git", ["commit", "-qm", "initial"]);
  run(clone, "git", ["push", "-q", "origin", "main"]);
  const script = NodePath.join(root, "github_push.py");
  NodeFS.writeFileSync(script, GITHUB_PUSH_SCRIPT);
  NodeFS.mkdirSync(NodePath.join(root, "work-tree"));
  const github = await fakeGitHub(bare, NodePath.join(root, "work-tree"));
  const push = async (...args: ReadonlyArray<string>) => {
    try {
      const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
        "python3",
        [script, "acme/app", ...args],
        {
          cwd: clone,
          env: { ...process.env, GITHUB_TOKEN: "test", GITHUB_API_URL: github.url },
        },
      );
      return { ok: true, output: stdout };
    } catch (error) {
      return { ok: false, output: String((error as { stderr?: string }).stderr) };
    }
  };
  const remoteSha = (branch: string) => run(bare, "git", ["rev-parse", `refs/heads/${branch}`]);
  return {
    clone,
    push,
    remoteSha,
    [Symbol.dispose]: () => {
      github.close();
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
};

describe("GITHUB_PUSH_SCRIPT", () => {
  it("pushes a stack of commits with their own SHAs", async () => {
    using repo = await setup();
    const { clone } = repo;
    NodeFS.writeFileSync(NodePath.join(clone, "README.md"), "hello, world\n");
    NodeFS.mkdirSync(NodePath.join(clone, "bin/nested"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(clone, "bin/nested/run.sh"), "#!/bin/sh\necho hi\n");
    NodeFS.chmodSync(NodePath.join(clone, "bin/nested/run.sh"), 0o755);
    run(clone, "git", ["rm", "-q", "LICENSE"]);
    run(clone, "git", ["add", "-A"]);
    run(clone, "git", ["commit", "-q", "-m", "first\n\nwith a body"]);
    NodeFS.writeFileSync(NodePath.join(clone, "bin/notes.txt"), "second\n");
    run(clone, "git", ["add", "-A"]);
    run(clone, "git", ["commit", "-q", "--date=2020-02-03T04:05:06+05:30", "-m", "second"]);

    const pushed = await repo.push("feature");
    assert.isTrue(pushed.ok, pushed.output);
    const head = run(clone, "git", ["rev-parse", "HEAD"]);
    assert.equal(repo.remoteSha("feature"), head);
    assert.equal(run(clone, "git", ["rev-parse", "origin/feature"]), head);
  });

  it("updates an existing branch only by fast-forward, --force, and a matching --expect", async () => {
    using repo = await setup();
    const { clone } = repo;
    const commit = (message: string, amend = false) => {
      NodeFS.writeFileSync(NodePath.join(clone, "README.md"), `${message}\n`);
      run(clone, "git", ["commit", "-q", "-a", ...(amend ? ["--amend"] : []), "-m", message]);
      return run(clone, "git", ["rev-parse", "HEAD"]);
    };
    commit("one");
    assert.isTrue((await repo.push("feature")).ok);
    const two = commit("two");
    assert.isTrue((await repo.push("feature")).ok);
    assert.equal(repo.remoteSha("feature"), two);

    const rewritten = commit("two, rewritten", true);
    const refused = await repo.push("feature");
    assert.isFalse(refused.ok);
    assert.include(refused.output, "pass --force");
    const stale = await repo.push("feature", "--force", "--expect", rewritten);
    assert.isFalse(stale.ok);
    assert.include(stale.output, "nothing was pushed");
    assert.equal(repo.remoteSha("feature"), two);

    assert.isTrue((await repo.push("feature", "--force", "--expect", two)).ok);
    assert.equal(repo.remoteSha("feature"), rewritten);
  });
});
