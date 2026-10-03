# orca-omp-agent-panel

Live todo list and subagent status of the omp session running in the focused Orca worktree, shown as a tab in Orca's right sidebar.

```
omp extension ──JSON state files──▶ Orca plugin worker ──orca.panels.publish──▶ sidebar panel
(omp-extension/)  ~/.local/state/       (orca-plugin/main.mjs)                    (orca-plugin/panel.html)
                  orca-omp-agent-panel/
                  sessions/<id>.json
```

- `omp-extension/`: an omp extension that writes one state file per main session (todo phases, subagents, run status, `ORCA_WORKTREE_ID`). See its README for the schema and install steps.
- `orca-plugin/`: an Orca plugin. The worker watches the state directory and publishes every live session. The panel matches sessions to the focused worktree using `workspace.readContext().worktreeId` and renders **Todos** and **Subagents** tabs.

## Requirements

The plugin needs two Orca plugin API additions that are not in a released Orca yet: `orca.panels.publish` (worker → panel push) and `worktreeId` in `workspace.readContext`. Both are on branch `feat/plugin-panel-publish` of the Orca fork. On an Orca build without them, the worker logs that `orca.panels.publish` is missing and the panel stays on "Loading…".

## Install

1. omp: `ln -s "$PWD/omp-extension/orca-omp-agent-panel.ts" ~/.omp/agent/extensions/omp-agent-panel.ts`
2. Orca: Settings → Plugins → turn on **Plugin system**, then Development → **Development plugin folder path** = absolute path of `orca-plugin/`. Click **Review & enable**.
3. Open the bot icon in the right sidebar and start `omp` in an Orca terminal of that worktree.
