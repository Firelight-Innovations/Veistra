import { Fragment, useEffect, useState } from "react";
import {
  Bookmark,
  Box,
  Boxes,
  ChevronLeft,
  Clapperboard,
  ChevronRight,
  File,
  FileText,
  Folder,
  Frame,
  Gamepad2,
  GitBranch,
  SquareKanban,
  Link,
  MessageSquare,
  MousePointer2,
  Palette,
  Search,
  Shapes,
  Slash,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { fileIconUrl, folderIconUrl } from "@veistra/file-icons";
import { strings } from "../strings";
import type { MenuItem, MenuProps } from "./types";
import "./menu.css";
import "./kinds.css";

/** The glyph a row leads with, by what it is. Rows without a known kind get none. */
const ICON: Record<string, LucideIcon> = {
  design: Palette,
  canvas: Shapes,
  frame: Frame,
  comment: MessageSquare,
  "canvas-comment": MessageSquare,
  "design-comment": MessageSquare,
  pm: SquareKanban,
  issue: Link,
  cluster: GitBranch,
  file: FileText,
  folder: Folder,
  context: Bookmark,
  selection: MousePointer2,
  // What a running editor reports: its group, then a node, a scene, an object.
  godot: Gamepad2,
  "godot-node": Box,
  "godot-scene": Clapperboard,
  blender: Boxes,
  "blender-object": Box,
  search: Search,
  skill: Sparkles,
  command: Slash,
  other: File,
};

/**
 * A file or folder row's type icon, the one the Files explorer shows for the
 * same name, or `null` for every other row. A list of names to scan is where
 * `@veistra/file-icons` says its colour belongs, and `main.json` among
 * `main.json.bak` and a frame reads faster by its icon. Only a row that names
 * a file has one: "Files", which browses them, keeps the glyph.
 */
function typeIconUrl(item: MenuItem): string | null {
  if (!item.fileName) return null;
  if (item.kind === "file") return fileIconUrl(item.fileName);
  if (item.kind === "folder") return folderIconUrl(item.fileName, false);
  return null;
}

/**
 * A popup list: slash commands, @ mentions. Presentational only; the caller
 * owns filtering, the active item and the keys, and passes `activeId` so the
 * input can point `aria-activedescendant` at `menu-item-<id>`.
 *
 * A nested list drills down in place, one level at a time, with the level's
 * name and a back arrow at the top, so it never grows sideways out of a
 * narrow pane.
 */
export function Menu({
  label,
  items,
  activeId,
  onPick,
  path: controlledPath,
  onPathChange,
  title,
  status,
  search,
  onBack,
}: MenuProps) {
  const [localPath, setLocalPath] = useState<string[]>([]);
  const path = controlledPath ?? localPath;
  const setPath = (next: string[]) => {
    setLocalPath(next);
    onPathChange?.(next);
  };
  useEffect(() => {
    if (activeId)
      document.getElementById(`menu-item-${activeId}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);
  if (items.length === 0 && !status) return null;
  let list = items;
  const trail: MenuItem[] = [];
  for (const id of path) {
    const next = list.find((i) => i.id === id);
    if (!next?.children) break;
    trail.push(next);
    list = next.children;
  }
  const heading = trail[trail.length - 1]?.label ?? title ?? label;
  const back = trail.length > 0 ? () => setPath(path.slice(0, trail.length - 1)) : onBack;
  const choose = (item: MenuItem) => {
    if (item.disabled) return;
    if (item.children) setPath([...path.slice(0, trail.length), item.id]);
    else onPick(item.id);
  };
  return (
    <div className="at-menu" data-nested={trail.length > 0 ? "" : undefined}>
      <div className="at-menu__head">
        {back && (
          <button
            type="button"
            className="at-menu__back"
            aria-label={strings.skills.back}
            title={strings.skills.back}
            onMouseDown={(event) => event.preventDefault()}
            onClick={back}
          >
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
        )}
        <span className="at-menu__title">{heading}</span>
      </div>
      {search && trail.length === 0 && (
        <div className="at-menu__search" data-empty={search.query ? undefined : ""}>
          <Search size={13} aria-hidden="true" />
          <span>{search.query || search.placeholder}</span>
        </div>
      )}
      {list.length > 0 && (
        <ul className="at-menu__list" role="listbox" aria-label={heading}>
          {list.map((item, index) => {
            const typeIcon = typeIconUrl(item);
            const Icon = !typeIcon && item.kind ? ICON[item.kind] : undefined;
            return (
              <Fragment key={item.id}>
                {item.separated && index > 0 && (
                  <li className="at-menu__sep" role="presentation" aria-hidden="true" />
                )}
                <li
                  id={`menu-item-${item.id}`}
                  // The glyph takes its kind's colour from `--k-kind-<kind>` in menu.css.
                  data-kind={item.kind}
                  role="option"
                  aria-selected={item.id === activeId}
                  aria-disabled={item.disabled}
                  tabIndex={-1}
                  className={`at-menu__item${item.id === activeId ? " at-menu__item--active" : ""}`}
                  // Keeps focus in the input, so typing carries on after a pick.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(item)}
                >
                  {typeIcon && (
                    // The label beside it names the file; announcing the icon too would say it twice.
                    <img
                      className="at-menu__icon at-menu__icon--type"
                      src={typeIcon}
                      alt=""
                      draggable={false}
                    />
                  )}
                  {Icon && <Icon className="at-menu__icon" size={16} aria-hidden="true" />}
                  <span className="at-menu__label">{item.label}</span>
                  {item.detail && <span className="at-menu__detail">{item.detail}</span>}
                  {item.children && (
                    <ChevronRight className="at-menu__arrow" size={14} aria-hidden="true" />
                  )}
                </li>
              </Fragment>
            );
          })}
        </ul>
      )}
      {status && (
        <div className="at-menu__status" role="status">
          {status}
        </div>
      )}
    </div>
  );
}
