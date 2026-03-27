use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

fn new_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

fn default_theme() -> String { "auto".to_string() }

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Settings {
    #[serde(default)]
    pub chdman_path: String,
    #[serde(default = "default_theme")]
    pub theme: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self { chdman_path: String::new(), theme: default_theme() }
    }
}

#[derive(Serialize, Deserialize, Clone)]
struct ChdmanOutput {
    stream: String,
    line: String,
}

pub struct AppState {
    pub running_pid: Mutex<Option<u32>>,
    pub cancel_flag: Arc<AtomicBool>,
}

/// Returns the directory containing the ROMCruncher executable.
/// All persistent data (settings, temp files) lives here so the app is portable.
fn exe_dir() -> Result<std::path::PathBuf, String> {
    std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or_else(|| "Could not determine executable directory".to_string())
        .map(|p| p.to_path_buf())
}

fn get_settings_path() -> Result<std::path::PathBuf, String> {
    Ok(exe_dir()?.join("settings.json"))
}

fn load_settings() -> Result<Settings, String> {
    let path = get_settings_path()?;
    if !path.exists() {
        return Ok(Settings::default());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_settings() -> Result<Settings, String> {
    load_settings()
}

#[tauri::command]
fn save_settings(settings: Settings) -> Result<(), String> {
    let path = get_settings_path()?;
    let content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// chdman output reading
// ---------------------------------------------------------------------------

/// Parse a progress percentage from a chdman output line.
/// chdman writes lines like "Creating CHD:  43.2% complete..." to stderr,
/// terminated with \r so they overwrite each other in a terminal.
fn parse_chdman_progress(line: &str) -> Option<u32> {
    let pct_pos = line.find('%')?;
    let before = line[..pct_pos].trim_end();
    let start = before
        .rfind(|c: char| !c.is_ascii_digit() && c != '.')
        .map(|i| i + 1)
        .unwrap_or(0);
    before[start..]
        .parse::<f32>()
        .ok()
        .map(|f| f.clamp(0.0, 100.0) as u32)
}

/// Spawn a thread that reads from `reader`, splitting on both \r and \n,
/// and emits `chdman-output` (and `chdman-progress` when a percentage is found).
/// Touches `last_activity` on every line so the stall watchdog can detect real output.
fn spawn_output_reader<R: Read + Send + 'static>(
    reader: R,
    app: AppHandle,
    stream: &'static str,
    last_activity: Arc<Mutex<Instant>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf_reader = std::io::BufReader::new(reader);
        let mut line_bytes: Vec<u8> = Vec::new();
        let mut byte = [0u8; 1];

        loop {
            match buf_reader.read(&mut byte) {
                Ok(0) | Err(_) => {
                    if !line_bytes.is_empty() {
                        emit_chdman_line(&app, stream, &line_bytes, &last_activity);
                    }
                    break;
                }
                Ok(_) => match byte[0] {
                    b'\r' | b'\n' => {
                        if !line_bytes.is_empty() {
                            emit_chdman_line(&app, stream, &line_bytes, &last_activity);
                            line_bytes.clear();
                        }
                    }
                    b => line_bytes.push(b),
                },
            }
        }
    })
}

