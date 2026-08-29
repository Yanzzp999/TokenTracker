//! Server lifecycle details that are easy to break silently: the port fallback
//! that OAuth depends on, the argument shapes passed to the bundled CLI, and the
//! log file handling that used to `panic!` and grow without bound.

use std::ffi::OsString;
use std::fs;
use std::net::TcpListener;
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokentracker_linux::server::{
    boot_id, dashboard_url, group_still_alive, leads_own_process_group, pick_available_port,
    process_start_time, rotate_log_if_oversized, serve_args, server_log_paths, server_record_dirs,
    server_record_name, stop_recorded_server, sync_args, ServerRecord, MAX_LOG_BYTES,
};

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "tokentracker-linux-{label}-{}-{unique}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("scratch dir should be creatable");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const PREFERRED_PORT: u16 = 17680;

// Held by every test here that binds a port *or forks*, because cargo runs them
// in parallel. Two races, both of which have actually fired:
//
//   - Both port tests bind PREFERRED_PORT. The free-port case drops its probe
//     before calling pick_available_port(), which is exactly the window the
//     fallback case spends holding that same port, so unserialized the
//     free-port case gets handed a fallback port.
//   - `fork` duplicates every open descriptor, and CLOEXEC only closes them at
//     `exec`, so a process spawned by one test holds a copy of whatever socket
//     another test has open in between. Both port tests re-bind a port they
//     just released, and that copy makes the re-bind EADDRINUSE.
//
// Poisoning is recovered from rather than propagated: one test panicking must
// not turn the others into further, misleading failures.
static PORT_GUARD: Mutex<()> = Mutex::new(());

fn port_guard() -> std::sync::MutexGuard<'static, ()> {
    PORT_GUARD.lock().unwrap_or_else(|e| e.into_inner())
}

#[test]
fn preferred_port_is_used_when_free() {
    let _serial = port_guard();
    // Only meaningful when nothing else on the machine holds 17680.
    let Ok(probe) = TcpListener::bind(("127.0.0.1", PREFERRED_PORT)) else {
        eprintln!("port {PREFERRED_PORT} is busy on this machine; skipping");
        return;
    };
    drop(probe);

    let port = pick_available_port().expect("a port should be available");
    assert_eq!(
        port, PREFERRED_PORT,
        "OAuth redirect URLs are registered against the fixed port, so it must be preferred"
    );
}

#[test]
fn port_selection_falls_back_when_the_preferred_port_is_taken() {
    let _serial = port_guard();
    // Hold the preferred port for the duration of the call.
    let Ok(holder) = TcpListener::bind(("127.0.0.1", PREFERRED_PORT)) else {
        eprintln!("port {PREFERRED_PORT} is busy on this machine; skipping");
        return;
    };

    let port = pick_available_port().expect("fallback port should be assigned");
    assert_ne!(
        port, PREFERRED_PORT,
        "must not report a port that is already held"
    );
    assert!(port > 0);
    TcpListener::bind(("127.0.0.1", port)).expect("fallback port should be bindable");

    drop(holder);
}

#[test]
fn dashboard_url_is_loopback_only() {
    // Binding to 127.0.0.1 rather than 0.0.0.0 keeps usage data off the LAN.
    assert_eq!(dashboard_url(17680), "http://127.0.0.1:17680");
    assert!(!dashboard_url(17680).contains("0.0.0.0"));
    assert!(!dashboard_url(17680).contains("localhost"));
}

#[test]
fn serve_args_disable_browser_launch_and_startup_sync() {
    let args = serve_args(Path::new("/opt/tokentracker/bin/tracker.js"), 34567);
    assert_eq!(
        args,
        vec![
            OsString::from("/opt/tokentracker/bin/tracker.js"),
            OsString::from("serve"),
            OsString::from("--port"),
            OsString::from("34567"),
            OsString::from("--no-open"),
            OsString::from("--no-sync"),
        ],
    );
}

#[test]
fn serve_args_carry_the_selected_port() {
    // A hardcoded port here would leave the webview pointing at a dead server
    // whenever the fallback path is taken.
    let args = serve_args(Path::new("/x/tracker.js"), 45678);
    let port_index = args
        .iter()
        .position(|arg| arg == &OsString::from("--port"))
        .expect("--port should be present");
    assert_eq!(args[port_index + 1], OsString::from("45678"));
}

