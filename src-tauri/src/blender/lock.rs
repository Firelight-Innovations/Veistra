//! The one-writer lock (spec §11.3, DECISIONS X6): while Blender in a pane
//! has a `.blend` open, `.veistra/locks/<file>.lock` says so, and nothing
//! Veistra runs saves over that file. An agent's export still runs; it reads
//! the saved file and lands as the next version beside it
//! ([`super::versions`]).
//!
//! Rust is the only writer. Blender has no quit hook to clean up after
//! itself, and Veistra may exit first and leave Blender running, so the lock
//! names the holding process instead: its pid and the time it started. A lock
//! whose process is gone, or whose pid now belongs to a later process, is
//! stale, and the first reader removes it.

use crate::godot::scene::write_atomic;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

/// Bumped when the file's shape changes; a reader treats any other as stale.
pub const VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lock {
    pub version: u32,
    /// The `.blend`, relative to the environment, with forward slashes.
    pub file: String,
    /// Blender's process, not Veistra's: the lock is right for as long as
    /// that Blender runs, whoever else has exited.
    pub pid: u32,
    /// When `pid` started, in seconds since the epoch, as the OS reports it.
    pub process_start: u64,
    /// Epoch milliseconds the lock was taken.
    pub since: u64,
    pub cluster: Option<String>,
    /// The editor's channel folder, so a reader can tell which session.
    pub channel: Option<String>,
}

/// Seconds either way the OS may disagree with itself about a start time.
const START_SLACK: u64 = 1;

/// `<root>/.veistra/locks/<rel>.lock`, mirroring the `.blend`'s folders so two
/// files of one name never share a lock. `None` for anything that is not a
/// plain relative path inside the environment.
pub fn lock_path(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel_path = Path::new(rel);
    if rel.is_empty() || rel_path.is_absolute() {
        return None;
    }
    let mut out = locks_dir(root);
    for part in rel_path.components() {
        match part {
            Component::Normal(name) => out.push(name),
            Component::CurDir => {}
            _ => return None,
        }
    }
    let mut name = out.file_name()?.to_os_string();
    name.push(".lock");
    out.set_file_name(name);
    Some(out)
}

fn locks_dir(root: &Path) -> PathBuf {
    root.join(".veistra").join("locks")
}

/// When `pid` started, or `None` when no such process runs.
pub fn process_start(pid: u32) -> Option<u64> {
    let mut sys = sysinfo::System::new();
    let id = sysinfo::Pid::from_u32(pid);
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[id]), true);
    sys.process(id).map(sysinfo::Process::start_time)
}

/// Whether `lock`'s holder still runs, asked of `start_of` (the OS in
/// [`live`], a table in the tests).
fn held(lock: &Lock, start_of: &dyn Fn(u32) -> Option<u64>) -> bool {
    lock.version == VERSION
        && start_of(lock.pid).is_some_and(|start| start.abs_diff(lock.process_start) <= START_SLACK)
}

/// The lock file as written, stale or not.
pub fn read(root: &Path, rel: &str) -> Option<Lock> {
    let raw = std::fs::read_to_string(lock_path(root, rel)?).ok()?;
    serde_json::from_str(&raw).ok()
}

/// The lock on `rel` if its holder still runs. A stale one is removed.
pub fn live(root: &Path, rel: &str) -> Option<Lock> {
    live_with(root, rel, &process_start)
}

fn live_with(root: &Path, rel: &str, start_of: &dyn Fn(u32) -> Option<u64>) -> Option<Lock> {
    let path = lock_path(root, rel)?;
    if !path.is_file() {
        return None;
    }
    match read(root, rel) {
        Some(lock) if held(&lock, start_of) => Some(lock),
        _ => {
            let _ = std::fs::remove_file(&path);
            None
        }
    }
}

/// Lock `rel` for the Blender running as `pid`. Taking a lock this process
/// already holds answers it again; one held by another live process is
/// refused, since two editors on one file write over each other.
pub fn acquire(
    root: &Path,
    rel: &str,
    pid: u32,
    cluster: Option<&str>,
    channel: Option<&Path>,
) -> Result<Lock, String> {
    let start = process_start(pid).ok_or_else(|| format!("process {pid} is not running"))?;
    acquire_with(root, rel, pid, start, cluster, channel, &process_start)
}

