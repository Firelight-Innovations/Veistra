use super::*;
use crate::comments::{Author, Draft, Verdict};
use std::io::Write as _;
use tempfile::TempDir;

fn context(root: &Path) -> CallContext {
    CallContext {
        cluster_id: Some("c1".to_string()),
        project: Some(root.to_path_buf()),
    }
}

fn note(ctx: &CallContext, anchor: Anchor, body: &str) -> Comment {
    comments::create(
        ctx,
        Draft {
            anchor,
            body: body.to_string(),
            screenshot_png: None,
        },
    )
    .expect("create")
}

fn take(path: Option<&str>) -> Anchor {
    Anchor::Take {
        take: "2026-11-04_10-00-00".into(),
        number: None,
        n: 2,
        at_ms: 102_200,
        in_ms: None,
        out_ms: None,
        packet: ".veistra/feedback/x".into(),
        scene: Some("res://levels/hallway.tscn".into()),
        node_path: path.map(str::to_string),
    }
}

fn mesh(part: &str, blend: Option<&str>) -> Anchor {
    Anchor::Mesh {
        part: part.into(),
        material: "Wool".into(),
        blend: blend.map(str::to_string),
        version: None,
    }
}

fn read_notes(dir: &Path) -> Value {
    let text = std::fs::read_to_string(dir.join(NOTES)).expect("notes.json");
    serde_json::from_str(&text).expect("json")
}

fn append(dir: &Path, text: &str) {
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(EVENTS))
        .expect("events");
    f.write_all(text.as_bytes()).expect("write");
}

#[test]
fn godot_gets_node_and_take_notes_and_blender_gets_the_open_files_parts() {
    let env = TempDir::new().unwrap();
    let ctx = context(env.path());
    let node = note(
        &ctx,
        Anchor::Node {
            path: "Hallway/Enemy_02".into(),
            scene: Some("res://levels/hallway.tscn".into()),
        },
        "floats above the floor",
    );
    note(&ctx, take(Some("Hallway/Enemy_02")), "clips the wall");
    note(&ctx, take(None), "no node, nothing to show it on");
    note(&ctx, mesh("Frame", Some("props/bed.blend")), "frame");
    note(&ctx, mesh("Frame", Some("props/chair.blend")), "other file");
    note(&ctx, mesh("Leg", None), "from before blend was kept");
    let all = comments::list(&ctx).unwrap();

    let godot = rows(&all, Scope::Godot);
    assert_eq!(godot.len(), 2);
    assert_eq!(godot[0]["id"], node.id.as_str());
    assert_eq!(godot[0]["kind"], "node");
    assert_eq!(godot[0]["path"], "Hallway/Enemy_02");
    assert_eq!(godot[0]["scene"], "res://levels/hallway.tscn");
    assert_eq!(godot[0]["status"], "open");
    assert_eq!(godot[0]["label"], "Sent");
    assert_eq!(godot[1]["kind"], "take");
    assert_eq!(godot[1]["path"], "Hallway/Enemy_02");
    assert_eq!(godot[1]["title"], "Play note 2 at 1:42");

    let bed = rows(
        &all,
        Scope::Blender {
            file: Some("props/bed.blend"),
        },
    );
    let bodies: Vec<&str> = bed.iter().filter_map(|r| r["body"].as_str()).collect();
    assert_eq!(bodies, ["frame", "from before blend was kept"]);
    let unsaved = rows(&all, Scope::Blender { file: None });
    assert_eq!(unsaved.len(), 1, "a note with no file shows on any file");
}

#[test]
fn a_fixed_note_carries_its_fix_and_thread() {
    let env = TempDir::new().unwrap();
    let ctx = context(env.path());
    let id = note(&ctx, mesh("Frame", None), "sag").id;
    comments::resolve_with_commit(
        &ctx,
        &id,
        "stiffer".into(),
        Some("abc123".into()),
        Author::Agent,
    )
    .unwrap();
    comments::verdict(&ctx, &id, Verdict::Broken, Some("still sags".into())).unwrap();
    comments::resolve_with_commit(&ctx, &id, "a strut".into(), None, Author::Agent).unwrap();
    let all = comments::list(&ctx).unwrap();
    let r = &rows(&all, Scope::Blender { file: None })[0];
    assert_eq!(r["status"], "fixed");
    assert_eq!(r["label"], "Completed");
    assert_eq!(r["fix"]["note"], "a strut");
    assert_eq!(r["fix"]["by"], "agent");
    assert_eq!(r["replies"][0]["body"], "stiffer");
    assert_eq!(r["replies"][1]["body"], "still sags");
}