#[test]
fn sync_args_scan_local_sources_without_publishing() {
    let args = sync_args(Path::new("/opt/tokentracker/bin/tracker.js"));
    assert_eq!(
        args,
        vec![
            OsString::from("/opt/tokentracker/bin/tracker.js"),
            OsString::from("sync"),
            OsString::from("--auto"),
            OsString::from("--background"),
            OsString::from("--all-local-sources"),
        ],
    );
    // Background sync must never publish to the cloud on the user's behalf.
    assert!(!args.contains(&OsString::from("--publish-account")));
}

#[test]
fn log_paths_prefer_xdg_state_home() {
    let paths = server_log_paths(
        Some(PathBuf::from("/home/u/.local/state")),
        Some(PathBuf::from("/home/u")),
    );

    assert_eq!(
        paths.first(),
        Some(&PathBuf::from(
            "/home/u/.local/state/tokentracker/server.log"
        ))
    );
    // /tmp is always the last resort so a read-only home never loses logging.
    assert_eq!(
        paths.last(),
        Some(&PathBuf::from("/tmp/tokentracker-server.log"))
    );
}

#[test]
fn log_paths_fall_back_to_home_then_tmp() {
    let paths = server_log_paths(None, Some(PathBuf::from("/home/u")));
    assert_eq!(
        paths,
        vec![
            PathBuf::from("/home/u/.local/state/tokentracker/server.log"),
            PathBuf::from("/tmp/tokentracker-server.log"),
        ]
    );
}

#[test]
fn log_paths_survive_a_missing_home() {
    let paths = server_log_paths(None, None);
    assert_eq!(paths, vec![PathBuf::from("/tmp/tokentracker-server.log")]);
}

#[test]
fn log_paths_do_not_duplicate_when_xdg_and_home_agree() {
    let paths = server_log_paths(
        Some(PathBuf::from("/home/u/.local/state")),
        Some(PathBuf::from("/home/u")),
    );
    let mut deduped = paths.clone();
    deduped.dedup();
    assert_eq!(paths.len(), deduped.len(), "got {paths:?}");
}

#[test]
fn small_logs_are_left_alone() {
    let temp = TempDir::new("log-small");
    let log = temp.path().join("server.log");
    fs::write(&log, b"a few lines\n").expect("write log");

    assert!(!rotate_log_if_oversized(&log, MAX_LOG_BYTES));
    assert_eq!(fs::read(&log).expect("log still there"), b"a few lines\n");
}

#[test]
fn oversized_logs_rotate_to_a_single_previous_generation() {
    let temp = TempDir::new("log-rotate");
    let log = temp.path().join("server.log");
    fs::write(&log, vec![b'x'; 64]).expect("write log");

    assert!(
        rotate_log_if_oversized(&log, 32),
        "a log over the limit should rotate"
    );

    let rotated = temp.path().join("server.log.1");
    assert!(rotated.exists(), "previous generation should be kept");
    assert_eq!(fs::read(&rotated).expect("rotated readable").len(), 64);
    assert!(!log.exists(), "the live log is recreated on next open");
}

#[test]
fn rotation_replaces_an_older_generation_so_growth_stays_bounded() {
    let temp = TempDir::new("log-bounded");
    let log = temp.path().join("server.log");
    fs::write(temp.path().join("server.log.1"), vec![b'o'; 8]).expect("old generation");
    fs::write(&log, vec![b'n'; 64]).expect("write log");

    assert!(rotate_log_if_oversized(&log, 32));

    // Exactly one previous generation, and it is the newer content.
    let rotated = fs::read(temp.path().join("server.log.1")).expect("rotated readable");
    assert_eq!(rotated.len(), 64);
    assert!(rotated.iter().all(|byte| *byte == b'n'));
    assert!(!temp.path().join("server.log.2").exists());
}

#[test]
fn rotating_a_missing_log_is_a_no_op() {
    let temp = TempDir::new("log-absent");
    assert!(!rotate_log_if_oversized(
        &temp.path().join("server.log"),
        MAX_LOG_BYTES
    ));
}

/// Guard against someone effectively disabling rotation by raising the cap to
/// absurdity, or making it so small the log is useless. Evaluated at compile
/// time because both sides are constants.
const _: () = {
    assert!(MAX_LOG_BYTES >= 1024 * 1024);
    assert!(MAX_LOG_BYTES <= 64 * 1024 * 1024);
};

