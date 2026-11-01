//! What a reference may reach. Every rule here is a refusal, and every refusal
//! is a sentence the person or agent can read.
//!
//! Three gates, in order: the path's spelling ([`check_relative`]), where it
//! really lands once symlinks and junctions are followed, and what kind of file
//! it is (secrets are never served, gitignored files are named but not read).

use super::fault::{Fault, Reason};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::Match;
use std::path::{Path, PathBuf};

/// Names Windows reserves in every directory, whatever the extension.
const DEVICE_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];
/// Longer relative paths are refused rather than handed to a long-path API.
const MAX_PATH_CHARS: usize = 1024;

/// Refuse a relative path whose spelling could escape the root or confuse
/// Windows: empty segments, `.` and `..`, drive letters, `\`, `:` (alternate
/// data streams), reserved device names, and trailing dots or spaces.
pub fn check_relative(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("the reference names no path".into());
    }
    if path.chars().count() > MAX_PATH_CHARS {
        return Err(format!("a path is at most {MAX_PATH_CHARS} characters"));
    }
    if path.contains('\\') || path.contains(':') {
        return Err(format!(
            "`{path}` must be relative to the project, with `/` separators and no drive"
        ));
    }
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(format!(
                "`{path}` must stay inside the project: no empty, `.` or `..` segments"
            ));
        }
        if segment.ends_with('.') || segment.ends_with(' ') {
            return Err(format!("`{segment}` ends in a dot or a space"));
        }
        let stem = segment.split('.').next().unwrap_or(segment);
        if DEVICE_NAMES.contains(&stem.to_ascii_lowercase().as_str()) {
            return Err(format!("`{segment}` is a reserved device name"));
        }
    }
    Ok(())
}

/// A path inside the root, as it really is on disk.
#[derive(Debug, Clone)]
pub struct Contained {
    /// The root, canonical.
    pub root: PathBuf,
    /// The target, canonical: every symlink and junction followed.
    pub abs: PathBuf,
    /// `abs` relative to `root`, `/`-separated. Differs from the path asked
    /// for when a link inside the project points elsewhere in it.
    pub rel: String,
}

/// Find `rel` under `root` and prove it is still there once links are
/// followed. Both sides are canonicalised, so a junction or symlink that
/// leads out of the project is refused, not followed.
pub fn contain(root: &Path, rel: &str) -> Result<Contained, Fault> {
    check_relative(rel).map_err(|e| Fault::new(Reason::BadUri, e))?;
    let root = std::fs::canonicalize(root)
        .map_err(|e| format!("the project folder cannot be read: {e}"))?;
    let abs = std::fs::canonicalize(root.join(rel)).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => Fault::new(
            Reason::Missing,
            format!("there is no `{rel}` in this project"),
        ),
        _ => format!("`{rel}` cannot be read: {e}").into(),
    })?;
    let inner = abs.strip_prefix(&root).map_err(|_| {
        Fault::new(
            Reason::Outside,
            format!("`{rel}` is a link that leads outside the project, so it is not followed"),
        )
    })?;
    let rel = inner
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/");
    Ok(Contained { root, abs, rel })
}

/// Whether a root-relative path ([`Contained::rel`]) is inside Veistra's context store.
pub fn inside_store(rel: &str) -> bool {
    rel.to_ascii_lowercase().starts_with(".veistra/context/")
}

/// Templates that look like `.env` files and hold no secrets by convention.
const ENV_TEMPLATES: &[&str] = &[".example", ".sample", ".template", ".dist", ".defaults"];
/// Folders whose contents are credentials or repository internals.
const SECRET_DIRS: &[&str] = &[
    ".git", ".ssh", ".aws", ".gnupg", ".azure", ".kube", ".docker",
];
/// Extensions of private keys and key stores.
const KEY_EXTENSIONS: &[&str] = &[
    "pem", "key", "p12", "pfx", "jks", "keystore", "p8", "ppk", "kdbx",
];
/// Whole file names that hold credentials.
const CREDENTIAL_NAMES: &[&str] = &[
    ".npmrc",
    ".pypirc",
    ".netrc",
    "_netrc",
    ".git-credentials",
    ".htpasswd",
    ".pgpass",
    ".my.cnf",
    "keystore.properties",
    "export_credentials.cfg",
    // Veistra's own: the bearer token for every MCP server it hosts.
    "mcp-endpoint.json",
    ".vault-token",
    "application_default_credentials.json",
    ".terraformrc",
    "terraform.rc",
    ".s3cfg",
    ".boto",
    ".dockercfg",
];

