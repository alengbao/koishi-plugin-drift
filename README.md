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
drift.craft [ration|stone-axe]
drift.build [shelter]
drift.inventory
drift.camp
drift.history
drift.suicide
```

When the host loads Koishi's official help plugin, use `help drift`,
`drift -h`, or the localized `帮助 漂流` shortcut to list these commands.

Content IDs such as `wood`, `ration`, and `wild-rat` are stable logical IDs,
not generated snowflake IDs. Built-in content carries an explicit version. A
plugin update replaces a built-in row only when its seed version increases;
otherwise existing content edits are preserved. The `enabled` setting is never
reset by a seed update.

Ordinary actions use explicit subcommands. When an event or confirmation is
pending, reply with its option number directly; no choose command is needed.
Numeric choices expire after five minutes by default, and the timeout can be
changed in the plugin configuration. An expired choice uses its safe default
when the player next sends a message; that message only returns the settlement
and must be sent again if it was also intended as a command.

Forest exploration filters events by conditions, per-character occurrence
limits, and real-time cooldowns before applying weights. It includes trapped
animals, strange fungi, fallen trees, night-only lights, a tree-hole creature,
and the original low-weight combat event. Ordinary collection yields wood or
stone. A stone axe can be crafted from two wood and one stone and unlocks the
high-yield fallen-tree option without being consumed.