#[test]
fn notes_json_is_rewritten_only_when_the_notes_or_the_acks_change() {
    let env = TempDir::new().unwrap();
    let chan = TempDir::new().unwrap();
    let ctx = context(env.path());
    let mut c = Channel::new(chan.path().to_path_buf());

    assert!(c.sync(&ctx, Scope::Godot).unwrap(), "the first sync writes");
    assert_eq!(read_notes(chan.path())["notes"], json!([]));
    assert!(!c.sync(&ctx, Scope::Godot).unwrap(), "nothing changed");

    let id = note(&ctx, take(Some("Hallway/Enemy_02")), "clips").id;
    assert!(c.sync(&ctx, Scope::Godot).unwrap());
    let first = read_notes(chan.path());
    assert_eq!(first["notes"][0]["id"], id.as_str());

    // An agent's resolve, as `resolve_play_note` makes it, reaches the tab.
    comments::resolve_with_commit(&ctx, &id, "moved it".into(), None, Author::Agent).unwrap();
    assert!(c.sync(&ctx, Scope::Godot).unwrap());
    let second = read_notes(chan.path());
    assert_eq!(second["notes"][0]["status"], "fixed");
    assert!(second["rev"].as_u64() > first["rev"].as_u64());

    c.ack(Ack {
        n: 7,
        ok: true,
        message: "Sent to the agent".into(),
    });
    assert!(c.sync(&ctx, Scope::Godot).unwrap());
    assert_eq!(read_notes(chan.path())["acks"][0]["n"], 7);
    assert!(!c.sync(&ctx, Scope::Godot).unwrap());
    assert!(
        !chan.path().join("notes.json.tmp").exists(),
        "the .tmp became notes.json"
    );
}

#[test]
fn an_unreadable_comment_file_is_skipped_rather_than_emptying_the_tab() {
    let env = TempDir::new().unwrap();
    let chan = TempDir::new().unwrap();
    let ctx = context(env.path());
    note(&ctx, mesh("Frame", None), "sag");
    std::fs::write(
        env.path().join(".veistra/comments/000000000000-0000.json"),
        "{ half",
    )
    .unwrap();
    let mut c = Channel::new(chan.path().to_path_buf());
    c.sync(&ctx, Scope::Blender { file: None }).unwrap();
    let notes = read_notes(chan.path());
    assert_eq!(notes["notes"].as_array().map(Vec::len), Some(1));
    assert!(notes["problem"].is_null());
}

