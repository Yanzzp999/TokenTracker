use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::paths::RuntimePaths;

const READINESS_PATH: &str = "/functions/tokentracker-user-status";

/// How long to wait for an orphaned server to exit before giving up, and how
/// long to wait before escalating SIGTERM to SIGKILL.
const REAP_TIMEOUT: Duration = Duration::from_secs(3);
const REAP_ESCALATE_AFTER: Duration = Duration::from_millis(750);

/// The same, for a server this process is shutting down on its way out.
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
const STOP_ESCALATE_AFTER: Duration = Duration::from_secs(1);

/// How often either wait re-checks the process group.
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// How often the health monitor probes the server.
pub const HEALTH_CHECK_INTERVAL: Duration = Duration::from_secs(15);

/// How long to wait for a freshly spawned server to answer its readiness probe,
/// used for both the initial start and health-monitor restarts.
pub const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// Consecutive failures before triggering a restart.
pub const FAILURE_THRESHOLD: u32 = 3;

/// Maximum consecutive restart attempts before the monitor backs off.
pub const MAX_RESTARTS: u32 = 3;

/// Back-off after exhausting `MAX_RESTARTS` before retrying.
pub const RESTART_BACKOFF: Duration = Duration::from_secs(300);

/// Match the five-minute native background refresh cadence on macOS and Windows.
pub const BACKGROUND_SYNC_INTERVAL: Duration = Duration::from_secs(300);

#[derive(Debug)]
struct BackgroundSync {
    cancelled: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
    worker: Option<JoinHandle<()>>,
}

impl BackgroundSync {
    fn start(paths: RuntimePaths) -> Self {
        let cancelled = Arc::new(AtomicBool::new(false));
        let child = Arc::new(Mutex::new(None));
        let worker_cancelled = Arc::clone(&cancelled);
        let worker_child = Arc::clone(&child);
        let worker = thread::spawn(move || loop {
            if worker_cancelled.load(Ordering::Acquire) {
                break;
            }

            run_background_sync(&paths, &worker_child);

            let deadline = Instant::now() + BACKGROUND_SYNC_INTERVAL;
            while Instant::now() < deadline {
                if worker_cancelled.load(Ordering::Acquire) {
                    return;
                }
                thread::sleep(Duration::from_millis(250));
            }
        });

        Self {
            cancelled,
            child,
            worker: Some(worker),
        }
    }

    fn stop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        if let Ok(mut child) = self.child.lock() {
            stop_child(child.as_mut());
            *child = None;
        }
    }
}

#[derive(Debug)]
pub struct TokenTrackerServer {
    child: Child,
    url: String,
    port: u16,
    paths: RuntimePaths,
    background_sync: BackgroundSync,
}

