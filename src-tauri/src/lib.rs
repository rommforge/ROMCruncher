use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

fn default_theme() -> String { "dark".to_string() }

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

/// Returns the directory containing the rommCHD executable.
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
fn spawn_output_reader<R: Read + Send + 'static>(
    reader: R,
    app: AppHandle,
    stream: &'static str,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf_reader = std::io::BufReader::new(reader);
        let mut line_bytes: Vec<u8> = Vec::new();
        let mut byte = [0u8; 1];

        loop {
            match buf_reader.read(&mut byte) {
                Ok(0) | Err(_) => {
                    if !line_bytes.is_empty() {
                        emit_chdman_line(&app, stream, &line_bytes);
                    }
                    break;
                }
                Ok(_) => match byte[0] {
                    b'\r' | b'\n' => {
                        if !line_bytes.is_empty() {
                            emit_chdman_line(&app, stream, &line_bytes);
                            line_bytes.clear();
                        }
                    }
                    b => line_bytes.push(b),
                },
            }
        }
    })
}

fn emit_chdman_line(app: &AppHandle, stream: &str, bytes: &[u8]) {
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

    let mut child = Command::new(&settings.chdman_path)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch chdman: {}", e))?;

    *state.running_pid.lock().unwrap() = Some(child.id());

    let stdout_thread = spawn_output_reader(child.stdout.take().unwrap(), app.clone(), "stdout");
    let stderr_thread = spawn_output_reader(child.stderr.take().unwrap(), app.clone(), "stderr");

    stdout_thread.join().ok();
    stderr_thread.join().ok();

    let status = child.wait().map_err(|e| e.to_string())?;
    *state.running_pid.lock().unwrap() = None;

    let code = status.code().unwrap_or(-1);
    app.emit("chdman-done", code).ok();
    Ok(code)
}

#[tauri::command]
fn scan_folder(dir: String, extensions: Vec<String>) -> Result<Vec<String>, String> {
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
fn get_chdman_version(path: String) -> Result<String, String> {
    let output = Command::new(&path)
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
}

#[tauri::command]
fn cancel_chdman(state: State<'_, AppState>) -> Result<(), String> {
    state.cancel_flag.store(true, Ordering::Relaxed);
    let pid = *state.running_pid.lock().unwrap();
    if let Some(pid) = pid {
        #[cfg(target_os = "windows")]
        { Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).spawn().ok(); }
        #[cfg(not(target_os = "windows"))]
        { Command::new("kill").args(["-9", &pid.to_string()]).spawn().ok(); }
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
pub struct AppDirs {
    pub input_dir: String,
    pub output_dir: String,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Ensure input / output / temp folders exist next to the executable.
    if let Ok(base) = exe_dir() {
        let _ = std::fs::create_dir_all(base.join("input"));
        let _ = std::fs::create_dir_all(base.join("output"));
        let _ = std::fs::create_dir_all(base.join("temp"));
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
