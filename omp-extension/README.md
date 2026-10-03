# orca-omp-agent-panel omp extension

Writes one JSON state file (schema v1) per main omp session with its todo list,
its subagents, and run status, for the Orca agent panel to read.

- Directory: `$ORCA_OMP_PANEL_STATE_DIR`, or `~/.local/state/orca-omp-agent-panel/sessions` if that is unset
- File: `<sessionId>.json`, written atomically (`<file>.<pid>.tmp` then rename), debounced 150 ms
- Worktree link: `ORCA_WORKTREE_ID` and `ORCA_PANE_KEY` from the omp process environment

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
- A subagent's `description` is the label that omp generates in the background.
  It stays `null` until that label arrives, and a subagent that finishes quickly
  may never get one.
- `idle` is written only after a terminal `agent_end`. A short-lived
  `omp -p` run can go straight from `working` to `ended`.
- When the session ends, any subagent still `running` is written as `aborted`.