/// Directories that may hold server records, most preferred first.
///
/// Deliberately excludes the `/tmp` fallback [`server_log_paths`] ends with:
/// that directory is writable by every account, so another user could plant a
/// forged record naming one of this user's PIDs and have the next launch signal
/// it. A log line lost when no private state directory exists is acceptable; a
/// signal sent on a stranger's say-so is not.
pub fn server_record_dirs(xdg_state_home: Option<PathBuf>, home: Option<PathBuf>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(state_home) = xdg_state_home {
        dirs.push(state_home.join("tokentracker").join("servers"));
    }
    if let Some(home) = home {
        let dir = home
            .join(".local")
            .join("state")
            .join("tokentracker")
            .join("servers");
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

/// One record per owning app process, rather than a single `server.json`.
///
/// Single-instance locking runs over the session D-Bus, so a second login
/// session on the same account starts a second app. A shared file would let
/// each session delete or overwrite the other's record, and the loser's server
/// could then never be reaped -- leaving port 17680 held and OAuth broken,
/// which is the failure this whole mechanism exists to prevent.
pub fn server_record_name(owner_pid: i32) -> String {
    format!("server-{owner_pid}.json")
}

/// Identity of a spawned server.
///
/// Deliberately *not* a filesystem path. An AppImage mounts itself at a fresh
/// `/tmp/.mount_XXXXXX` on every launch, so the orphan's `node` and `tracker.js`
/// paths never match the ones this launch resolved -- and the AppImage is the
/// only Linux artifact the release workflow builds.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ServerRecord {
    pub pid: i32,
    pub port: u16,
    /// Process start from `/proc/<pid>/stat`, pinning the record to one
    /// specific process so a recycled PID is never mistaken for it.
    pub start_time: u64,
    /// `/proc/sys/kernel/random/boot_id`. `start_time` counts ticks since boot
    /// and restarts from zero on every boot, so without this a record surviving
    /// an unclean shutdown could match an unrelated process that merely landed
    /// on the same PID at the same tick.
    pub boot_id: String,
    /// The app process that spawned this server, identified the same way.
    /// "Orphaned" means the owner is gone, not merely that the child is alive.
    pub owner_pid: i32,
    pub owner_start_time: u64,
}

/// The current boot's identifier, or `None` where the kernel does not expose
/// one -- in which case no record is written and nothing is ever signalled.
pub fn boot_id() -> Option<String> {
    std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .ok()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
}

/// Read field 22 (`starttime`) of `/proc/<pid>/stat`.
///
/// Parsed after the final `)` because field 2 is the executable name and may
/// itself contain spaces and parentheses.
pub fn process_start_time(pid: i32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after_comm = &stat[stat.rfind(')')? + 1..];
    after_comm.split_whitespace().nth(19)?.parse().ok()
}

/// True when `pid` is alive and is still the exact process described by
/// `record` -- the check that makes signalling PID-reuse-safe.
fn record_still_matches(record: &ServerRecord) -> bool {
    boot_id().is_some_and(|id| id == record.boot_id)
        && process_start_time(record.pid) == Some(record.start_time)
}

/// Whether `pid` leads its own process group, so `kill(-pid, ..)` targets
/// exactly that group and nothing else.
///
/// Rejects pid <= 1 before anything else: `kill(-1, sig)` is POSIX's broadcast
/// to *every* process the caller may signal, so a record naming pid 1 would
/// tear down the whole login session instead of one server.
pub fn leads_own_process_group(pid: i32) -> bool {
    if pid <= 1 {
        return false;
    }
    // SAFETY: getpgid(2) on a plain pid; returns -1 when the pid is gone.
    unsafe { libc::getpgid(pid) == pid }
}

/// Whether any process remains in the group led by `pgid`.
///
/// `kill(-pgid, 0)` asks about the *group*, so this stays true after the leader
/// exits while a descendant runs on -- which is the case that matters, because
/// the descendant is what holds the port. `EPERM` means members exist that this
/// process may not signal, which is still "alive" for the purpose of deciding
/// whether the port has been released.
///
/// Note the ordering property this relies on: a task closes its file
/// descriptors during exit, before it leaves its process group, so an empty
/// group is proof the listening socket is gone -- strictly stronger than
/// probing the port.
pub fn group_still_alive(pgid: i32) -> bool {
    if pgid <= 1 {
        return false;
    }
    // SAFETY: signal 0 runs kill(2)'s existence and permission checks without
    // delivering anything.
    if unsafe { libc::kill(-pgid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Whether `port` can be bound right now, i.e. nothing is listening on it.
fn port_is_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn owner_still_running(record: &ServerRecord) -> bool {
    process_start_time(record.owner_pid) == Some(record.owner_start_time)
}

fn record_dirs() -> Vec<PathBuf> {
    let xdg_state_home = std::env::var_os("XDG_STATE_HOME").map(PathBuf::from);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    server_record_dirs(xdg_state_home, home)
}

/// Persist the identity of a freshly spawned server.
fn record_server(pid: u32, port: u16) {
    let owner_pid = std::process::id() as i32;
    let (Some(start_time), Some(owner_start_time), Some(boot_id)) = (
        process_start_time(pid as i32),
        process_start_time(owner_pid),
        boot_id(),
    ) else {
        return;
    };
    let Ok(json) = serde_json::to_string(&ServerRecord {
        pid: pid as i32,
        port,
        start_time,
        boot_id,
        owner_pid,
        owner_start_time,
    }) else {
        return;
    };

    // Walk the whole candidate chain like `open_server_log`: settling for the
    // first candidate would silently record nothing when XDG_STATE_HOME is
    // read-only, leaving a later crash unrecoverable.
    for dir in record_dirs() {
        // 0700/0600 explicitly: a permissive umask (0002, or 0000) would
        // otherwise leave these group- or world-writable, letting another
        // account rewrite a victim-owned record in place -- the uid check in
        // `read_record` would still pass, and this process would then signal
        // whatever pid the forged record named.
        let _ = std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir);
        let written = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(dir.join(server_record_name(owner_pid)))
            .and_then(|mut file| file.write_all(json.as_bytes()));
        if written.is_ok() {
            return;
        }
    }
}

/// Remove only *this* process's record, never another session's.
fn clear_server_record() {
    let name = server_record_name(std::process::id() as i32);
    for dir in record_dirs() {
        let _ = std::fs::remove_file(dir.join(&name));
    }
}

/// Read a record, rejecting anything this user does not own.
fn read_record(path: &Path) -> Option<ServerRecord> {
    // O_NOFOLLOW plus fstat on the descriptor actually read: checking the path
    // and then reopening it would let a symlink be swapped in between the two.
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .ok()?;
    let metadata = file.metadata().ok()?;
    // SAFETY: getuid(2) is always successful.
    if !metadata.is_file() || metadata.uid() != unsafe { libc::getuid() } {
        return None;
    }
    // Writable by anyone but the owner means the contents cannot be trusted
    // even though the owner is right.
    if metadata.mode() & 0o022 != 0 {
        return None;
    }

    let mut raw = Vec::new();
    file.read_to_end(&mut raw).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// What became of one orphaned server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReapOutcome {
    pub pid: i32,
    pub port: u16,
    /// Whether the recorded port is actually bindable again. False means the
    /// next launch will fall back to a random port, which is worth saying out
    /// loud: it is precisely the state that breaks OAuth sign-in silently.
    pub port_recovered: bool,
}

/// Stop servers orphaned by an earlier crash.
///
/// A GTK/Wayland failure calls `_exit(1)` -- verified: an `atexit` hook
/// registered at startup never runs -- so neither `Drop` nor Tauri's
/// `RunEvent::ExitRequested` fires and the Node child survives its parent. An
/// orphan holding [`PREFERRED_PORT`] is not merely idle: it forces the next
/// launch onto a random port, which silently costs OAuth sign-in.
pub fn reap_orphaned_servers() -> Vec<ReapOutcome> {
    let mut reaped = Vec::new();

    for dir in record_dirs() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(record) = read_record(&path) else {
                continue;
            };
            // A live owner means another app instance is running this server,
            // not that it was stranded. Leave its record in place: deleting it
            // would strand that server permanently if it later crashed.
            if owner_still_running(&record) {
                continue;
            }
            let _ = std::fs::remove_file(&path);
            if record.pid <= 1 || record.pid == std::process::id() as i32 {
                continue;
            }
            if !record_still_matches(&record) {
                continue;
            }
            let port_recovered = stop_recorded_server(&record, REAP_TIMEOUT, REAP_ESCALATE_AFTER);
            reaped.push(ReapOutcome {
                pid: record.pid,
                port: record.port,
                port_recovered,
            });
        }
    }

    reaped
}

/// Signal one recorded server's process group and wait for the port to come
/// back. Returns whether it did.
///
/// Split out of [`reap_orphaned_servers`] so the wait can be exercised against a
/// real process tree without going through the on-disk records.
pub fn stop_recorded_server(
    record: &ServerRecord,
    timeout: Duration,
    escalate_after: Duration,
) -> bool {
    // Only a group leader may be negated; anything else would signal a group
    // this process never created.
    if !leads_own_process_group(record.pid) {
        return port_is_free(record.port);
    }

    // SAFETY: kill(2) on the negated pid signals the process group the server
    // leads, confirmed directly above.
    unsafe {
        libc::kill(-record.pid, libc::SIGTERM);
    }
    // Signalling is not enough: the listening socket outlives the signal, so
    // returning here would let `pick_available_port` still find PREFERRED_PORT
    // taken and fall back to a random one -- exactly the OAuth failure this is
    // meant to prevent.
    if !wait_for_exit(record, timeout, escalate_after) {
        return false;
    }
    // The group is gone, which normally means the socket is closed with it. A
    // descendant that called setsid() would have left the group and survived the
    // signal, so the port is checked rather than assumed: reporting a recovery
    // that did not happen is how this failure stayed invisible before.
    port_is_free(record.port)
}

/// Poll until the recorded server's process *group* is empty, escalating to
/// SIGKILL after `escalate_after`. Returns whether it emptied within `timeout`;
/// bounded, because a process that never exits must not block startup.
///
/// Waiting on the group rather than on `record.pid` is the point. `bin/tracker.js`
/// re-executes itself through `spawnSync` when a proxy is configured, so the
/// process holding the port is a grandchild, and it can outlive the leader that
/// SIGTERM kills. Returning when the leader died would report the port recovered
/// while a descendant still listens on it.
fn wait_for_exit(record: &ServerRecord, timeout: Duration, escalate_after: Duration) -> bool {
    let start = Instant::now();
    let deadline = start + timeout;
    let escalate_at = start + escalate_after;
    let mut escalated = false;

    loop {
        if !group_still_alive(record.pid) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        if !escalated && Instant::now() >= escalate_at {
            // SAFETY: the group has been observed alive on every iteration since
            // the SIGTERM that opened this wait -- the loop returns the instant
            // it is not -- and the kernel keeps a pid number reserved while it
            // is still some group's pgid. So `-record.pid` cannot have been
            // freed and recycled into a stranger's group underneath us.
            //
            // `leads_own_process_group` is deliberately not rechecked here: once
            // the leader exits it can never hold again, and requiring it is what
            // let a surviving descendant keep the port.
            unsafe {
                libc::kill(-record.pid, libc::SIGKILL);
            }
            escalated = true;
        }
        thread::sleep(EXIT_POLL_INTERVAL);
    }
}

impl TokenTrackerServer {
    pub fn start(paths: RuntimePaths) -> Result<Self, String> {
        // Before picking a port: an orphan from an earlier crash holding
        // PREFERRED_PORT would otherwise push this launch onto a random port
        // and silently break OAuth sign-in.
        for outcome in reap_orphaned_servers() {
            let ReapOutcome {
                pid,
                port,
                port_recovered,
            } = outcome;
            if port_recovered {
                eprintln!(
                    "[TokenTracker] stopped an orphaned server from an earlier run \
                     (pid {pid}, port {port} released)"
                );
            } else {
                eprintln!(
                    "[TokenTracker] an orphaned server (pid {pid}) still holds port {port}; \
                     this launch will fall back to a random port and OAuth sign-in may fail"
                );
            }
        }

        let port = pick_available_port()?;
        let url = dashboard_url(port);

        let args = serve_args(&paths.tracker, port);
        let mut child = node_command(&paths.node)
            .args(&args)
            // Own process group: `bin/tracker.js` re-executes itself through
            // `spawnSync` when a proxy is configured, so the process actually
            // holding the port is a grandchild. Signalling the group reaches it;
            // signalling this pid alone would leave it on 17680.
            .process_group(0)
            .stdout(Stdio::null())
            .stderr(server_log_stdio())
            .spawn()
            .map_err(|error| format!("failed to start TokenTracker server: {error}"))?;
        record_server(child.id(), port);

        wait_for_server_ready(port, READY_TIMEOUT).inspect_err(|_| {
            // Group first, record second: `stop_child` reaches a proxy
            // relaunch's grandchild, and if it somehow fails the record must
            // still be on disk for the next launch to reap.
            stop_child(Some(&mut child));
            clear_server_record();
        })?;

        let background_sync = BackgroundSync::start(paths.clone());

        Ok(Self {
            child,
            url,
            port,
            paths,
            background_sync,
        })
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Returns `true` if the child process has not exited yet.
    ///
    /// Deliberately separate from the HTTP readiness probe: the health monitor
    /// calls this under the global server mutex but runs [`probe_server_http`]
    /// after releasing it, so a hung socket never blocks app shutdown.
    pub fn is_process_alive(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(Some(_)) => false,
            Ok(None) => true,
            Err(_) => false,
        }
    }

    /// Kill the current server process and start a new one on the same port.
    ///
    /// Returns after spawning the replacement process. Readiness polling is
    /// handled by the health monitor after it releases the global server mutex,
    /// so app shutdown never waits for the full readiness timeout.
    pub fn restart_process(&mut self) -> Result<(), String> {
        // Group, not just the leader: with a proxy relaunch the listener is a
        // grandchild, and leaving it alive means the replacement cannot bind
        // the same port.
        stop_child(Some(&mut self.child));

        // Brief pause for the OS to release the port.
        thread::sleep(Duration::from_millis(500));

        let log_file = open_server_log().map(|mut file| {
            let _ = writeln!(file, "\n--- server restart ---");
            file
        });

        let args = serve_args(&self.paths.tracker, self.port);
        self.child = node_command(&self.paths.node)
            .args(&args)
            .process_group(0)
            .stdout(Stdio::null())
            .stderr(log_file.map_or_else(Stdio::null, Stdio::from))
            .spawn()
            .map_err(|error| format!("failed to restart server: {error}"))?;
        record_server(self.child.id(), self.port);

        Ok(())
    }

    pub fn stop(&mut self) {
        self.background_sync.stop();
        clear_server_record();
        stop_child(Some(&mut self.child));
    }
}

impl Drop for TokenTrackerServer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Rotate the server log once it exceeds this size, keeping a single previous
/// generation. The log is append-only otherwise, so without this it grows
/// without bound for the lifetime of the install.
pub const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// Candidate log paths in preference order: `$XDG_STATE_HOME/tokentracker/`,
/// then `$HOME/.local/state/tokentracker/`, then `/tmp`.
pub fn server_log_paths(xdg_state_home: Option<PathBuf>, home: Option<PathBuf>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(state_home) = xdg_state_home {
        paths.push(state_home.join("tokentracker").join("server.log"));
    }
    if let Some(home) = home {
        let path = home
            .join(".local")
            .join("state")
            .join("tokentracker")
            .join("server.log");
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths.push(PathBuf::from("/tmp").join("tokentracker-server.log"));
    paths
}

/// Move an oversized log aside so the live file restarts empty.
///
/// Returns `true` when rotation happened. Keeping one `.1` generation bounds
/// total on-disk usage at roughly `2 * max_bytes`. If the rename fails (for
/// example a read-only directory) the live file is truncated instead, so size
/// stays bounded either way.
pub fn rotate_log_if_oversized(path: &Path, max_bytes: u64) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if metadata.len() <= max_bytes {
        return false;
    }

    let rotated = path.with_extension("log.1");
    if std::fs::rename(path, &rotated).is_ok() {
        return true;
    }

    OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)
        .is_ok()
}