#[test]
fn records_never_land_in_a_world_writable_directory() {
    let dirs = server_record_dirs(
        Some(PathBuf::from("/state")),
        Some(PathBuf::from("/home/u")),
    );

    assert_eq!(dirs[0], PathBuf::from("/state/tokentracker/servers"));
    assert_eq!(
        dirs[1],
        PathBuf::from("/home/u/.local/state/tokentracker/servers")
    );

    // No /tmp fallback, unlike the log: /tmp is writable by every account, so a
    // forged record there could make this user signal one of their own PIDs.
    assert!(dirs.iter().all(|dir| !dir.starts_with("/tmp")));
    assert!(server_log_paths(None, None)
        .iter()
        .any(|path| path.starts_with("/tmp")));
    assert!(server_record_dirs(None, None).is_empty());
}

#[test]
fn each_owner_gets_its_own_record_file() {
    // Two concurrent login sessions on one account each run an app instance,
    // so a shared filename would let one delete or overwrite the other's
    // record and strand its server permanently.
    assert_eq!(server_record_name(1234), "server-1234.json");
    assert_ne!(server_record_name(1234), server_record_name(5678));
}

#[test]
fn process_start_time_identifies_a_specific_process() {
    let own = std::process::id() as i32;
    let first = process_start_time(own).expect("our own start time is readable");

    // Stable across reads: this is what makes it usable as an identity, so a
    // recycled PID cannot be mistaken for the recorded process.
    assert_eq!(process_start_time(own), Some(first));

    // A PID that cannot exist has no start time, so nothing is ever signalled
    // on its behalf.
    assert_eq!(process_start_time(-1), None);
}

#[test]
fn a_record_is_bound_to_the_current_boot() {
    // Sandboxes and containers can hide /proc/sys/kernel/random/boot_id.
    // Production treats that as "record nothing, signal nothing", so absence is
    // a supported state rather than a test failure.
    let Some(id) = boot_id() else {
        return;
    };

    assert!(!id.is_empty());
    // Stable within a boot, so it can validate a persisted record; it changes
    // on reboot, which is what invalidates a stale one whose PID and
    // since-boot start tick could otherwise be matched by an unrelated process.
    assert_eq!(boot_id(), Some(id));
}

#[test]
fn only_real_group_leaders_can_be_signalled_by_group() {
    // kill(-1, sig) is POSIX's broadcast to every process the caller may
    // signal, so a record naming pid 1 must never reach the negated-pid path:
    // it would tear down the whole login session instead of one server.
    assert!(!leads_own_process_group(1));
    assert!(!leads_own_process_group(0));
    assert!(!leads_own_process_group(-1));

    // A pid that cannot exist leads no group either.
    assert!(!leads_own_process_group(i32::MAX));

    // The test binary is not a group leader (the shell that spawned it is), so
    // negating its pid would signal a group it does not own.
    let own = std::process::id() as i32;
    // SAFETY: getpgid(2) on our own pid.
    let pgid = unsafe { libc::getpgid(own) };
    assert_eq!(leads_own_process_group(own), pgid == own);
}

/// The case the whole mechanism exists for: `bin/tracker.js` re-executes itself
/// through `spawnSync` when a proxy is configured, so the process holding the
/// port is a grandchild. It can outlive the leader that SIGTERM kills, and a
/// reaper that watches only the recorded pid then reports success while the port
/// is still taken -- which sends startup to a random port and breaks OAuth.
#[test]
fn a_descendant_still_holding_the_port_outlives_the_leader() {
    // The subshell ignores SIGTERM and keeps listening; the leader takes the
    // default disposition and dies, exactly like a server whose child shuts down
    // slower than its parent.
    let Some(tree) = OrphanTree::spawn(
        "( trap ': > {signalled}' TERM; : > {ready}; while :; do sleep 1; done ) &",
    ) else {
        return;
    };

    // A full second before escalation: `kill` only queues SIGTERM, so a shorter
    // window lets SIGKILL beat the descendant's trap to the marker below.
    let recovered = stop_recorded_server(
        &tree.record(),
        Duration::from_secs(5),
        Duration::from_secs(1),
    );

    assert!(
        recovered,
        "the reap must report the port recovered only once nothing holds it"
    );
    assert!(
        tree.was_signalled(),
        "the descendant should have seen the group's SIGTERM before being killed"
    );
    assert!(
        port_is_bindable(tree.port),
        "the descendant kept port {}; reaping must wait for the whole process group, \
         not just the recorded leader, or startup silently falls back to a random port",
        tree.port
    );
}

