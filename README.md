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

## Content

Built-in content is stored as one definition per JSON file under `content/`.
Directories such as `events/forest/` and `items/tools/` are only for organizing
files; a definition is identified by its stable `(type, contentId)` pair.
Every definition has an explicit integer `version` and is validated against
`content/drift-content.schema.json` plus the cross-content reference rules.

`npm run build` validates all built-in JSON and combines it into
`lib/content.bundle.json`. Published installations read this bundle at startup,
so normal game operations never scan the source tree. Startup inserts missing
definitions and replaces an existing built-in definition only when the bundled
version is higher. It always preserves `enabled` and never changes player data.

The configurable external directory defaults to the Koishi host's
`data/drift/content`. It is persistent and may point to a separate Git
repository. External definitions may override a built-in `(type, contentId)`
only with a higher version. Removing a JSON file does not remove or disable its
published database row.

With `testMode` enabled, sandbox users and users with Koishi authority 4 or
higher can use the short developer commands:

```text
drift dev
drift dev reset
drift dev give <item> [quantity]
drift dev hp <value>
drift dev ap <value>
drift dev clear [eventId]
drift dev event <eventId> [variantId]
drift dev check
drift dev load
drift dev sync
drift dev export <type> <contentId> [--force]
```

Use `check` to validate without changing state, `load` to replace only the
in-memory content until restart, and `sync` to publish versioned JSON into
SQLite. `sync` rejects different data at the same version, skips older source,
preserves existing `enabled` values, and does not delete absent definitions.
`export` writes the currently active definition at version `current + 1` using
an atomic rename; it refuses to overwrite an existing file unless `--force` is
given.

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
not generated snowflake IDs.

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
