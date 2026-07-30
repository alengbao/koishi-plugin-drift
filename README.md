# Drift

Drift is a small persistent survival game implemented as a standalone Koishi
plugin. English commands use the `drift` namespace and Chinese aliases use
`漂流`.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

The reusable host in `../koishi-dev` loads the compiled package through a
local `file:` dependency. Build this package before starting that host.

## Commands

```text
drift
drift.create [name]
drift.status
drift.actions
drift.collect
drift.explore
drift.craft [ration]
drift.build [shelter]
drift.inventory
drift.camp
drift.history
drift.suicide
```

When the host loads Koishi's official help plugin, use `help drift`,
`drift -h`, or the localized `帮助 漂流` shortcut to list these commands.

Ordinary actions use explicit subcommands. When an event or confirmation is
pending, reply with its option number directly; no choose command is needed.
Numeric choices expire after five minutes by default, and the timeout can be
changed in the plugin configuration.