/// A leader that has already exited leaves nothing that can identify its group:
/// its pgid is reusable once the group empties, and the recorded port is a fixed
/// number another instance may hold. Neither authorizes a signal. Pinned because
/// the tempting fix is to signal it anyway.
#[test]
fn a_leaderless_group_is_never_signalled() {
    let Some(tree) = OrphanTree::spawn(
        "( trap ': > {signalled}' TERM; : > {ready}; while :; do sleep 1; done ) &",
    ) else {
        return;
    };
    // Captured while the leader lives, like a record written before the crash.
    let record = tree.record();

    // SAFETY: a plain pid, not a group: only the leader dies, and the descendant
    // it spawned stays behind holding the port.
    unsafe {
        libc::kill(record.pid, libc::SIGKILL);
    }
    wait_for(Duration::from_secs(5), || {
        process_start_time(record.pid).is_none().then_some(())
    })
    .expect("the leader should be gone and reaped by init");

    let recovered =
        stop_recorded_server(&record, Duration::from_secs(2), Duration::from_millis(250));

    assert!(
        !recovered,
        "the port is still held, so nothing was recovered"
    );
    // The descendant survives SIGTERM by design, so survival proves nothing and
    // delivery itself is asserted on. Polled, not sampled once: a trap and a
    // SIGKILL teardown both land after `kill` has already returned.
    let breach = wait_for(Duration::from_millis(300), || {
        (tree.was_signalled() || port_is_bindable(tree.port)).then_some(())
    });
    assert!(
        breach.is_none(),
        "a group with no identifiable leader was signalled"
    );
}

/// A descendant that called `setsid()` is outside the group, so no group signal
/// can reach it. Nothing can be done about that here -- but claiming the port
/// came back when it did not is what made this failure invisible in the first
/// place, so the outcome has to be reported honestly.
#[test]
fn a_descendant_that_escaped_the_group_is_reported_rather_than_claimed_reaped() {
    // The escapee inherits fd 3 and gets its own session, so no group signal can
    // reach it. It exits on its own rather than being cleaned up by pid: killing
    // a pid read back from a file is the PID-reuse hazard the production code
    // goes to some length to avoid, and a test should not model it.
    let Some(tree) = OrphanTree::spawn("setsid --fork sh -c ': > {ready}; sleep 5';") else {
        return;
    };

    let recovered = stop_recorded_server(
        &tree.record(),
        Duration::from_secs(2),
        Duration::from_millis(250),
    );

    assert!(
        !recovered,
        "port {} is still held by a process outside the group, so the reap must not \
         report it recovered",
        tree.port
    );
}

#[test]
fn a_group_signal_is_never_aimed_at_the_whole_session() {
    // kill(-1, sig) is POSIX's broadcast to every process the caller may signal.
    // Whatever else changes, these must never look like a live group.
    assert!(!group_still_alive(1));
    assert!(!group_still_alive(0));
    assert!(!group_still_alive(-1));

    // This process is in some group, and that group is trivially non-empty.
    // SAFETY: getpgid(0) reports the caller's own group and cannot fail.
    let own_group = unsafe { libc::getpgid(0) };
    assert!(group_still_alive(own_group));
}

/// A server-shaped process tree, orphaned onto init the way a crashed app leaves
/// one behind, holding a real listening socket.
struct OrphanTree {
    pid: i32,
    port: u16,
    signalled: PathBuf,
    _scratch: TempDir,
    /// Held for as long as the tree owns its port, so the ephemeral port it
    /// takes cannot land on one `pick_available_port` has just released.
    _serial: std::sync::MutexGuard<'static, ()>,
}

