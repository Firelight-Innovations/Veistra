import type { Body } from "./blocks";

/**
 * The vocabulary tutorial. Everything after this one says "the cluster switcher" or
 * "the band" without stopping to explain it, so this is where those get names.
 *
 * Deliberately short and deliberately first. It has no steps worth calling
 * steps — it is a labelled diagram, now drawn as one rather than only argued
 * for in prose.
 */
export const theWindow: Body = {
  takeaway:
    "You can name every band of the Veistra window, which is what the rest of these tutorials assume.",
  blocks: [
    {
      kind: "text",
      body: "The Veistra window is four horizontal bands stacked in a column, with a narrow rail down the right. Only the middle band grows. Naming them is worth four minutes, because every other tutorial says these words without stopping.",
    },
    {
      kind: "mock",
      view: "window-bands",
      caption: "The four bands, each named by the arrow pointing at it.",
    },

    { kind: "heading", body: "1. The title bar" },
    { kind: "mock", view: "title-bar", caption: "The menu bar and the window controls beside it." },
    {
      kind: "text",
      body: "Top of the window. On the left is the menu bar: **File**, **Edit**, **Apps**, **View**, **Run**, **Terminal**, **Help**. In the middle is the **cluster switcher** pill with search beside it, and the two stay centred on the window together. On the right are **Upgrade**, a `+` for a new agent session, the terminal, **Agents** and **Clusters** toggles, **Settings**, and then the window controls.",
    },
    {
      kind: "text",
      body: "As the window narrows, the bar folds up instead of overlapping. First the right-hand buttons fold into one **More actions** button. Each of its rows does what its button did and shows the same shortcut. Next, the menus fold behind a hamburger button. The window controls never fold. If space is still short, search shrinks to its magnifier and `Ctrl+K`, and then the pill shortens the cluster's name.",
    },
    {
      kind: "text",
      body: "**Apps** lists every app this build ships, plus **Terminal**, plus your saved layout presets.",
    },
    {
      kind: "note",
      body: "Every accelerator drawn beside a menu item is one the keystroke actually performs. An item with no accelerator beside it has no shortcut, rather than an undocumented one.",
    },

    { kind: "heading", body: "2. The cluster switcher" },
    {
      kind: "mock",
      view: "switcher-bar",
      caption: "The pill in the middle of the title bar opens the list of clusters.",
    },
    {
      kind: "text",
      body: "There is no bar of its own any more. Your **clusters** — each one an independent workspace with its own project and its own arrangement of panes — are listed by the pill in the middle of the title bar, and drawn as one small badge each at the top of the rail on the right. `Ctrl+Tab` cycles them and `Ctrl+1` to `Ctrl+9` jump to one.",
    },
    {
      kind: "text",
      body: "The pill's list also makes a **new cluster** and switches **project**. Right-click a badge to rename or close its cluster.",
    },
    {
      kind: "text",
      body: "The title bar also holds a warning-triangle badge while any tool's health is not **ok** — **needs update**, **not tracked**, or **not installed**. It counts the stack's authoring tools. On a fresh machine they all read **not installed**, which is correct rather than broken; see **The stack, end to end** for why. In a narrow window the badge is the first row of **More actions** instead, and that button shows a dot.",
    },

    { kind: "heading", body: "3. The tool window" },
    {
      kind: "text",
      body: "The large middle band, and the only one that grows. It holds the **panes** of whichever cluster is showing, each with an app in it.",
    },
    { kind: "flow", steps: ["One pane fills it", "split it", "two panes, each with its own app"] },
    {
      kind: "text",
      body: "To its right is the **secondary panel**, which today shows source control and nothing else. `Ctrl+B` collapses it to a strip and brings it back.",
      // The panel is deliberately roomier than source control fills — it is
      // meant to grow more views. Saying that here would be describing the
      // roadmap rather than the window.
    },

    { kind: "heading", body: "4. The terminal band" },
    {
      kind: "text",
      body: "Under the tool window, across the full width. Wide and short, which is the shape a terminal wants. Ctrl and the key under Escape opens and closes it.",
    },
    {
      kind: "text",
      body: "The band belongs to the **cluster**, not to the window.",
    },
    {
      kind: "flow",
      steps: ["Switch clusters", "the terminal band swaps too", "same as the panes above"],
    },
    {
      kind: "note",
      body: "Drag the line above the band to resize it. Shove it down past a point and it snaps shut; lift it past the tool window's floor and it takes the whole column. Both have a deliberate dead zone, so neither happens by accident.",
    },

    { kind: "heading", body: "5. The status bar" },
    {
      kind: "mock",
      view: "status-bar",
      caption: "The branch and its diff stat, then GitHub. Each opens the Git page.",
    },
    {
      kind: "text",
      body: "The thin bar along the bottom. It reports, left to right, the open cluster's branch and how far it has diverged, and a diff-stat readout of the working tree. GitHub status finishes the row.",
    },
    {
      kind: "text",
      body: "Both are buttons. Click the branch to open **Source Control**, or **GitHub** to see the project's pull requests and issues. Each opens the Git page down the right-hand side, and a second click closes it again.",
    },

    { kind: "heading", body: "Worth knowing now" },
    {
      kind: "keys",
      rows: [
        { chord: "Ctrl+K", what: "Search this project." },
        { chord: "Ctrl+B", what: "Show or hide the secondary panel." },
        { chord: "Ctrl+`", what: "Show or hide the terminal band." },
        { chord: "Ctrl+Shift+`", what: "New terminal." },
        { chord: "F11", what: "Full screen." },
        { chord: "Ctrl+,", what: "Open Settings." },
        { chord: "Ctrl+1", what: "…through `Ctrl+9`, select the nth tab in this window's bar." },
      ],
    },
    {
      kind: "soon",
      body: "`Ctrl+Shift+P` opens a command palette that is not built yet, the **Run** menu does nothing, and **Help** has four items that are all inert. They are drawn because the shape of the menu is settled; none of them acts.",
    },
  ],
};
