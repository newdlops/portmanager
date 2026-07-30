# Port Manager Sidebar Grouping

## User and job to be done

Developers use the native VS Code Port Manager tree to rapidly locate routing
status, network topology, service controls, and system diagnostics without a
large diagnostics branch flooding the viewport.

## Hierarchy and density

The stable root order is **Overview**, **Networks**, **Services**, and
**System**. Networks contain, in order, collapsed **Routes**, **Connections**,
**Port mappings**, **Connect actions**, and **Manage actions**. System contains
collapsed **Health**, **Browser access & DNS**, **Runtime & terminal discovery**,
**Recent activity**, and **Maintenance**. Category rows are presentation-only;
the existing leaf rows retain their commands, context values, drag identity,
and owner-transfer behavior.

The tree remains compact: descriptions use `<state>[ · <grouped count>…]`,
with counts ordered by the visible hierarchy. Labels carry the meaning needed
to scan or act; descriptions add only compact state/count context.

## Native presentation and narrow widths

Use only VS Code `ThemeIcon` and theme colors. Labels stay short and meaningful
when VS Code applies its native ellipsis. Counts occur early in descriptions,
while full names, paths, errors, DNS values, and route details remain in native
tooltips or child rows. The tree does not sniff width or introduce custom CSS.

## State coverage

Loading and unavailable data remain visible through their existing placeholders
and diagnostics children. Empty groups retain an explicit empty child. Errors
remain a named warning/error row with complete tooltip text. Healthy/degraded,
disabled owner actions, worker ownership, and long runtime/terminal/DNS values
continue to be communicated with text and tooltips, never color alone.

## Anti-patterns

Do not flatten diagnostics, use entity-name comma lists in summaries, duplicate
actions, make category rows actionable or draggable, convey state only by color
or icons, width-sniff, or add custom styling/colors/fonts/webviews.
