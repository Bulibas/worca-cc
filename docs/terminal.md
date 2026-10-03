# Terminal

A terminal pane on the right side of every Worca page. The shell runs on the Worca server, in the
folder of what you are looking at, and every command you run is recorded with its output, exit code,
duration, who ran it and when.

> **What this means:** the shell runs as the user Worca runs as, in folders whose code agents wrote.
> On a hosted Worca it is off unless an administrator sets `WORCA_TERMINAL_REMOTE=1`.

## Where it opens

| Page | Folder |
| --- | --- |
| A running run | its live worktree. The pane warns that the pipeline is still changing those files. |
| A finished run | its checkout (see [Actions](actions.md)). With none yet, the pane offers **Check out**. |
| A workspace run | one terminal per member; pick the member first. |
| A project page | a Worca-owned worktree of the branch you pick (below). |
| Any other page | no new folder: pick an open terminal from the list. |

Opening the pane never starts a shell by itself. **Open terminal** does, and reattaches when one is
already running for that run.

### Branch folders

A project page's terminal opens in `~/.worca-cc/terminal/worktrees/<project>/…`, a worktree of the
branch. If that branch is checked out somewhere else (often your own checkout), the folder is a
**detached** copy of its latest commit, and commits made there are not on the branch. Worca never
deletes the branch. These folders follow **Keep checkouts** (Settings › Runs › Actions): with
`never` a clean folder goes when its last terminal closes; otherwise it stays until you click
**Remove folder**. **Max checkouts** caps how many stay. A folder with uncommitted changes is only
removed after you confirm discarding them, and the same holds for a detached copy that holds
commits no branch, remote or tag reaches: Worca never removes it automatically, and **Remove
folder** asks you to confirm losing them.

## Sessions

Each terminal has an id, a folder, a status (`running`, `exited`, `closed`, `interrupted`), an exit
code and its output. It survives a page reload: the pane replays the last 512 KB. It ends when the
shell exits, when you click **Close terminal**, or when Worca stops. A terminal left running by a
Worca that crashed is stopped on the next start and shows as `interrupted`. At most 16 run at once.

When a run finishes, its worktree is removed (and re-created if a keep policy keeps it). A terminal
open there says so: open a new one, or `cd "$PWD"`. Before it is removed, Worca commits what is in
the worktree onto the run's branch, so changes you make in a running run's terminal become part of
the run's commit. To keep your own changes apart, wait for the run to finish and use its checkout.

## Commands are blocks