/// Open (or create) a log file for the Node server's stderr output.
///
/// Returns `None` when no candidate path is writable; callers fall back to
/// discarding output rather than aborting the app, because losing diagnostics
/// is not a reason to refuse to start.
fn open_server_log() -> Option<std::fs::File> {
    let xdg_state_home = std::env::var_os("XDG_STATE_HOME").map(PathBuf::from);
    let home = std::env::var_os("HOME").map(PathBuf::from);

    for path in server_log_paths(xdg_state_home, home) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        rotate_log_if_oversized(&path, MAX_LOG_BYTES);
        if let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) {
            return Some(file);
        }
    }

    None
}

/// Stderr sink for spawned Node processes, degrading to `/dev/null` when no log
/// file can be opened.
fn server_log_stdio() -> Stdio {
    match open_server_log() {
        Some(file) => Stdio::from(file),
        None => Stdio::null(),
    }
}

pub fn dashboard_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// OAuth (Google/GitHub) redirects to `http://127.0.0.1:<port>/auth/callback`,
/// which must be in InsForge's allowed-redirect-URL list.  Prefer a fixed port
/// registered alongside the macOS (:7680) and Windows (:17680) apps.  Falls
/// back to an OS-assigned free port if the preferred one is already in use
/// (email login still works; OAuth needs the fixed port).
const PREFERRED_PORT: u16 = 17680;

