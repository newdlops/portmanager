# Port Manager Sidebar Layout

## User and job to be done

Developers use the native VS Code Port Manager tree to see at a glance which
logical networks are live and what they route, then act on a network without
digging through wrapper groups or scrolling past diagnostics.

## Hierarchy and density

Logical networks sit directly at the root. Above them appear only the
first-run shortcuts: **Initialize This Worktree** until the window has a
default network, and **Create Isolated Worktree** while no network exists (the
view toolbar carries it otherwise). Below them come warning rows for stale
route scopes whose network row is gone, then the collapsed **Services** and
**System** sections.

A network expands straight into its leaves, in scan order: routed ports sorted
by logical port (daemon routes, Compose routes, host bindings, host access),
then the VS Code window default, attached terminals, and attached Compose
projects. Host bindings and host access render through their own actionable
leaves, never as a second route row. A network with nothing to list has no
expander; the network of this window starts expanded.

System keeps its collapsed **Health**, **Browser access & DNS**, **Runtime &
terminal discovery**, **Recent activity**, and **Maintenance** categories.
Category rows are presentation-only; the leaf rows keep their commands,
context values, drag identity, and owner-transfer behavior.

## Actions

Network commands are not tree rows. Opening a network terminal and attaching
the active terminal are inline hover buttons, and the network context menu
repeats them with the rest, split into separated groups: connect, ports,
presets, maintenance, and remove. Menu entries that replace former action rows
stay visible in every window, because owner-scoped commands take control-plane
ownership themselves. The view toolbar holds the primary actions; raw network
creation lives in its overflow menu. Command titles omit the "Port Manager:"
prefix because `category` already renders it in the Command Palette.

## State at a glance

Descriptions use `<state>[ · <count>…]`. A network reads `This window`,
`Active`, `Idle`, `Stopped`, `Creating`, or `Error`, followed by at most a
route and a terminal count. Leaf descriptions name only the exceptional state
(`stopped`, `detached`, `error`); healthy states stay implicit. Icons and
theme colors reinforce the text (green once a network routes something,
dimmed when stopped, red on error) but never carry state alone. The
activity-bar badge counts failures (error-state networks, attachments, host
mappings, routes, and a stale or failed daemon) so problems show while the
sidebar is hidden; transitional daemon states never raise it.

## Native presentation and narrow widths

Use only VS Code `ThemeIcon` and theme colors. Labels stay short and meaningful
when VS Code applies its native ellipsis; port rows read `logical → transport`.
Full names, paths, errors, DNS values, and route details remain in native
tooltips or child rows. The tree does not sniff width or introduce custom CSS.

## Anti-patterns

Do not reintroduce action-row groups or wrapper categories under networks,
list a host mapping twice, use filler states such as "Available", put
entity-name comma lists in summaries, duplicate the toolbar as rows, make
category rows actionable or draggable, make a single click detach or remove
anything, convey state only by color or icons, width-sniff, or add custom
styling, colors, fonts, or webviews.