/// Which secrets rule, if any, a root-relative path falls under. The answer
/// is the rule's name, for the sentence that says why nothing was shown.
pub fn secret_rule(rel: &str) -> Option<&'static str> {
    let lower = rel.replace('\\', "/").to_ascii_lowercase();
    let mut segments: Vec<&str> = lower.split('/').filter(|s| !s.is_empty()).collect();
    let name = segments.pop()?;
    if segments.iter().any(|s| SECRET_DIRS.contains(s)) || SECRET_DIRS.contains(&name) {
        return Some("credential and repository folders (.git, .ssh, .aws and the like)");
    }
    let is_env =
        name == ".env" || name == ".envrc" || name.starts_with(".env.") || name.ends_with(".env");
    if is_env && !ENV_TEMPLATES.iter().any(|t| name.ends_with(t)) {
        return Some(".env files");
    }
    let ext = name.rsplit_once('.').map_or("", |(_, e)| e);
    if KEY_EXTENSIONS.contains(&ext) {
        return Some("private keys and key stores");
    }
    // `ssh-keygen -f` names keys anything; an `id_` name with no extension is
    // the usual shape of one.
    let ssh_key = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]
        .iter()
        .any(|k| name.starts_with(k))
        || (name.starts_with("id_") && !name.contains('.'));
    if ssh_key && !name.ends_with(".pub") {
        return Some("SSH private keys");
    }
    let service_account =
        name.starts_with("service-account") || name.starts_with("service_account");
    let credential = CREDENTIAL_NAMES.contains(&name)
        || (name == "hosts.yml" && segments.last() == Some(&"gh"))
        || (service_account && name.ends_with(".json"))
        || name.starts_with("credentials")
        || name.starts_with("secrets.")
        || name.starts_with("client_secret")
        || name.ends_with("kubeconfig")
        || name.contains(".tfvars")
        || name.contains(".tfstate");
    credential.then_some("credential files")
}

/// Which secrets rule a context item's title falls under. A title is free
/// text, so only one spelt like a file name, without spaces, is read as one:
/// `id_rsa` is a key's name, and "Credentials rotation plan" is prose.
pub fn title_rule(title: &str) -> Option<&'static str> {
    let title = title.trim();
    if title.chars().any(char::is_whitespace) {
        return None;
    }
    secret_rule(title)
}

/// Which secrets rule a file's first bytes fall under. A private key keeps
/// its header whatever the file is called, so a renamed key is still caught,
/// and so is one written into a JSON, YAML or env value.
pub fn secret_content(head: &[u8]) -> Option<&'static str> {
    let text = String::from_utf8_lossy(head);
    text.lines().any(key_line).then_some(KEYS)
}

/// The rule a private key falls under.
pub const KEYS: &str = "private keys and key stores";

/// Whether one line holds a private key: a PEM header, written alone or into
/// a value, a PuTTY header, or an age secret key.
pub fn key_line(line: &str) -> bool {
    let line = line.trim();
    line.starts_with("PuTTY-User-Key-File-") || pem_key_in(line) || age_key_in(line)
}

/// Whether `line` holds a private key's PEM header with the key after it: the
/// header ends the line, or an escaped line break follows it, as in a JSON
/// string. A header quoted in a sentence has prose after it instead.
fn pem_key_in(line: &str) -> bool {
    line.match_indices("-----BEGIN ").any(|(at, open)| {
        let rest = &line[at + open.len()..];
        let Some(end) = rest.find("-----") else {
            return false;
        };
        let label = &rest[..end];
        let after = &rest[end + "-----".len()..];
        (label.ends_with("PRIVATE KEY") || label.ends_with("PRIVATE KEY BLOCK"))
            && (after.is_empty() || after.starts_with("\\n") || after.starts_with("\\r\\n"))
    })
}