#[test]
fn good_lines_parse_and_the_rules_refuse_the_rest() {
    let ask = parse_event(
        r#"{"t":5,"n":41,"kind":"ask","text":"why does it float?","scene":"res://levels/hallway.tscn","nodes":["Hallway/Enemy_02"],"png":"ask-41.png","camera":{"fov":75}}"#,
    )
    .unwrap();
    assert_eq!(
        ask,
        EditorEvent::Ask {
            n: 41,
            t: 5,
            text: "why does it float?".into(),
            scene: Some("res://levels/hallway.tscn".into()),
            nodes: vec!["Hallway/Enemy_02".into()],
            camera: Some(json!({"fov": 75})),
            png: Some("ask-41.png".into()),
        }
    );
    let v = parse_event(r#"{"n":2,"kind":"verdict","id":"0192a3b4c5d6-ab12","verdict":"good"}"#);
    assert!(matches!(v, Ok(EditorEvent::Verdict { good: true, .. })));
    assert_eq!(
        parse_event(r#"{"n":3,"kind":"markup"}"#),
        Ok(EditorEvent::Markup { n: 3, t: 0 })
    );

    let refused = |line: &str| parse_event(line).expect_err(line);
    let traversal = refused(r#"{"n":4,"kind":"ask","text":"q","png":"../x.png"}"#);
    assert_eq!(traversal.n, Some(4));
    assert!(
        refused(r#"{"n":4,"kind":"ask","text":"q","png":"ask-5.png"}"#)
            .why
            .contains("picture")
    );
    let long = json!({"n": 5, "kind": "ask", "text": "x".repeat(MAX_TEXT + 1)}).to_string();
    assert!(refused(&long).why.contains("longer than"));
    assert!(refused(r#"{"n":6,"kind":"ask","text":"   "}"#)
        .why
        .contains("question"));
    let bad_id = r#"{"n":7,"kind":"verdict","id":"../../x","verdict":"good"}"#;
    assert!(refused(bad_id).why.contains("not a note"));
    let bad_word = r#"{"n":8,"kind":"verdict","id":"0192a3b4c5d6-ab12","verdict":"meh"}"#;
    assert!(refused(bad_word).why.contains("neither"));
    assert_eq!(refused(r#"{"kind":"markup"}"#).n, None);
    assert_eq!(refused("not json").n, None);
    assert!(refused(r#"{"n":9,"kind":"delete"}"#)
        .why
        .contains("unknown"));
}

#[test]
fn events_come_back_once_after_the_cursor_and_a_half_line_waits() {
    let chan = TempDir::new().unwrap();
    let dir = chan.path();
    let mut c = Channel::new(dir.to_path_buf());
    std::fs::write(dir.join("ask-1.png"), b"\x89PNG fake").unwrap();
    append(
        dir,
        "{\"n\":1,\"kind\":\"ask\",\"text\":\"why?\",\"nodes\":[\"Hallway/Enemy_02\"],\"png\":\"ask-1.png\"}\n{\"n\":2,\"kind\":\"mar",
    );
    c.poll();
    let first = c.since(0);
    assert_eq!(first.len(), 1, "the half-written line waits");
    assert_eq!(first[0]["seq"], 1);
    assert_eq!(first[0]["kind"], "ask");
    assert_eq!(first[0]["nodes"][0], "Hallway/Enemy_02");
    assert_eq!(first[0]["pngBase64"], BASE64.encode(b"\x89PNG fake"));

    append(dir, "kup\"}\n");
    c.poll();
    let next = c.since(1);
    assert_eq!(next.len(), 1);
    assert_eq!(next[0]["kind"], "markup");
    assert_eq!(next[0]["seq"], 2);
    assert!(c.since(2).is_empty(), "each event is handed out once");

    // Answered, an ask is not handed out again and its picture is gone.
    c.ack(Ack {
        n: 1,
        ok: true,
        message: String::new(),
    });
    assert_eq!(c.since(0).len(), 1);
    assert!(!dir.join("ask-1.png").exists());
}

#[test]
fn a_refused_line_is_answered_in_notes_json_instead_of_reaching_the_pane() {
    let env = TempDir::new().unwrap();
    let chan = TempDir::new().unwrap();
    let ctx = context(env.path());
    let mut c = Channel::new(chan.path().to_path_buf());
    append(
        chan.path(),
        "{\"n\":9,\"kind\":\"ask\",\"text\":\"q\",\"png\":\"../../secret.png\"}\n",
    );
    c.poll();
    assert!(c.since(0).is_empty());
    c.sync(&ctx, Scope::Godot).unwrap();
    let acks = &read_notes(chan.path())["acks"];
    assert_eq!(acks[0]["n"], 9);
    assert_eq!(acks[0]["ok"], false);
    assert_eq!(acks[0]["message"], "the picture is not this ask's");
}

#[test]
fn an_ask_with_a_missing_picture_says_so() {
    let chan = TempDir::new().unwrap();
    let mut c = Channel::new(chan.path().to_path_buf());
    append(
        chan.path(),
        "{\"n\":3,\"kind\":\"ask\",\"text\":\"q\",\"png\":\"ask-3.png\"}\n",
    );
    c.poll();
    let e = &c.since(0)[0];
    assert!(e["pngBase64"].is_null());
    assert!(e["pngProblem"]
        .as_str()
        .unwrap_or("")
        .contains("could not be read"));
}

#[test]
fn a_mention_names_something_that_is_there() {
    let selection = parse_event(
        r#"{"t":7,"n":50,"kind":"mention","what":"selection","scene":"res://levels/hallway.tscn","nodes":["Hallway/Enemy_02","Hallway/Door"]}"#,
    )
    .unwrap();
    assert_eq!(
        selection,
        EditorEvent::Mention {
            n: 50,
            t: 7,
            what: Mention::Selection,
            scene: Some("res://levels/hallway.tscn".into()),
            nodes: vec!["Hallway/Enemy_02".into(), "Hallway/Door".into()],
            path: None,
            png: None,
        }
    );
    let file = parse_event(r#"{"n":51,"kind":"mention","what":"file","path":"res://enemy.gd"}"#);
    assert!(matches!(
        file,
        Ok(EditorEvent::Mention { what: Mention::File, path: Some(ref p), .. }) if p == "res://enemy.gd"
    ));
    let scene =
        parse_event(r#"{"n":52,"kind":"mention","what":"scene","scene":"C:/art/bed.blend"}"#);
    assert!(matches!(
        scene,
        Ok(EditorEvent::Mention {
            what: Mention::Scene,
            ..
        })
    ));

    let refused = |line: &str| parse_event(line).expect_err(line).why;
    assert!(
        refused(r#"{"n":53,"kind":"mention","what":"selection","nodes":[]}"#).contains("selected")
    );
    assert!(refused(r#"{"n":54,"kind":"mention","what":"scene"}"#).contains("scene"));
    assert!(
        refused(r#"{"n":55,"kind":"mention","what":"file","path":"C:/Windows/x"}"#)
            .contains("not a file in the project")
    );
    assert!(refused(r#"{"n":56,"kind":"mention","what":"viewport"}"#).contains("no picture"));
    assert!(
        refused(r#"{"n":57,"kind":"mention","what":"viewport","png":"ask-57.png"}"#)
            .contains("picture")
    );
    assert!(refused(r#"{"n":58,"kind":"mention","what":"everything"}"#).contains("names nothing"));
    let many: Vec<String> = (0..=MAX_NODES).map(|i| format!("N{i}")).collect();
    let crowd = json!({"n": 59, "kind": "mention", "what": "selection", "nodes": many});
    assert!(refused(&crowd.to_string()).contains("too many"));
}

#[test]
fn a_viewport_mention_brings_its_picture_and_drops_it_once_answered() {
    let chan = TempDir::new().unwrap();
    let dir = chan.path();
    let mut c = Channel::new(dir.to_path_buf());
    std::fs::write(dir.join("mention-4.png"), b"\x89PNG view").unwrap();
    append(
        dir,
        "{\"n\":4,\"kind\":\"mention\",\"what\":\"viewport\",\"png\":\"mention-4.png\"}\n\
         {\"n\":5,\"kind\":\"mention\",\"what\":\"file\",\"path\":\"res://a.tres\"}\n",
    );
    c.poll();
    let events = c.since(0);
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["kind"], "mention");
    assert_eq!(events[0]["what"], "viewport");
    assert_eq!(events[0]["pngBase64"], BASE64.encode(b"\x89PNG view"));
    assert_eq!(events[1]["what"], "file");
    assert_eq!(events[1]["path"], "res://a.tres");
    assert!(events[1]["pngBase64"].is_null());
    assert!(
        events[1]["pngProblem"].is_null(),
        "no picture was asked for"
    );
    c.ack(Ack {
        n: 4,
        ok: true,
        message: String::new(),
    });
    assert!(!dir.join("mention-4.png").exists());
}

#[test]
fn only_the_last_acks_are_kept() {
    let chan = TempDir::new().unwrap();
    let mut c = Channel::new(chan.path().to_path_buf());
    for n in 0..30 {
        c.ack(Ack {
            n,
            ok: true,
            message: String::new(),
        });
    }
    assert_eq!(c.acks.len(), ACKS_KEPT);
    assert_eq!(c.acks.front().map(|a| a.n), Some(10));
}

/// The two editors' halves of the files ship as text inside this build, so
/// what each one writes is held to what this module reads.
#[test]
fn both_tabs_keep_to_the_rules_these_files_are_read_with() {
    let boot = crate::blender::BOOT_SCRIPT;
    let dock = crate::godot::plugin::DOCK;
    let max = format!("MAX_TEXT = {MAX_TEXT}");
    assert!(boot.contains(&max), "veistra_boot.py's MAX_TEXT");
    assert!(dock.contains(&format!("const MAX_TEXT := {MAX_TEXT}")));
    for name in [NOTES, EVENTS] {
        assert!(boot.contains(name) && dock.contains(name), "{name}");
    }
    for script in [boot, dock] {
        assert!(script.contains("\"ask-%d.png\" % n"));
        assert!(script.contains("\"mention-%d.png\" % n"));
        for kind in ["ask", "verdict", "markup", "mention"] {
            assert!(script.contains(&format!("\"kind\": \"{kind}\"")), "{kind}");
        }
        // The comment store is the pane's: no path into it, in either.
        assert!(!script.contains("\".veistra") && !script.contains("\"comments\""));
    }
    // Blender: the tab is registered with the rest, after the channel check,
    // and a picture never becomes an image in the person's file.
    let register = &boot[boot.find("def register():").unwrap()..];
    let guard = register.find("if not CHANNEL:").unwrap();
    assert!(register.find("register_tab()").unwrap() > guard);
    assert!(!boot.contains("images.new") && !boot.contains("\"UNDO\""));
}