impl OrphanTree {
    /// `descendant` is shell run by the leader before it settles into its own
    /// sleep loop; it inherits fd 3, the listening socket. It must touch
    /// `{ready}`, which is substituted with a path this waits for -- the leader
    /// holds the port from birth, so "the port is taken" says nothing about
    /// whether the descendant this test is about exists yet. Reaping before it
    /// is forked kills the leader alone and frees the port, which fails one of
    /// these tests and, worse, silently passes the other.
    ///
    /// Returns `None` where the tree cannot be built, which is a skip rather than
    /// a failure: `setsid` is util-linux, not POSIX.
    fn spawn(descendant: &str) -> Option<Self> {
        // Taken before the first fork, not just the first bind: see PORT_GUARD.
        let serial = port_guard();
        if !command_exists("setsid") {
            eprintln!("setsid is unavailable on this machine; skipping");
            return None;
        }

        let scratch = TempDir::new("orphan");
        let pidfile = scratch.path().join("leader.pid");
        let ready = scratch.path().join("descendant.ready");
        let signalled = scratch.path().join("descendant.sigterm");
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).expect("a scratch port should be bindable");
        let port = listener
            .local_addr()
            .expect("a bound listener has a local address")
            .port();

        // The socket rides in as stdin, so the tree holds the port with no
        // dependency on a helper binary. `exec 3<&0` first: POSIX hands an
        // asynchronous list `/dev/null` for stdin, so without the dup a
        // backgrounded descendant would silently lose the socket and the test
        // would pass for the wrong reason.
        let leader = format!(
            "exec 3<&0; echo $$ > {pidfile}; {descendant} while :; do sleep 1; done",
            pidfile = pidfile.display(),
            descendant = descendant
                .replace("{ready}", &ready.display().to_string())
                .replace("{signalled}", &signalled.display().to_string())
        );
        // `setsid` is invoked directly rather than through a shell: the script
        // has to reach the inner `sh` unexpanded, and `$$` inside a nested quoted
        // string would be substituted by the outer shell, recording the wrong
        // pid. `--fork` guarantees the parent exits, which orphans the tree onto
        // init -- without it a leader left as this test's child would linger as a
        // zombie, keep its `/proc/<pid>/stat`, and make a pid-only wait look
        // correct.
        let mut orphaner = Command::new("setsid")
            .arg("--fork")
            .arg("sh")
            .arg("-c")
            .arg(&leader)
            .stdin(Stdio::from(OwnedFd::from(listener)))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("setsid should be spawnable");
        orphaner
            .wait()
            .expect("setsid --fork should exit as soon as it has forked");

        let pid = wait_for(Duration::from_secs(5), || read_pid(&pidfile))
            .expect("the leader should record its pid");
        let tree = Self {
            pid,
            port,
            signalled,
            _scratch: scratch,
            _serial: serial,
        };
        wait_for(Duration::from_secs(5), || {
            (ready.exists() && !port_is_bindable(port) && leads_own_process_group(pid))
                .then_some(())
        })
        .expect("the descendant should exist, and the tree lead its own group and hold the port");
        Some(tree)
    }

    /// Whether the descendant has seen a SIGTERM -- which surviving one does not
    /// tell you.
    fn was_signalled(&self) -> bool {
        self.signalled.exists()
    }

    fn record(&self) -> ServerRecord {
        ServerRecord {
            pid: self.pid,
            port: self.port,
            start_time: process_start_time(self.pid).expect("a live pid has a start time"),
            boot_id: boot_id().expect("Linux exposes a boot id"),
            owner_pid: std::process::id() as i32,
            owner_start_time: process_start_time(std::process::id() as i32)
                .expect("this process has a start time"),
        }
    }
}

impl Drop for OrphanTree {
    /// SIGKILL whatever survived, so a failing assertion cannot leak a process
    /// tree that keeps its port for the rest of the run.
    fn drop(&mut self) {
        if group_still_alive(self.pid) {
            // SAFETY: the group has members, so its pgid is still reserved and
            // cannot have been recycled into a stranger's group.
            unsafe {
                libc::kill(-self.pid, libc::SIGKILL);
            }
        }
    }
}

fn command_exists(name: &str) -> bool {
    Command::new("sh")
        .arg("-c")
        .arg(format!("command -v {name}"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn read_pid(path: &Path) -> Option<i32> {
    fs::read_to_string(path).ok()?.trim().parse().ok()
}

fn port_is_bindable(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn wait_for<T>(timeout: Duration, mut ready: impl FnMut() -> Option<T>) -> Option<T> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(value) = ready() {
            return Some(value);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