/// Whether `line` holds an age secret key, which is its prefix and then 58
/// characters of upper-case Bech32.
fn age_key_in(line: &str) -> bool {
    const PREFIX: &str = "AGE-SECRET-KEY-1";
    line.match_indices(PREFIX).any(|(at, _)| {
        let body = line[at + PREFIX.len()..].bytes();
        body.take_while(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
            .count()
            >= 58
    })
}

/// Whether gitignore patterns ignore case. Git's `core.ignorecase` is on by
/// default where the file system ignores case, which is Windows and macOS.
const IGNORE_CASE: bool = cfg!(any(windows, target_os = "macos"));

/// The ignore files that govern one folder: the root's (with
/// `.git/info/exclude`) and each one between it and the folder, outermost
/// first. Built once, then asked about any number of paths under the folder.
pub struct Ignores {
    levels: Vec<(PathBuf, Gitignore)>,
    root: PathBuf,
}

impl Ignores {
    /// The rules for `folder`, canonical and under the canonical `root`.
    pub fn for_folder(root: &Path, folder: &Path) -> Ignores {
        let mut chain: Vec<&Path> = folder
            .ancestors()
            .take_while(|d| d.starts_with(root))
            .collect();
        chain.reverse();
        let levels = chain
            .into_iter()
            .filter_map(|d| matcher(root, d).map(|m| (d.to_path_buf(), m)))
            .collect();
        Ignores {
            levels,
            root: root.to_path_buf(),
        }
    }

    /// Whether git would ignore `abs`. As in git, a folder that is excluded
    /// is never entered, so nothing under it can be re-included; below that,
    /// the deepest file with an opinion wins.
    pub fn ignored(&self, abs: &Path, is_dir: bool) -> bool {
        let mut above: Vec<&Path> = abs
            .ancestors()
            .skip(1)
            .take_while(|d| d.starts_with(&self.root) && *d != self.root)
            .collect();
        above.reverse();
        above.into_iter().any(|d| self.decide(d, true)) || self.decide(abs, is_dir)
    }

    fn decide(&self, path: &Path, is_dir: bool) -> bool {
        for (dir, rules) in self.levels.iter().rev() {
            if path == dir || !path.starts_with(dir) {
                continue;
            }
            match rules.matched(path, is_dir) {
                Match::Ignore(_) => return true,
                Match::Whitelist(_) => return false,
                Match::None => {}
            }
        }
        false
    }
}

/// The rules one folder's own files give, if it has any. A line that does not
/// parse costs that line, as in git, not the rest of the file.
fn matcher(root: &Path, dir: &Path) -> Option<Gitignore> {
    let mut builder = GitignoreBuilder::new(dir);
    builder.case_insensitive(IGNORE_CASE).ok()?;
    // Later files win a tie, so `.gitignore` goes after `info/exclude`.
    let mut files = Vec::new();
    if dir == root {
        files.extend(exclude_file(root));
    }
    files.push(dir.join(".gitignore"));
    let mut any = false;
    for file in files.iter().filter(|f| f.is_file()) {
        let _partial = builder.add(file);
        any = true;
    }
    any.then(|| builder.build().ok()).flatten()
}

/// The repository's `info/exclude` for the work tree at `root`. In a linked
/// worktree, which is what a cluster usually is, `.git` is a file naming the
/// worktree's own git dir. That dir's `commondir` names the shared one, which
/// holds `info/exclude`.
pub(crate) fn exclude_file(root: &Path) -> Option<PathBuf> {
    use std::io::Read as _;
    let dot_git = root.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git.join("info").join("exclude"));
    }
    // A pointer is one short line; a big file called `.git` is not one.
    let read_small = |path: &Path| -> Option<String> {
        let mut text = String::new();
        let file = std::fs::File::open(path).ok()?;
        file.take(4096).read_to_string(&mut text).ok()?;
        Some(text)
    };
    let pointer = read_small(&dot_git)?;
    let git_dir = root.join(
        pointer
            .lines()
            .find_map(|l| l.strip_prefix("gitdir:"))?
            .trim(),
    );
    let common = match read_small(&git_dir.join("commondir")) {
        Some(rel) => git_dir.join(rel.trim()),
        None => git_dir,
    };
    Some(common.join("info").join("exclude"))
}