fn acquire_with(
    root: &Path,
    rel: &str,
    pid: u32,
    process_start: u64,
    cluster: Option<&str>,
    channel: Option<&Path>,
    start_of: &dyn Fn(u32) -> Option<u64>,
) -> Result<Lock, String> {
    let path =
        lock_path(root, rel).ok_or_else(|| format!("{rel} is not a file in this environment"))?;
    if let Some(other) = live_with(root, rel, start_of) {
        if other.pid == pid && other.process_start.abs_diff(process_start) <= START_SLACK {
            return Ok(other);
        }
        return Err(format!(
            "{rel} is already open in another Blender (process {})",
            other.pid
        ));
    }
    let dir = path.parent().unwrap_or(root);
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    // Keeps locks out of the environment's history without touching its own
    // .gitignore, as the export cache does.
    let _ = std::fs::write(locks_dir(root).join(".gitignore"), "*\n");
    let lock = Lock {
        version: VERSION,
        file: rel.to_string(),
        pid,
        process_start,
        since: super::job::now_ms(),
        cluster: cluster.map(str::to_string),
        channel: channel.map(|c| c.display().to_string()),
    };
    let json = serde_json::to_vec_pretty(&lock).map_err(|e| e.to_string())?;
    write_atomic(&path, &json)?;
    Ok(lock)
}

/// Remove the lock on `rel` if `holder` holds it. Another holder's lock, or a
/// newer one for the same pid, is left alone. Returns whether one was removed.
pub fn release(root: &Path, rel: &str, holder: &Lock) -> bool {
    let Some(path) = lock_path(root, rel) else {
        return false;
    };
    match read(root, rel) {
        Some(on_disk) if on_disk.pid == holder.pid && on_disk.since == holder.since => {
            std::fs::remove_file(&path).is_ok()
        }
        _ => false,
    }
}

/// Remove every stale lock under the environment, as left by a Blender that
/// crashed while no Veistra watched it. Returns the live ones.
pub fn sweep(root: &Path) -> Vec<Lock> {
    sweep_with(root, &process_start)
}