pub fn pick_available_port() -> Result<u16, String> {
    if let Ok(listener) = TcpListener::bind(("127.0.0.1", PREFERRED_PORT)) {
        let port = listener
            .local_addr()
            .map_err(|error| format!("failed to read reserved local port: {error}"))?
            .port();
        drop(listener);
        return Ok(port);
    }

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("failed to reserve local port: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("failed to read reserved local port: {error}"))?
        .port();
    drop(listener);
    Ok(port)
}

/// Base command for every Node process the app spawns. Marks the process as
/// app-shell `linux` so daily telemetry heartbeats don't report as `cli`.
pub fn node_command(node: &Path) -> Command {
    let mut command = Command::new(node);
    command.env("TOKENTRACKER_APP_SHELL", "linux");
    command
}

pub fn serve_args(tracker: &Path, port: u16) -> Vec<OsString> {
    vec![
        tracker.as_os_str().to_os_string(),
        OsString::from("serve"),
        OsString::from("--port"),
        OsString::from(port.to_string()),
        OsString::from("--no-open"),
        OsString::from("--no-sync"),
    ]
}

pub fn sync_args(tracker: &Path) -> Vec<OsString> {
    vec![
        tracker.as_os_str().to_os_string(),
        OsString::from("sync"),
        OsString::from("--auto"),
        OsString::from("--background"),
        OsString::from("--all-local-sources"),
    ]
}

fn run_background_sync(paths: &RuntimePaths, child_slot: &Mutex<Option<Child>>) {
    let mut child = match child_slot.lock() {
        Ok(child) => child,
        Err(_) => return,
    };

    if let Some(current) = child.as_mut() {
        match current.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    eprintln!("[TokenTracker] background sync exited with {status}");
                }
                *child = None;
            }
            Ok(None) => return,
            Err(error) => {
                eprintln!("[TokenTracker] failed to inspect background sync: {error}");
                stop_child(Some(current));
                *child = None;
            }
        }
    }

    let args = sync_args(&paths.tracker);
    match node_command(&paths.node)
        .args(args)
        // Own group, like the server spawns: `stop_child` signals by group, and
        // a plain pid there would name a group this process never created.
        .process_group(0)
        .stdout(Stdio::null())
        .stderr(server_log_stdio())
        .spawn()
    {
        Ok(process) => *child = Some(process),
        Err(error) => eprintln!("[TokenTracker] failed to start background sync: {error}"),
    }
}

