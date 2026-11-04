# The Veistra window

*Getting started · 4 min*

Name every part of the frame, so the rest of these tutorials make sense.

---

The Veistra window is five horizontal bands stacked in a column. Only the middle
one grows. Naming them is worth four minutes, because every other tutorial says
these words without stopping.

<!-- SCREENSHOT: the full Veistra window with each of the five bands labelled by an arrow, 1440x900 -->

_The five bands, each named by the arrow pointing at it._

## 1. The title bar

<!-- SCREENSHOT: the title bar — menu bar, project pill and search, right-hand buttons, window controls, 1440x60 -->

_The menus on the left, the project pill and search in the middle, the buttons and window controls on the right._

Top of the window. On the left is the menu bar: **File**, **Edit**, **Apps**,
**View**, **Run**, **Terminal**, **Help**. In the middle is the project pill,
which names the project and the cluster you are in; click it to switch.
The search field sits beside it, and the two stay centred on the window
together. On the right are **Upgrade**, a `+` for a new agent session, the
terminal, **Agents** and **Clusters** toggles, **Settings**, and then the window
controls.

As the window narrows, the bar folds up instead of overlapping. First the
right-hand buttons fold into one **More actions** button (`…`). Each of its
rows does what its button did and shows the same shortcut. Next, the menus
fold behind a hamburger button. The window controls never fold. If space is
still short, the search field shrinks to its magnifier and `Ctrl+K`, and then
the pill shortens the cluster's name.

A warning badge appears among the right-hand buttons only while a tool needs
attention. In a narrow window it becomes the first row of **More actions**,
and the button shows a dot.

**Apps** and the switcher bar's `+` menu are the same list, built once.

> Every accelerator drawn beside a menu item is one the keystroke actually
> performs. An item with no accelerator beside it has no shortcut, rather than
> an undocumented one.

## 2. The switcher bar

<!-- SCREENSHOT: the switcher bar — cluster tabs, the + menu, and the search field, 1440x60 -->

_Clusters on the left, the `+` between them, search on the right._

Under the title bar. On the left are your **clusters** — each one an
independent workspace with its own project and its own arrangement of panes.
On the right is the search field, and between them the `+` that opens
something new.

The `+` menu lists every app this build ships — **Home**, **File Explorer**,
**File Viewer**, **Tutorials** — plus **Terminal**, plus your saved layout
presets.

The bar also holds a warning-triangle badge, listing any tool whose health is
not **ok** — **needs update**, **not tracked**, or **not installed**. It
counts the stack's pinned authoring tools, of which there are none today — it
once counted two, and both are now the single Schematify app rather than
pinned tools (see [The stack, end to end](the-stack.md)), so the badge is
silent rather than warning about anything. That is the badge's normal healthy
state, not a sign it failed to load.

## 3. The tool window

The large middle band, and the only one that grows. It holds the **panes** of
whichever cluster is showing, each with an app in it.

One pane fills it → split it → two panes, each with its own app

To its right is the **rail**, a column of page buttons along the window's edge.
A page opens docked beside the tool window. The **Git** page holds source
control and GitHub as two tabs. `Ctrl+B` opens and closes it. With no page
open, the tool window runs all the way to the rail.

## 4. The terminal band

Under the tool window, across the full width. Wide and short, which is the
shape a terminal wants. Ctrl and the key under Escape opens and closes it.

The band belongs to the **cluster**, not to the window.

Switch clusters → the terminal band swaps too → same as the panes above

> Drag the line above the band to resize it. Shove it down past a point and it
> snaps shut; lift it past the tool window's floor and it takes the whole
> column. Both have a deliberate dead zone, so neither happens by accident.

## 5. The status bar

<!-- SCREENSHOT: the status bar along the bottom of the window, 1440x40 -->

_The branch and its diff stat, then GitHub. Each opens the Git page._

The thin bar along the bottom. It reports, left to right, the open cluster's
branch and how far it has diverged, and a diff-stat readout of the working
tree. GitHub status finishes the row.

Both are buttons. Click the branch to open **Source Control**, or **GitHub** to
see the project's pull requests and issues. Each opens the Git page down the
right-hand side, and a second click closes it again.

## Worth knowing now

| Chord           | What                                                                 |
| ---------------- | --------------------------------------------------------------------- |
| `Ctrl+K`         | Search this project.                                                  |
| `Ctrl+B`         | Open or close the Git page (source control).                          |
| `` Ctrl+` ``     | Show or hide the terminal band.                                       |
| `` Ctrl+Shift+` ``| New terminal.                                                        |
| `F11`            | Full screen.                                                           |
| `Ctrl+,`         | Open Settings.                                                         |
| `Ctrl+1`         | …through `Ctrl+9`, select the nth tab in this window's bar.           |

> **Not yet:** `Ctrl+Shift+P` opens a command palette that is not built yet,
> the **Run** menu does nothing, and **Help** has four items that are all
> inert. They are drawn because the shape of the menu is settled; none of them
> acts.

---

**Takeaway:** You can name every band of the Veistra window, which is what the
rest of these tutorials assume.
