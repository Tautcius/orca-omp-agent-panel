# orca-omp-agent-panel omp extension

Writes one JSON state file (schema v1) per main omp session with its todo list,
its subagents, and run status, then renders all live sessions into the Orca
plugin's `panel.html`.

- Directory: `$ORCA_OMP_PANEL_STATE_DIR`, or `~/.local/state/orca-omp-agent-panel/sessions` if that is unset
- File: `<sessionId>.json`, written atomically (`<file>.<pid>.tmp` then rename), debounced 150 ms
- Worktree link: `ORCA_TERMINAL_HANDLE` (matched by the panel against the focused worktree's terminals); `ORCA_WORKTREE_ID` and `ORCA_PANE_KEY` are recorded too
- Panel: `$ORCA_OMP_PANEL_PLUGIN_DIR/panel.html` (default `../orca-plugin` next to the real extension file), rendered from `panel.template.html` at most once per second, only when the bytes change. Sessions started outside an Orca terminal are not rendered.
- Subagents: id, agent, generated description, status, start/end time, model, the spawn assignment (first 600 chars, shown as the name's tooltip), the current activity while running (latest intent, else the in-flight tool), tool/request/token counts, cost, context fill, omp's completion estimate when the probe has reported one, and the 3 most recent tool calls. Every panel update replaces Orca's panel iframe (a brief blank), so progress-only changes are written at most every 5 s; status, todo and new-subagent changes still go out within ~150 ms and carry the pending progress along. The panel data omits `updatedAt`, so writes that change nothing visible do not reload the panel.

## Install

Enable it for every omp session by symlinking the file into the user
extensions directory:

```sh
mkdir -p ~/.omp/agent/extensions
ln -s "$PWD/omp-extension/orca-omp-agent-panel.ts" ~/.omp/agent/extensions/omp-agent-panel.ts
```

You can also add the absolute path to the `extensions:` list in
`~/.omp/agent/config.yml`. Settings layers replace that array instead of
merging it, so copy any entries you already have. For a single run, pass
`omp --extension /abs/path/orca-omp-agent-panel.ts`.

Don't use the `orca-*.ts` names in `~/.omp/agent/extensions`. Orca manages those files.

## Limitations

- omp has no extension event for `/todo` edits made in the UI. The extension
  watches the session leaf once per second and re-reads the branch when the leaf
  changes, so these edits show up within about 1 s.
- A finished todo list leaves the panel when omp hides it from its own todo HUD:
  `tasks.todoClearDelay` seconds (default 60; `-1` = never) after every task is
  completed or abandoned, omp appends a `todo_hud_state` entry with
  `visibility: 'dismissed'` for that snapshot, and the extension then publishes
  no todos. A later `revealed` entry or a new todo snapshot shows a list again.
- A subagent's `description` is the label that omp generates in the background.
  It stays `null` until that label arrives, and a subagent that finishes quickly
  may never get one.
- `idle` is written only after a terminal `agent_end`. A short-lived
  `omp -p` run can go straight from `working` to `ended`.
- When the session ends, any subagent still `running` is written as `aborted`.
