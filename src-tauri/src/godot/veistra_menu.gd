# veistra-menu v1
#
# Mention in agent, on the editor's own right-click menus: the Scene dock, the
# FileSystem dock and the Script editor's tabs. The editor plugin loads this
# only on Godot 4.4 or later, where EditorContextMenuPlugin arrived, and only
# when Veistra started the editor; on 4.2 and 4.3 the dock's button and the
# shortcut do the same. A press goes to the dock, which writes the line.
@tool
extends EditorContextMenuPlugin

# EditorContextMenuPlugin.ContextMenuSlot, by value, so the plugin that adds
# this can name them on an engine that has no such enum.
const SCENE_TREE := 0
const FILESYSTEM := 1
const SCRIPT_EDITOR := 2

# (what: String, path: String) -> void, the dock's mention.
var mention: Callable
var slot := SCENE_TREE


func _popup_menu(paths: PackedStringArray) -> void:
	if slot == FILESYSTEM:
		var files := 0
		for path in paths:
			if not path.ends_with("/"):
				files += 1
		if files == 0:
			return
	add_context_menu_item("Mention to Veistra agent", _on_pressed)


# The Scene dock hands over its selected nodes, which the right-click has
# already made the editor's selection; the FileSystem dock its paths; the
# Script editor the script itself.
func _on_pressed(items: Array) -> void:
	match slot:
		SCENE_TREE:
			mention.call("selection", "")
		FILESYSTEM:
			for item in items:
				var path := str(item)
				if not path.ends_with("/"):
					mention.call("file", path)
		SCRIPT_EDITOR:
			for item in items:
				if item is Resource:
					mention.call("file", item.resource_path)