/// Whether `abs` (canonical, under the canonical `root`) is gitignored.
/// One path's question; a folder listing builds [`Ignores`] once instead.
pub fn ignored(root: &Path, abs: &Path) -> bool {
    Ignores::for_folder(root, abs.parent().unwrap_or(root)).ignored(abs, abs.is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_project_paths_pass() {
        for ok in [
            "a.rs",
            "scripts/player.gd",
            "art/hero sheet.png",
            ".gitignore",
            "levels/v1.2/map.tscn",
            "console.log",
        ] {
            assert!(check_relative(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn spellings_that_leave_the_root_or_trip_windows_are_refused() {
        for bad in [
            "",
            "/etc/passwd",
            "a//b",
            "a/./b",
            "../x",
            "a/..",
            "C:/x",
            "a\\b",
            "file.txt:secret",
            "con",
            "aux.txt",
            "dir/COM1.log",
            "trailing.",
            "trailing ",
        ] {
            assert!(check_relative(bad).is_err(), "{bad:?} passed");
        }
        assert!(check_relative(&"a/".repeat(600)).is_err());
    }

    #[test]
    fn secrets_match_their_rule_and_templates_do_not() {
        let cases = [
            (".env", Some(".env files")),
            ("server/.env.production", Some(".env files")),
            ("deploy/prod.env", Some(".env files")),
            (".envrc", Some(".env files")),
            (".env.example", None),
            ("config/.env.sample", None),
            ("certs/server.PEM", Some("private keys and key stores")),
            (
                "android/release.keystore",
                Some("private keys and key stores"),
            ),
            (
                "home/.ssh/config",
                Some("credential and repository folders (.git, .ssh, .aws and the like)"),
            ),
            (
                ".git/config",
                Some("credential and repository folders (.git, .ssh, .aws and the like)"),
            ),
            ("keys/id_ed25519", Some("SSH private keys")),
            ("keys/id_ed25519.pub", None),
            ("keys/id_work", Some("SSH private keys")),
            ("keys/id_ecdsa_sk", Some("SSH private keys")),
            ("keys/id_work.pub", None),
            ("scripts/id_card.gd", None),
            ("ops/kubeconfig", Some("credential files")),
            ("ops/prod.kubeconfig", Some("credential files")),
            (".pgpass", Some("credential files")),
            ("home/.my.cnf", Some("credential files")),
            ("infra/terraform.tfstate.backup", Some("credential files")),
            ("infra/prod.tfvars.json", Some("credential files")),
            (".godot/export_credentials.cfg", Some("credential files")),
            ("client_secret_123.json", Some("credential files")),
            ("infra/prod.tfvars", Some("credential files")),
            (".npmrc", Some("credential files")),
            ("keys/id_rsa", Some("SSH private keys")),
            ("keys/id_dsa", Some("SSH private keys")),
            ("keys/id_ecdsa", Some("SSH private keys")),
            ("aws/credentials", Some("credential files")),
            ("config/credentials.yml.enc", Some("credential files")),
            ("config/secrets.toml", Some("credential files")),
            ("home/.config/gh/hosts.yml", Some("credential files")),
            ("ops/service-account-prod.json", Some("credential files")),
            ("ops/service_account.json", Some("credential files")),
            (".gitignore", None),
            ("scripts/environment.gd", None),
            ("docs/keys.md", None),
            ("docs/service-account-setup.md", None),
            ("ci/hosts.yml", None),
        ];
        for (path, rule) in cases {
            assert_eq!(secret_rule(path), rule, "{path}");
        }
    }

    /// Every entry in the rule tables, so a typo or a lost line in one of them
    /// turns the suite red.
    #[test]
    fn every_entry_in_the_secret_tables_is_withheld() {
        for dir in SECRET_DIRS {
            assert!(secret_rule(dir).is_some(), "{dir}");
            assert!(
                secret_rule(&format!("home/{dir}/config")).is_some(),
                "{dir}/config"
            );
        }
        for ext in KEY_EXTENSIONS {
            assert_eq!(
                secret_rule(&format!("certs/release.{ext}")),
                Some("private keys and key stores"),
                "{ext}"
            );
        }
        for name in CREDENTIAL_NAMES {
            assert_eq!(
                secret_rule(&format!("home/{name}")),
                Some("credential files"),
                "{name}"
            );
        }
        for template in ENV_TEMPLATES {
            assert_eq!(secret_rule(&format!(".env{template}")), None, "{template}");
        }
    }

    #[test]
    fn a_private_key_is_known_by_its_header() {
        let age = format!("AGE-SECRET-KEY-1{}\n", "QZ7".repeat(20));
        for key in [
            "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n",
            "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n  -----BEGIN EC PRIVATE KEY-----\n",
            "-----BEGIN OPENSSH PRIVATE KEY-----\r\nb3Bl\r\n",
            "-----BEGIN PGP PRIVATE KEY BLOCK-----\n",
            "PuTTY-User-Key-File-3: ssh-ed25519\n",
            // A service-account file: the key is one JSON string, escapes and all.
            r#"  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----\n","#,
            r#"{"cert": "-----BEGIN CERTIFICATE-----\nMIIB", "key": "-----BEGIN EC PRIVATE KEY-----\r\nMHc"}"#,
            "DEPLOY_KEY=\"-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----\"\n",
            r#"SSH_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE""#,
            "tls:\n  key: |\n    -----BEGIN ENCRYPTED PRIVATE KEY-----\n    MIIF\n",
            &age,
        ] {
            assert_eq!(
                secret_content(key.as_bytes()),
                Some("private keys and key stores"),
                "{key}"
            );
        }
        for plain in [
            "-----BEGIN CERTIFICATE-----\nMIIB\n",
            "-----BEGIN PUBLIC KEY-----\n",
            r#"{"cert": "-----BEGIN CERTIFICATE-----\nMIIB"}"#,
            "A key file starts with `-----BEGIN RSA PRIVATE KEY-----`.\n",
            "An age key starts AGE-SECRET-KEY-1 and is all capitals.\n",
            "",
        ] {
            assert_eq!(secret_content(plain.as_bytes()), None, "{plain}");
        }
    }

    fn write(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn contain_answers_with_the_real_path_and_refuses_what_is_missing() {
        let dir = tempfile::TempDir::new().unwrap();
        write(dir.path(), "a/b.txt", "x");
        let found = contain(dir.path(), "a/b.txt").unwrap();
        assert_eq!(found.rel, "a/b.txt");
        assert!(found.abs.starts_with(&found.root));
        let missing = contain(dir.path(), "a/missing.txt").unwrap_err();
        assert_eq!(missing.reason, Reason::Missing);
        assert!(missing.message.contains("no `a/missing.txt`"));
        let escape = contain(dir.path(), "../outside").unwrap_err();
        assert_eq!(escape.reason, Reason::BadUri);
    }

    #[test]
    fn the_deepest_gitignore_with_an_opinion_wins() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        write(&root, ".gitignore", "*.log\nbuild/\n");
        write(&root, "keep/.gitignore", "!wanted.log\n");
        write(&root, ".git/info/exclude", "local.cfg\n");
        for (rel, expected) in [
            ("debug.log", true),
            ("keep/wanted.log", false),
            ("keep/other.log", true),
            ("build/deep/out.bin", true),
            ("local.cfg", true),
            ("src/main.gd", false),
        ] {
            write(&root, rel, "x");
            assert_eq!(ignored(&root, &root.join(rel)), expected, "{rel}");
        }
    }

    #[test]
    fn a_linked_worktree_reads_the_shared_info_exclude() {
        let dir = tempfile::TempDir::new().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let (main, root) = (base.join("main"), base.join("main/.veistra/worktrees/wt"));
        write(&main, ".git/info/exclude", "local.cfg\n");
        write(&main, ".git/worktrees/wt/commondir", "../..\n");
        let git_dir = main.join(".git/worktrees/wt");
        write(&root, ".git", &format!("gitdir: {}\n", git_dir.display()));
        for (rel, expected) in [("local.cfg", true), ("src/main.gd", false)] {
            write(&root, rel, "x");
            assert_eq!(ignored(&root, &root.join(rel)), expected, "{rel}");
        }
        write(&root, ".git", "gitdir: ../../../.git/worktrees/wt\n");
        assert!(
            ignored(&root, &root.join("local.cfg")),
            "a relative gitdir is read from the work tree"
        );
    }

    #[test]
    fn an_excluded_folder_stays_excluded_and_a_bad_line_costs_only_itself() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        write(
            &root,
            ".gitignore",
            "private/\n!private/token.txt\n{a,b\nlocal.settings.json\n",
        );
        write(&root, "private/.gitignore", "!notes.md\n");
        for (rel, expected) in [
            ("private/token.txt", true),
            ("private/notes.md", true),
            ("local.settings.json", true),
            ("src/main.gd", false),
        ] {
            write(&root, rel, "x");
            assert_eq!(ignored(&root, &root.join(rel)), expected, "{rel}");
        }
        let listing = Ignores::for_folder(&root, &root.join("private"));
        assert!(listing.ignored(&root.join("private/notes.md"), false));
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn gitignore_ignores_case_where_the_file_system_does() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        write(&root, ".gitignore", "Build/\n*.LOG\n");
        for rel in ["build/out.bin", "debug.log"] {
            write(&root, rel, "x");
            assert!(ignored(&root, &root.join(rel)), "{rel}");
        }
    }
}