fn emit_chdman_line(app: &AppHandle, stream: &str, bytes: &[u8], last_activity: &Arc<Mutex<Instant>>) {
    *last_activity.lock().unwrap() = Instant::now();
    let line = String::from_utf8_lossy(bytes).to_string();
    if let Some(pct) = parse_chdman_progress(&line) {
        app.emit("chdman-progress", pct).ok();
        // Progress lines are shown via the progress bar; skip the output log.
        return;
    }
    app.emit(
        "chdman-output",
        ChdmanOutput { stream: stream.into(), line },
    )
    .ok();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn run_chdman(
    app: AppHandle,
    state: State<'_, AppState>,
    args: Vec<String>,
) -> Result<i32, String> {
    state.cancel_flag.store(false, Ordering::Relaxed);
    let settings = load_settings()?;
    if settings.chdman_path.is_empty() {
        return Err("chdman path is not configured. Go to Settings to set it.".to_string());
    }

    let mut child = new_command(&settings.chdman_path)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch chdman: {}", e))?;

    let child_pid = child.id();
    *state.running_pid.lock().unwrap() = Some(child_pid);
    // Share the PID with the watchdog thread via an Arc.
    let shared_pid: Arc<Mutex<Option<u32>>> = Arc::new(Mutex::new(Some(child_pid)));

    // Shared timestamp touched by output readers and the stall watchdog.
    let last_activity: Arc<Mutex<Instant>> = Arc::new(Mutex::new(Instant::now()));

    let stdout_thread = spawn_output_reader(child.stdout.take().unwrap(), app.clone(), "stdout", last_activity.clone());
    let stderr_thread = spawn_output_reader(child.stderr.take().unwrap(), app.clone(), "stderr", last_activity.clone());

    // Output file path for size-growth monitoring (present on create/extract/convert, absent on info/verify).
    let output_path = args.windows(2)
        .find(|w| w[0] == "-o")
        .map(|w| std::path::PathBuf::from(&w[1]));

    // Watchdog: kill the process if there is no output AND no file growth for 60 seconds.
    const STALL_SECS: u64 = 60;
    let done_flag = Arc::new(AtomicBool::new(false));
    let watchdog = {
        let done_flag    = done_flag.clone();
        let cancel_flag  = state.cancel_flag.clone();
        let running_pid  = shared_pid.clone();
        let last_activity = last_activity.clone();
        let app          = app.clone();
        std::thread::spawn(move || {
            let mut last_file_size: u64 = 0;
            loop {
                // Sleep in short bursts so we can respond quickly to done/cancel.
                for _ in 0..10 {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    if done_flag.load(Ordering::Relaxed) || cancel_flag.load(Ordering::Relaxed) {
                        return;
                    }
                }
                // Treat output file growth as activity.
                if let Some(ref path) = output_path {
                    if let Ok(meta) = std::fs::metadata(path) {
                        let size = meta.len();
                        if size > last_file_size {
                            last_file_size = size;
                            *last_activity.lock().unwrap() = Instant::now();
                        }
                    }
                }
                // Kill if nothing has happened for STALL_SECS.
                if last_activity.lock().unwrap().elapsed().as_secs() >= STALL_SECS {
                    app.emit("chdman-output", ChdmanOutput {
                        stream: "error".into(),
                        line: format!("chdman stalled — no progress for {}s, killing process", STALL_SECS),
                    }).ok();
                    if let Some(pid) = *running_pid.lock().unwrap() {
                        let pid_str = pid.to_string();
                        #[cfg(target_os = "windows")]
                        { new_command("taskkill").args(["/F", "/PID", &pid_str]).spawn().ok(); }
                        #[cfg(not(target_os = "windows"))]
                        { new_command("kill").args(["-9", &pid_str]).spawn().ok(); }
                    }
                    return;
                }
            }
        })
    };

    stdout_thread.join().ok();
    stderr_thread.join().ok();

    // Signal the watchdog to exit before waiting on the child.
    done_flag.store(true, Ordering::Relaxed);
    watchdog.join().ok();

    let status = child.wait().map_err(|e| e.to_string())?;
    *state.running_pid.lock().unwrap() = None;

    let code = status.code().unwrap_or(-1);
    app.emit("chdman-done", code).ok();
    Ok(code)
}

#[tauri::command]
async fn scan_folder(dir: String, extensions: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::Path::new(&dir);
        let mut files: Vec<String> = std::fs::read_dir(path)
            .map_err(|e| e.to_string())?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                let p = entry.path();
                if !p.is_file() { return None; }
                let ext = p.extension()?.to_string_lossy().to_lowercase();
                if extensions.iter().any(|e| e.to_lowercase() == ext) {
                    Some(p.to_string_lossy().to_string())
                } else {
                    None
                }
            })
            .collect();
        files.sort();
        Ok(files)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Archive extraction
// ---------------------------------------------------------------------------

/// Primary disc image extensions to surface from inside an archive.
/// Companion files (.bin, .sub, etc.) are extracted too so chdman can find them,
/// but only these "entry point" extensions are returned to the UI.
const IMAGE_EXTS: &[&str] = &["cue", "gdi", "iso", "img", "raw"];

#[derive(Serialize, Deserialize)]
pub struct ArchiveContents {
    pub temp_dir: String,
    pub files: Vec<String>,
}

fn collect_images(dir: &std::path::Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    let mut found: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let p = e.path();
            if !p.is_file() { return None; }
            let ext = p.extension()?.to_string_lossy().to_lowercase();
            if IMAGE_EXTS.contains(&ext.as_str()) {
                Some(p.to_string_lossy().to_string())
            } else {
                None
            }
        })
        .collect();
    found.sort();
    found
}

