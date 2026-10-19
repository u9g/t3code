# Claude Cloud

Claude Cloud runs a thread as a Claude Code cloud session, the same kind of
session listed at [claude.ai/code](https://claude.ai/code). Claude works in
Anthropic's cloud on a copy of your project's GitHub repository, and its replies,
tool calls, plans, and questions appear in the thread as they do for
[Claude](./providers-claude.md).

You can also message the session from claude.ai. A message sent there while the
thread is idle starts a turn in the thread, which opens with a **Message sent from
claude.ai** notice holding your message. A message sent while a turn is running
does not appear in the thread itself, but Claude's work on it does.

## Requirements

- A Claude subscription that includes Claude Code on the web, signed in with
  `claude auth login` on the machine that runs the T3 server. Claude Cloud uses
  that login; it does not keep a copy of its own.
- The project's repository on GitHub, with your branch pushed.
- The Claude GitHub app installed with access to the repository. claude.ai/code
  asks you to install it the first time you use a repository there.

Connecting devices, including phones, need nothing installed.

## Set up Claude Cloud

Claude Cloud is disabled by default. Open **Settings → Providers**, select the
environment, add a provider instance, and choose **Claude Cloud**. Then select one
of its models in a thread's model picker. Each new thread starts its own cloud
session, and the thread links to that session on claude.ai.

The instance settings are:

- **Cloud environment**: the cloud environment id (`env_…`) that sessions run in.
  Leave it empty to use the default environment from your Claude settings, or
  else your first Anthropic cloud environment.
- **CLAUDE_CONFIG_DIR path**: the Claude config directory whose login to use, as
  for [separate Claude accounts](./providers-claude.md#separate-accounts-or-configurations).
- **Binary path**: the `claude` CLI, used only to refresh an expired login.

The provider card shows the subscription of the login it found. Logins expire
after a while; when that happens, the next message asks the claude CLI on the
host to refresh it. If the refresh fails, run `claude auth login` there again.

## Repository and branch

A session starts from the GitHub remote of the project's current branch, or from
`origin`. If the branch is pushed, the session starts from it. Otherwise it
starts from the repository's default branch, and so does a branch GitHub no
longer has, such as one deleted after its pull request merged. Commits you have
not pushed and uncommitted changes stay on your machine, and the thread says so
when the session starts.

If the cloud session cannot start, for example because GitHub cannot provide its
branch, the turn fails and says why. Start a new thread to try again.

Claude makes its changes on a new `claude/…` branch in the cloud, not in your
checkout. Fetch that branch from GitHub once Claude has pushed it.

## Differences from Claude

- Local diffs and checkpoints do not include Claude's edits, since those happen
  in the cloud.
- Conversations cannot be rewound. A fork starts a new cloud session that
  receives the conversation up to the forked message as
  [portable context](./portable-handoffs.md), not a copy of the session. The new
  session starts from your project's branch, not from the original session's
  `claude/…` branch, and cannot use T3 Code's thread-reading tool to fetch
  history the handoff left out.
- Only **Full access** is offered: the cloud session runs commands and edits in
  its own sandbox without asking. Requests the cloud would otherwise raise, such
  as publishing an artifact, an MCP tool that requires approval, or an action
  matched by an `ask` permission rule in the repository's Claude settings, are
  approved too. Plan mode works, and Claude still asks its questions in the
  thread.
- Images are sent as images. Text files are included in the message, up to
  256 KB of text per message; other files are not sent.
- Files Claude creates stay in the cloud session. A file Claude sends you
  appears in the thread, downloaded to the environment's machine, with images
  and videos shown inline. Ask Claude to send you a file to see it. Downloads
  are kept in `~/.t3/userdata/claude-cloud-files/` on that machine until you
  delete the thread and every fork of it.
- T3 Code's own tools are not available to cloud sessions.
- Claude Cloud does not write thread titles, commit messages, or pull request
  text. T3 Code uses another provider for those.
- Archiving a thread leaves its cloud session in place. Archive the session from
  claude.ai/code when you no longer need it.

Cloud sessions count against your Claude subscription's usage limits.