fn stop_child(child: Option<&mut Child>) {
    let Some(child) = child else {
        return;
    };
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }

    // Same grandchild problem as the reaper: killing only the leader leaves a
    // proxy-relaunched server holding the port. Every child spawned here uses
    // `process_group(0)`, but check rather than assume -- negating a pid that
    // leads no group would signal one this process never created.
    let pgid = child.id() as i32;
    if leads_own_process_group(pgid) {
        // SAFETY: kill(2) on the group this child leads.
        unsafe {
            libc::kill(-pgid, libc::SIGTERM);
        }

        // Wait on the group, not on the leader. Waiting for `try_wait` alone
        // returns as soon as the leader dies, and a descendant that shuts down
        // more slowly then survives with the port. The leader is reaped inside
        // the loop because a zombie is still a group member, so leaving it
        // unreaped would make the group look alive until the deadline.
        let deadline = Instant::now() + STOP_TIMEOUT;
        let escalate_at = Instant::now() + STOP_ESCALATE_AFTER;
        let mut escalated = false;
        loop {
            let _ = child.try_wait();
            if !group_still_alive(pgid) || Instant::now() >= deadline {
                break;
            }
            if !escalated && Instant::now() >= escalate_at {
                // SAFETY: the group has been alive on every iteration since the
                // SIGTERM above, and a pid stays reserved while it is still some
                // group's pgid, so this cannot reach a recycled pid's group.
                unsafe {
                    libc::kill(-pgid, libc::SIGKILL);
                }
                escalated = true;
            }
            thread::sleep(EXIT_POLL_INTERVAL);
        }
    }

    let _ = child.kill();
    let _ = child.wait();
}