fn unique_temp_dir() -> Result<std::path::PathBuf, String> {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = exe_dir()?.join("temp").join(format!("tmp_{n}"));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
async fn extract_archive(
    app: AppHandle,
    state: State<'_, AppState>,
    archive_path: String,
) -> Result<ArchiveContents, String> {
    state.cancel_flag.store(false, Ordering::Relaxed);
    let cancel = Arc::clone(&state.cancel_flag);

    let temp_dir = unique_temp_dir()?;
    let temp_dir_clone = temp_dir.clone();

    let ext = std::path::Path::new(&archive_path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
        .to_string();

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let src = std::path::Path::new(&archive_path);
        match ext.as_str() {
            "zip" => {
                let file = std::fs::File::open(src).map_err(|e| e.to_string())?;
                let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
                let total = archive.len();

                // Sum uncompressed sizes for byte-accurate progress.
                let mut total_bytes: u64 = 0;
                for i in 0..total {
                    if let Ok(e) = archive.by_index(i) {
                        if !e.is_dir() { total_bytes += e.size(); }
                    }
                }

                let mut extracted_bytes: u64 = 0;
                let mut last_pct: u32 = 0;

                for i in 0..total {
                    if cancel.load(Ordering::Relaxed) {
                        return Err("Cancelled".to_string());
                    }
                    let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
                    let outpath = match entry.enclosed_name() {
                        Some(name) => temp_dir_clone.join(name),
                        None => continue,
                    };
                    if entry.is_dir() {
                        std::fs::create_dir_all(&outpath).ok();
                    } else {
                        if let Some(parent) = outpath.parent() {
                            std::fs::create_dir_all(parent).ok();
                        }
                        let mut outfile = std::fs::File::create(&outpath)
                            .map_err(|e| e.to_string())?;
                        // Copy in chunks, checking cancel flag and updating progress.
                        let mut buf = [0u8; 65536];
                        loop {
                            if cancel.load(Ordering::Relaxed) {
                                return Err("Cancelled".to_string());
                            }
                            let n = entry.read(&mut buf).map_err(|e| e.to_string())?;
                            if n == 0 { break; }
                            outfile.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                            extracted_bytes += n as u64;
                            if total_bytes > 0 {
                                let pct = ((extracted_bytes * 100) / total_bytes).min(100) as u32;
                                if pct != last_pct {
                                    last_pct = pct;
                                    app.emit("extract-progress", pct).ok();
                                }
                            }
                        }
                    }
                }
            }
            "7z" => {
                // sevenz-rust doesn't expose per-entry callbacks; emit indeterminate signal.
                app.emit("extract-progress", serde_json::Value::Null).ok();
                sevenz_rust::decompress_file(src, &temp_dir_clone)
                    .map_err(|e| e.to_string())?;
                if cancel.load(Ordering::Relaxed) {
                    return Err("Cancelled".to_string());
                }
            }
            "rar" => {
                // unrar 0.4 doesn't expose per-entry callbacks; emit indeterminate signal.
                app.emit("extract-progress", serde_json::Value::Null).ok();
                unrar::Archive::new(src.to_str().unwrap().to_string())
                    .extract_to(temp_dir_clone.to_str().unwrap().to_string())
                    .map_err(|e| e.to_string())?
                    .process()
                    .map_err(|e| e.to_string())?;
                if cancel.load(Ordering::Relaxed) {
                    return Err("Cancelled".to_string());
                }
            }
            other => return Err(format!("Unsupported archive format: .{other}")),
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    let files = collect_images(&temp_dir);
    Ok(ArchiveContents {
        temp_dir: temp_dir.to_string_lossy().to_string(),
        files,
    })
}

#[tauri::command]
fn create_temp_dir() -> Result<String, String> {
    let dir = unique_temp_dir()?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn cleanup_dir(dir: String) -> Result<(), String> {
    let path = std::path::Path::new(&dir);
    if path.exists() {
        std::fs::remove_dir_all(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_cpu_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
}

#[tauri::command]
async fn get_chdman_version(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = new_command(&path)
            .arg("--version")
            .output()
            .map_err(|e| format!("Failed to run chdman: {}", e))?;

        // chdman prints version info to stderr (e.g. "chdman 0.264 (MAME)")
        let text = if output.stdout.is_empty() {
            String::from_utf8_lossy(&output.stderr).to_string()
        } else {
            String::from_utf8_lossy(&output.stdout).to_string()
        };

        let version = text
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("unknown")
            .trim()
            .to_string();

        Ok(version)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_chdman(state: State<'_, AppState>) -> Result<(), String> {
    state.cancel_flag.store(true, Ordering::Relaxed);
    let pid = *state.running_pid.lock().unwrap();
    if let Some(pid) = pid {
        #[cfg(target_os = "windows")]
        { new_command("taskkill").args(["/F", "/PID", &pid.to_string()]).spawn().ok(); }
        #[cfg(not(target_os = "windows"))]
        { new_command("kill").args(["-9", &pid.to_string()]).spawn().ok(); }
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
pub struct AppDirs {
    pub input_dir: String,
    pub output_dir: String,
}

#[tauri::command]
fn get_file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path).map(|m| m.len()).map_err(|e| e.to_string())
}

/// Detect the media type of a CHD file by inspecting `chdman info` output.
/// Returns "cd", "dvd", "hd", or "raw".
#[tauri::command]
async fn detect_chd_type(path: String) -> Result<String, String> {
    let settings = load_settings()?;
    if settings.chdman_path.is_empty() {
        return Err("chdman path is not configured".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let output = new_command(&settings.chdman_path)
            .args(["info", "-i", &path])
            .output()
            .map_err(|e| format!("Failed to run chdman: {}", e))?;
        let text = String::from_utf8_lossy(&output.stdout).to_string()
            + &String::from_utf8_lossy(&output.stderr);

        // CD-specific compression codecs are unambiguous — chdman only uses these for CD CHDs.
        for line in text.lines() {
            let t = line.trim();
            if t.starts_with("Compression:") {
                if t.contains("cdlz") || t.contains("cdzl") || t.contains("cdfl") {
                    return Ok("cd".to_string());
                }
                break;
            }
        }

        // Match metadata tags scoped to "Metadata:" lines — avoids false matches in file paths.
        for line in text.lines() {
            let t = line.trim();
            if let Some(rest) = t.strip_prefix("Metadata:") {
                let tag = rest.trim().split_whitespace().next().unwrap_or("");
                match tag {
                    "CHCD" | "CHT2" | "CHTR" | "GDDD" | "GDTR" => return Ok("cd".to_string()),
                    "DVDM" => return Ok("dvd".to_string()),
                    "AVAV" => return Ok("ld".to_string()),
                    "IDNT" | "PTBL" => return Ok("hd".to_string()),
                    _ => {}
                }
            }
        }

        Err("Could not determine CHD type from chdman info output. Set the Media Type Override.".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_app_dirs() -> Result<AppDirs, String> {
    let base = exe_dir()?;
    let input  = base.join("input");
    let output = base.join("output");
    std::fs::create_dir_all(&input).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&output).map_err(|e| e.to_string())?;
    Ok(AppDirs {
        input_dir:  input.to_string_lossy().to_string(),
        output_dir: output.to_string_lossy().to_string(),
    })
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DatRom {
    pub name: String,
    pub sha1: Option<String>,
    pub crc: Option<String>,
    pub is_disk: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DatGame {
    pub name: String,
    pub description: String,
    pub roms: Vec<DatRom>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ParsedDat {
    pub header_name: String,
    pub header_version: String,
    pub games: Vec<DatGame>,
}

#[derive(Serialize, Deserialize)]
pub struct FileHashes {
    pub sha1: String,
    pub crc32: String,
}

/// Ensure the dat folder exists and return all .dat/.xml files inside it.
#[tauri::command]
async fn scan_dat_folder() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = exe_dir()?.join("dat");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut files: Vec<String> = std::fs::read_dir(&dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let p = e.path();
                if !p.is_file() { return None; }
                let ext = p.extension()?.to_string_lossy().to_lowercase();
                if ext == "dat" || ext == "xml" {
                    Some(p.to_string_lossy().to_string())
                } else {
                    None
                }
            })
            .collect();
        files.sort();
        Ok(files)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Strip a `<!DOCTYPE ...>` declaration from XML content.
/// roxmltree does not support DTD/DOCTYPE and returns an error when it encounters one.
/// No-Intro and Redump DAT files always include a DOCTYPE line.
fn strip_doctype(xml: &str) -> String {
    let Some(start) = xml.find("<!DOCTYPE") else {
        return xml.to_string();
    };
    let rest = &xml[start..];
    let mut depth: i32 = 0;
    let mut end = start;
    for (i, c) in rest.char_indices() {
        match c {
            '[' => depth += 1,
            ']' => depth -= 1,
            '>' if depth <= 0 => { end = start + i + 1; break; }
            _ => {}
        }
    }
    format!("{}{}", &xml[..start], &xml[end..])
}

/// Parse a No-Intro / Redump / TOSEC DAT file (XML format).
#[tauri::command]
async fn parse_dat(path: String) -> Result<ParsedDat, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let content = strip_doctype(&raw);
        let doc = roxmltree::Document::parse(&content).map_err(|e| e.to_string())?;

        let root = doc.root_element();

        // Read header fields
        let header = root.children().find(|n| n.tag_name().name() == "header");
        let header_name = header
            .and_then(|h| h.children().find(|n| n.tag_name().name() == "name"))
            .and_then(|n| n.text())
            .unwrap_or("")
            .to_string();
        let header_version = header
            .and_then(|h| h.children().find(|n| n.tag_name().name() == "version"))
            .and_then(|n| n.text())
            .unwrap_or("")
            .to_string();

        let mut games: Vec<DatGame> = Vec::new();

        for node in root.children() {
            let tag = node.tag_name().name();
            if tag != "game" && tag != "machine" { continue; }

            let name = node.attribute("name").unwrap_or("").to_string();
            let description = node
                .children()
                .find(|n| n.tag_name().name() == "description")
                .and_then(|n| n.text())
                .unwrap_or(&name)
                .to_string();

            let mut roms: Vec<DatRom> = Vec::new();
            for child in node.children() {
                let ct = child.tag_name().name();
                if ct != "rom" && ct != "disk" { continue; }
                roms.push(DatRom {
                    name: child.attribute("name").unwrap_or("").to_string(),
                    sha1: child.attribute("sha1").map(|s| s.to_lowercase()),
                    crc:  child.attribute("crc").map(|s| s.to_lowercase()),
                    is_disk: ct == "disk",
                });
            }

            if !roms.is_empty() {
                games.push(DatGame { name, description, roms });
            }
        }

        Ok(ParsedDat { header_name, header_version, games })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// For CHD files, extract the Data SHA1 reported by `chdman info`.
/// This is what DAT files (No-Intro/Redump) store — NOT the SHA1 of the CHD file itself.
#[tauri::command]
async fn get_chd_data_sha1(path: String) -> Result<String, String> {
    let settings = load_settings()?;
    if settings.chdman_path.is_empty() {
        return Err("chdman path is not configured".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let output = new_command(&settings.chdman_path)
            .args(["info", "-i", &path])
            .output()
            .map_err(|e| format!("Failed to run chdman: {}", e))?;
        let text = String::from_utf8_lossy(&output.stdout).to_string()
            + &String::from_utf8_lossy(&output.stderr);
        for line in text.lines() {
            let trimmed = line.trim();
            // Match "SHA1:" but not "Data SHA1:" — DATs store the top-level SHA1.
            if trimmed.starts_with("SHA1:") && !trimmed.starts_with("Data SHA1:") {
                let hash = trimmed["SHA1:".len()..].trim().to_lowercase();
                if !hash.is_empty() {
                    return Ok(hash);
                }
            }
        }
        Err("SHA1 not found in chdman info output".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Hash a file and return its SHA1 and CRC32 (lowercase hex).
/// Emits `hash-progress` (0–100) events during processing.
#[tauri::command]
async fn hash_file(app: AppHandle, path: String) -> Result<FileHashes, String> {
    use sha1::{Sha1, Digest};

    tauri::async_runtime::spawn_blocking(move || -> Result<FileHashes, String> {
        let total = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;

        let mut sha1_h = Sha1::new();
        let mut crc32_h = crc32fast::Hasher::new();

        let mut processed: u64 = 0;
        let mut last_pct: u32 = 0;
        let mut buf = [0u8; 65536];

        loop {
            let n = std::io::Read::read(&mut file, &mut buf).map_err(|e| e.to_string())?;
            if n == 0 { break; }
            sha1_h.update(&buf[..n]);
            crc32_h.update(&buf[..n]);
            processed += n as u64;
            if total > 0 {
                let pct = ((processed * 100) / total).min(100) as u32;
                if pct != last_pct {
                    last_pct = pct;
                    app.emit("hash-progress", pct).ok();
                }
            }
        }

        Ok(FileHashes {
            sha1:  hex::encode(sha1_h.finalize()),
            crc32: format!("{:08x}", crc32_h.finalize()),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| format!("Failed to delete \"{}\": {}", path, e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Ensure input / output / temp / dat folders exist next to the executable.
    if let Ok(base) = exe_dir() {
        let _ = std::fs::create_dir_all(base.join("input"));
        let _ = std::fs::create_dir_all(base.join("output"));
        let _ = std::fs::create_dir_all(base.join("temp"));
        let _ = std::fs::create_dir_all(base.join("dat"));
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            running_pid: Mutex::new(None),
            cancel_flag: Arc::new(AtomicBool::new(false)),
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            get_app_dirs,
            run_chdman,
            cancel_chdman,
            get_cpu_threads,
            get_chdman_version,
            scan_folder,
            extract_archive,
            create_temp_dir,
            cleanup_dir,
            get_file_size,
            detect_chd_type,
            scan_dat_folder,
            parse_dat,
            hash_file,
            get_chd_data_sha1,
            delete_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