In bash and zsh, Worca loads your own `~/.bashrc` / `.zshrc` and adds a few lines that mark where each
command starts and ends. The **Commands** tab lists them: the command, exit code, duration, who ran it
and when; **Output** shows what it printed (the last 256 KB), **Run again**, **Copy**, and **Copy link**
(`/?terminal=<id>&block=<n>`). Other shells (sh, fish, cmd.exe, PowerShell) work, but their commands are
not recorded as blocks. A command typed with a leading space is still recorded: the record is the audit.
When bash leaves a line out of its history (`HISTCONTROL=ignorespace`, `ignoredups` or `ignoreboth`,
which Ubuntu's default `.bashrc` sets), the block shows only the line's first command: a repeated
`cd x && make` is recorded as `cd x`.

The marks carry a secret that is new for each terminal and hidden from the programs you run, so output
that merely contains a mark (a `cat` of a file, another tool's shell integration) never creates a
command or an audit entry. Code that runs inside the shell itself (a file you `source`, a direnv hook)
can read that secret; programs the shell starts cannot. If your `.bashrc` installs its own `DEBUG` trap
after Worca's lines, or your zsh setup clears `precmd_functions`, commands are not recorded. Commands
typed in a shell you start inside the terminal (`bash`, `ssh`, `docker exec`) are part of that one
command's block, not blocks of their own.

Keys you type in the terminal are the shell's: Escape and Ctrl+K never act on the Worca page around it.
Ctrl+\` shows and hides the pane from anywhere.

If a command prints faster than the page can draw it (`yes`, a large `cat`), Worca skips ahead: the
pane jumps to the latest output instead of queueing everything. The block still keeps its last 256 KB.

## Environment

| Variable | Value |
| --- | --- |
| `WORCA_RUN_ID`, `WORCA_BRANCH`, `WORCA_PROJECT_KEY`, `WORCA_MEMBER` | the run's facts |
| `WORCA_WORKTREE` | the folder |
| `WORCA_TERMINAL_SESSION` | this terminal's id |
| `WORCA_PORT_<ACTION>_<NAME>`, `WORCA_URL_<ACTION>` | each running action's ports and URL (`WORCA_PORT_<MEMBER>_<ACTION>_<NAME>` on a workspace run) |

They are read when the terminal opens: start the action first, then open a terminal. GitHub tokens and
Worca's own `WORCA_HOME` are not passed on, as for Actions. Neither is `PORT`, which is Worca's own
port: an app you start here picks its default port, or the one you give it. Because `WORCA_HOME` is not
passed on, a `worca` command typed here uses the default home (`~/.worca-cc`); on a Worca that runs with
another home (the Docker image uses `/worca`), run `export WORCA_HOME=/worca` first.

## Stop

**Stop** sends Ctrl+C to the running command. If it is still running 3 seconds later, Worca kills every
process the terminal started, including jobs you put in the background with `&`. Without node-pty (see
below) there is no foreground job to aim at, so the first Ctrl+C also reaches those background jobs. It
is recorded with who stopped it. In a shell without blocks (sh, fish, cmd.exe), Worca cannot tell when a
command ends, so Stop sends Ctrl+C only and never escalates: use **Close terminal** for a command that
ignores it. Stop and Close always work, even when the terminal is turned off.
Discarding a run's checkout closes the terminals open in it, as it stops the run's Actions.

## Audit log

Every open, command, stop and close is recorded with the person (the same attribution as runs) and the
time. Blocks and audit rows are kept. `GET /api/terminal/audit?runId=<id>` lists a run's.

## Security

- The browser never chooses the folder, the shell or the environment: Worca picks them from the run or branch.
- **Hosted mode:** off unless the server starts with `WORCA_TERMINAL_REMOTE=1`. With it on, anyone signed
  in can run commands as the server user: that is the point, but know it before you turn it on.
- With agent isolation on, callers inside the box (which could be an agent) can never use the terminal.
  The same gap as for Actions remains: in **local** mode there is no identity, so a request an agent loops
  back through a published port cannot be told apart from a person. Run an isolated box in remote mode.
- The shell runs as the Worca server's user, not as the agent user, exactly like an Action. Code you run
  here (the run's tests, `npm install` of a branch agents wrote) has the server's access.
- Only pages served by this Worca can use it. A page on another port of the same machine (another dev
  server, or a service an Action started) is refused with `403 TERMINAL_CROSS_ORIGIN` and sees no terminal
  traffic.

## Without node-pty

The terminal uses `node-pty`, an optional native module: prebuilt on macOS and Windows, compiled on
Linux (it needs python3, make and a C++ compiler; the `-full` Docker image has them). Without it,
terminals run over plain pipes: commands, blocks and Stop work, but full-screen programs (vim, top,
less) and arrow-key history do not, and the pane says so. `WORCA_TERMINAL_PTY=0` forces this mode.
node-pty 1.1.0's macOS package ships its `spawn-helper` without the execute bit; Worca sets it the
first time a terminal opens. If it cannot (a read-only install), or node-pty still fails to start a
shell, terminals use pipes and the banner gives the reason.

## Windows

The shell is `cmd.exe` (`ComSpec`): a working terminal without blocks. Stop sends Ctrl+C only.

## Troubleshooting

| You see | Why, and what to do |
| --- | --- |
| "Full-screen programs … do not work here" | node-pty is not installed. Install build tools and reinstall, or use the `-full` image. |
| No Commands tab entries | The shell is not bash or zsh, or your rc file replaced `PROMPT_COMMAND` / `precmd_functions` after Worca's lines ran. |
| "The terminal is turned off on this hosted deployment" | Set `WORCA_TERMINAL_REMOTE=1` on the server. |
| "This folder was removed when the run finished" | Open a new terminal on the run (Check out first if needed). |
| 409 "At most 16 terminals" | Close one. |
| 403 `TERMINAL_CROSS_ORIGIN` | The page's address differs from the `Host` the server received, for example a proxy that rewrites `Host`. Forward `Host` unchanged. |
| `bash: !": event not found` | Bash history expansion, as in any bash: quote `!` with single quotes. |