pub fn wait_for_server_ready(port: u16, timeout: Duration) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if probe_server_http(port).is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "TokenTracker server did not become ready on port {port} within {timeout:?}"
    ))
}

/// Single-shot readiness probe. Public so the health monitor can run it
/// *outside* the global server mutex.
pub fn probe_server_http(port: u16) -> Result<(), String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|error| format!("connect failed: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| format!("failed to set read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| format!("failed to set write timeout: {error}"))?;

    let request = format!(
        "GET {READINESS_PATH} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("request failed: {error}"))?;
    let _ = stream.shutdown(Shutdown::Write);

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| format!("read failed: {error}"))?;

    let status_line = response.lines().next().unwrap_or_default();
    if status_line.starts_with("HTTP/1.1 200") || status_line.starts_with("HTTP/1.0 200") {
        Ok(())
    } else {
        Err(format!(
            "unexpected readiness response: {}",
            if status_line.is_empty() {
                "<empty>"
            } else {
                status_line
            }
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dashboard_url_uses_loopback_http() {
        assert_eq!(dashboard_url(45678), "http://127.0.0.1:45678");
    }

    #[test]
    fn node_command_marks_the_linux_app_shell() {
        let command = node_command(Path::new("/opt/tokentracker/node"));
        let shell = command
            .get_envs()
            .find(|(key, _)| *key == "TOKENTRACKER_APP_SHELL")
            .and_then(|(_, value)| value);
        assert_eq!(shell, Some("linux".as_ref()));
    }

    #[test]
    fn serve_args_disable_browser_and_startup_sync() {
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
    fn pick_available_port_returns_nonzero_port() {
        let port = pick_available_port().expect("port should be available");
        assert!(port > 0);
    }

    #[test]
    fn probe_server_http_accepts_http_200() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("listener should bind");
        let port = listener.local_addr().expect("listener addr").port();

        let handle = thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("connection should be accepted");
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request);
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                .expect("response should write");
        });

        probe_server_http(port).expect("200 response should be ready");
        handle.join().expect("server thread should join");
    }
}
