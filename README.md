# orca-omp-agent-panel

Live todo list and subagent status of the omp session running in the focused Orca worktree, shown as a tab in Orca's right sidebar. Works with stock Orca and stock omp; no upstream changes.

```
omp extension ──state files──▶ same extension renders ──▶ orca-plugin/panel.html ──▶ Orca reloads the
(every omp     ~/.local/state/   all live sessions into     (generated, gitignored)    dev plugin panel
 process)      orca-omp-agent-panel/sessions/<id>.json                                  on file change
```

- `omp-extension/`: an omp extension. It writes one state file per main session (todo phases, subagents, run status, `ORCA_TERMINAL_HANDLE`), then renders every live session from all state files into `orca-plugin/panel.html` using `orca-plugin/panel.template.html`. At most one render per second, and only when the bytes change.
- `orca-plugin/`: a panel-only Orca plugin (no worker, capability `workspace:read`). The panel shows sessions whose terminal handle is one of the focused worktree's terminals (`workspace.readContext().terminals[].id`): todos of every such session on top, then one merged subagent list (running first).

## Why it works this way

Stock Orca gives sandboxed plugin panels no data channel: no network (`connect-src 'none'`), and panels can only call `workspace.readContext`, `terminal.sendText` and `notifications.show`. Orca does, however, reload a **development** plugin's panel whenever a file in its folder changes. Rewriting `panel.html` with the data embedded is the live path that needs no Orca changes.

Consequences:
- The plugin must be loaded as a development plugin. Installed plugins are hash-verified, so their files cannot change.
- Every update reloads the panel document: about 1–2.5 s latency and a brief re-render. This relies on undocumented dev-mode behaviour that a future Orca update could change.
- Each terminal shows one session: the live one, else the most recently written. A restart or `/clear` in the same terminal therefore replaces the old session at once. A terminal whose omp exited keeps its ended session visible for 10 minutes. State files of sessions that ended more than 24 h ago are deleted on the next render.
- A finished todo list disappears together with omp's own todo widget: `tasks.todoClearDelay` seconds (default 60) after the last task is completed or abandoned.

## Install

1. omp: `ln -s "$PWD/omp-extension/orca-omp-agent-panel.ts" ~/.omp/agent/extensions/omp-agent-panel.ts`. Do not use an `orca-*` name; Orca manages those files.
2. Orca: Settings → Plugins → turn on **Plugin system**. Under Development, set **Development plugin folder path** to the absolute path of `orca-plugin/`. Click **Review & enable**.
3. Start `omp` in an Orca terminal. The first session renders `panel.html`; until then the panel reports that it could not be loaded.
4. Open the bot icon in the right sidebar.

`ORCA_OMP_PANEL_STATE_DIR` and `ORCA_OMP_PANEL_PLUGIN_DIR` override the state directory and the plugin folder (default: `../orca-plugin` next to the real extension file).

## Tests

`bun install && bun test` (about 15 s; real timers, so debounce/throttle/poll paths run for real).

- `test/extension.test.ts`: drives the extension through a fake omp `ExtensionAPI` and checks the state files and the rendered `panel.html` in temp directories (never touches `orca-plugin/` or the real state dir).
- `test/panel.test.ts`: loads `panel.template.html` in happy-dom with a fake Orca parent answering `workspace.readContext`.