fn sweep_with(root: &Path, start_of: &dyn Fn(u32) -> Option<u64>) -> Vec<Lock> {
    let mut live = Vec::new();
    let mut stack = vec![locks_dir(root)];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("lock") {
                continue;
            }
            let lock: Option<Lock> = std::fs::read_to_string(&path)
                .ok()
                .and_then(|raw| serde_json::from_str(&raw).ok());
            match lock {
                Some(lock) if held(&lock, start_of) => live.push(lock),
                _ => {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }
    live.sort_by(|a, b| a.file.cmp(&b.file));
    live
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// A process table: pid 10 started at 1000, pid 11 at 2000.
    fn table(pid: u32) -> Option<u64> {
        match pid {
            10 => Some(1000),
            11 => Some(2000),
            _ => None,
        }
    }

    fn take(root: &Path, rel: &str, pid: u32, start: u64) -> Result<Lock, String> {
        acquire_with(root, rel, pid, start, Some("c1"), None, &table)
    }

    #[test]
    fn lock_path_mirrors_the_blend_under_veistra_locks() {
        let root = Path::new("/env");
        assert_eq!(
            lock_path(root, "props/bed.blend").unwrap(),
            root.join(".veistra/locks/props/bed.blend.lock")
        );
        assert_eq!(
            lock_path(root, "./bed.blend").unwrap(),
            root.join(".veistra/locks/bed.blend.lock")
        );
        assert_ne!(
            lock_path(root, "a/bed.blend"),
            lock_path(root, "b/bed.blend")
        );
    }

    #[test]
    fn a_path_outside_the_environment_gets_no_lock() {
        let root = Path::new("/env");
        assert_eq!(lock_path(root, "../bed.blend"), None);
        assert_eq!(lock_path(root, "a/../../bed.blend"), None);
        assert_eq!(lock_path(root, ""), None);
        #[cfg(unix)]
        assert_eq!(lock_path(root, "/etc/bed.blend"), None);
        #[cfg(windows)]
        assert_eq!(lock_path(root, "C:\\bed.blend"), None);
    }

    #[test]
    fn a_lock_is_written_with_its_holder_and_kept_out_of_git() {
        let env = TempDir::new().unwrap();
        let lock = take(env.path(), "props/bed.blend", 10, 1000).unwrap();
        assert_eq!(lock.file, "props/bed.blend");
        assert_eq!((lock.pid, lock.process_start), (10, 1000));
        assert_eq!(read(env.path(), "props/bed.blend"), Some(lock.clone()));
        assert_eq!(live_with(env.path(), "props/bed.blend", &table), Some(lock));
        assert_eq!(
            std::fs::read_to_string(env.path().join(".veistra/locks/.gitignore")).unwrap(),
            "*\n"
        );
    }

    #[test]
    fn a_lock_of_a_dead_process_is_stale_and_removed() {
        let env = TempDir::new().unwrap();
        take(env.path(), "bed.blend", 12, 3000).unwrap();
        let file = lock_path(env.path(), "bed.blend").unwrap();
        assert!(file.is_file());
        assert_eq!(live_with(env.path(), "bed.blend", &table), None);
        assert!(!file.exists(), "the stale lock is removed by the reader");
    }

    #[test]
    fn a_reused_pid_with_another_start_time_is_stale() {
        let env = TempDir::new().unwrap();
        // Pid 10 now belongs to a process that started at 1000; this lock was
        // taken by an earlier pid 10 that started at 500.
        take(env.path(), "bed.blend", 10, 500).unwrap();
        assert_eq!(live_with(env.path(), "bed.blend", &table), None);
        // A start time read a second off is the same process.
        take(env.path(), "bed.blend", 10, 1001).unwrap();
        assert!(live_with(env.path(), "bed.blend", &table).is_some());
    }

    #[test]
    fn a_second_blender_on_the_same_file_is_refused_and_the_holder_is_answered_again() {
        let env = TempDir::new().unwrap();
        let first = take(env.path(), "bed.blend", 10, 1000).unwrap();
        let err = take(env.path(), "bed.blend", 11, 2000).unwrap_err();
        assert!(err.contains("already open"), "{err}");
        assert_eq!(take(env.path(), "bed.blend", 10, 1000).unwrap(), first);
    }

    #[test]
    fn release_leaves_another_holders_lock() {
        let env = TempDir::new().unwrap();
        let mine = take(env.path(), "bed.blend", 10, 1000).unwrap();
        let mut theirs = mine.clone();
        theirs.pid = 11;
        assert!(!release(env.path(), "bed.blend", &theirs));
        assert!(lock_path(env.path(), "bed.blend").unwrap().is_file());
        assert!(release(env.path(), "bed.blend", &mine));
        assert!(!lock_path(env.path(), "bed.blend").unwrap().exists());
        assert!(!release(env.path(), "bed.blend", &mine), "nothing left");
    }

    #[test]
    fn sweep_removes_stale_locks_and_answers_the_live_ones() {
        let env = TempDir::new().unwrap();
        take(env.path(), "props/bed.blend", 10, 1000).unwrap();
        take(env.path(), "old.blend", 12, 3000).unwrap();
        std::fs::write(env.path().join(".veistra/locks/junk.lock"), "not json").unwrap();
        let live = sweep_with(env.path(), &table);
        assert_eq!(
            live.iter().map(|l| l.file.as_str()).collect::<Vec<_>>(),
            ["props/bed.blend"]
        );
        assert!(!lock_path(env.path(), "old.blend").unwrap().exists());
        assert!(!env.path().join(".veistra/locks/junk.lock").exists());
        assert!(env.path().join(".veistra/locks/.gitignore").is_file());
    }

    #[test]
    fn this_process_reads_as_running_with_a_start_time() {
        let pid = std::process::id();
        let start = process_start(pid).expect("this test runs");
        let env = TempDir::new().unwrap();
        let lock = acquire(env.path(), "bed.blend", pid, Some("c1"), None).unwrap();
        assert_eq!(lock.process_start, start);
        assert!(live(env.path(), "bed.blend").is_some());
    }
}
