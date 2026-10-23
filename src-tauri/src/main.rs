#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{Emitter, Manager};

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn state_path() -> PathBuf {
    let legacy = exe_dir().join("ofd-reader-state.json");
    // 状态存用户数据目录（%APPDATA%\OFDee），旧版 OFDReader 目录与 exe 旁旧文件自动迁移
    if let Some(cfg) = std::env::var_os("APPDATA") {
        let dir = PathBuf::from(&cfg).join("OFDee");
        if std::fs::create_dir_all(&dir).is_ok() {
            let p = dir.join("ofd-reader-state.json");
            if !p.exists() {
                // 优先从旧版目录迁移，其次 exe 旁旧文件
                let old_dir = PathBuf::from(&cfg).join("OFDReader").join("ofd-reader-state.json");
                if old_dir.is_file() && std::fs::copy(&old_dir, &p).is_ok() {
                    let _ = std::fs::remove_dir_all(PathBuf::from(&cfg).join("OFDReader"));
                } else if legacy.is_file() {
                    let _ = std::fs::copy(&legacy, &p);
                    let _ = std::fs::remove_file(&legacy);
                }
            }
            return p;
        }
    }
    legacy
}

#[tauri::command]
fn read_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("无法读取文件：{}（{}）", path, e))
}

#[tauri::command]
fn file_name_of(path: String) -> String {
    let p = PathBuf::from(&path);
    p.file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| path)
}

#[tauri::command]
fn startup_file() -> Option<String> {
    std::env::args().skip(1).find(|a| {
        let l = a.to_lowercase();
        l.ends_with(".ofd") || l.ends_with(".pdf")
    })
}

#[tauri::command]
fn load_state() -> String {
    std::fs::read_to_string(state_path()).unwrap_or_else(|_| "{}".to_string())
}

#[tauri::command]
fn save_state(data: String) -> Result<(), String> {
    let p = state_path();
    std::fs::write(&p, data).map_err(|e| format!("保存状态失败：{}", e))
}

#[tauri::command]
async fn pick_doc() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("选择 OFD 或 PDF 文件")
            .add_filter("OFD / PDF 文档", &["ofd", "pdf"])
            .add_filter("OFD 文档", &["ofd"])
            .add_filter("PDF 文档", &["pdf"])
            .add_filter("所有文件", &["*"])
            .pick_file()
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .ok()
    .flatten()
}

fn b64_decode(s: &str) -> Vec<u8> {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut table = [255u8; 256];
    for (i, &c) in T.iter().enumerate() {
        table[c as usize] = i as u8;
    }
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let bytes = s.as_bytes();
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for &c in bytes {
        let v = table[c as usize];
        if v == 255 {
            continue; // 跳过换行等非法字符
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

/// 原生「另存为」对话框 + 写盘，返回保存路径；取消返回 None。
/// data 为 base64 编码（IPC JSON 传原始字节数组性能差）
#[tauri::command]
async fn save_doc(
    data: String,
    default_name: String,
    filter_name: String,
    exts: Vec<String>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dlg = rfd::FileDialog::new()
            .set_title("保存文件")
            .set_file_name(&default_name);
        if !exts.is_empty() {
            let ext_refs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
            dlg = dlg.add_filter(&filter_name, &ext_refs);
        }
        match dlg.save_file() {
            Some(path) => {
                let bytes = b64_decode(&data);
                match std::fs::write(&path, &bytes) {
                    Ok(_) => Ok(Some(path.to_string_lossy().to_string())),
                    Err(e) => Err(format!("写入文件失败：{}", e)),
                }
            }
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| format!("对话框任务失败：{}", e))?
}

#[tauri::command]
fn app_dir() -> String {
    exe_dir().to_string_lossy().to_string()
}

/* ---------------- 文件关联（仅写 HKCU，免管理员） ---------------- */

#[cfg(windows)]
mod assoc {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "advapi32")]
    extern "system" {
        fn RegCreateKeyExW(
            hkey: isize,
            sub_key: *const u16,
            reserved: u32,
            class: *const u16,
            options: u32,
            sam: u32,
            sa: *const std::ffi::c_void,
            result: *mut isize,
            disposition: *mut u32,
        ) -> i32;
        fn RegSetValueExW(
            hkey: isize,
            name: *const u16,
            reserved: u32,
            ty: u32,
            data: *const u8,
            len: u32,
        ) -> i32;
        fn RegDeleteTreeW(hkey: isize, sub_key: *const u16) -> i32;
        fn RegDeleteValueW(hkey: isize, name: *const u16) -> i32;
        fn RegOpenKeyExW(
            hkey: isize,
            sub_key: *const u16,
            options: u32,
            sam: u32,
            result: *mut isize,
        ) -> i32;
        fn RegQueryValueExW(
            hkey: isize,
            name: *const u16,
            reserved: *mut u32,
            ty: *mut u32,
            data: *mut u8,
            len: *mut u32,
        ) -> i32;
        fn RegCloseKey(hkey: isize) -> i32;
    }

    const HKCU: isize = 0x8000_0001u32 as isize;
    const KEY_WRITE: u32 = 0x20006;
    const REG_SZ: u32 = 1;

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    /// 写一个字符串值；path 形如 "Software\\Classes\\.ofd"
    fn set_str(path: &str, name: &str, value: &str) -> Result<(), String> {
        unsafe {
            let mut hkey: isize = 0;
            let mut disp: u32 = 0;
            let rc = RegCreateKeyExW(
                HKCU,
                wide(path).as_ptr(),
                0,
                std::ptr::null(),
                0,
                KEY_WRITE,
                std::ptr::null(),
                &mut hkey,
                &mut disp,
            );
            if rc != 0 {
                return Err(format!("无法创建注册表项 {}（错误码 {}）", path, rc));
            }
            let data: Vec<u16> = OsStr::new(value)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let bytes = std::slice::from_raw_parts(
                data.as_ptr() as *const u8,
                data.len() * 2,
            );
            let rc2 = RegSetValueExW(hkey, wide(name).as_ptr(), 0, REG_SZ, bytes.as_ptr(), bytes.len() as u32);
            RegCloseKey(hkey);
            if rc2 != 0 {
                return Err(format!("无法写入注册表值 {}\\{}（错误码 {}）", path, name, rc2));
            }
            Ok(())
        }
    }

    fn delete_tree(path: &str) {
        unsafe {
            RegDeleteTreeW(HKCU, wide(path).as_ptr());
        }
    }

    /// 删除某个项下的值（RegDeleteTree 只能删子项，删不掉值）
    fn delete_value(path: &str, name: &str) {
        unsafe {
            let mut hkey: isize = 0;
            let rc = RegOpenKeyExW(HKCU, wide(path).as_ptr(), 0, KEY_WRITE, &mut hkey);
            if rc == 0 {
                RegDeleteValueW(hkey, wide(name).as_ptr());
                RegCloseKey(hkey);
            }
        }
    }

    const PROG_ID: &str = "OFDee.Document";
    const FRIENDLY: &str = "OFDee 文档";

    /// 读字符串值；项或值不存在返回 None
    fn get_str(path: &str, name: &str) -> Option<String> {
        unsafe {
            let mut hkey: isize = 0;
            let rc = RegOpenKeyExW(HKCU, wide(path).as_ptr(), 0, 0x20019, &mut hkey);
            if rc != 0 {
                return None;
            }
            let mut buf = [0u16; 512];
            let mut len: u32 = (buf.len() * 2) as u32;
            let rc2 = RegQueryValueExW(
                hkey,
                wide(name).as_ptr(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                buf.as_mut_ptr() as *mut u8,
                &mut len,
            );
            RegCloseKey(hkey);
            if rc2 != 0 {
                return None;
            }
            let n = (len as usize / 2).saturating_sub(1);
            Some(String::from_utf16_lossy(&buf[..n.min(buf.len())]))
        }
    }

    pub fn enable(ext: &str, exe: &str) -> Result<(), String> {
        let ext = ext.trim_start_matches('.');
        // 1) ProgID 描述与图标
        set_str(&format!("Software\\Classes\\{}", PROG_ID), "", FRIENDLY)?;
        set_str(
            &format!("Software\\Classes\\{}\\DefaultIcon", PROG_ID),
            "",
            &format!("\"{}\",0", exe),
        )?;
        // 2) 打开命令（%1 传文件路径）
        set_str(
            &format!("Software\\Classes\\{}\\shell\\open\\command", PROG_ID),
            "",
            &format!("\"{}\" \"%1\"", exe),
        )?;
        // 3) 扩展名 → ProgID
        let base = format!("Software\\Classes\\.{}", ext);
        set_str(&base, "", PROG_ID)?;
        set_str(
            &base,
            "Content Type",
            if ext.eq_ignore_ascii_case("pdf") { "application/pdf" } else { "application/ofd" },
        )?;
        set_str(&format!("{}\\OpenWithProgids", base), PROG_ID, "")?;
        // 4) 通知资源管理器刷新关联（公开接口，无副作用）
        let _ = std::process::Command::new("ie4uinit.exe").arg("-show").spawn();
        Ok(())
    }

    pub fn disable(ext: &str) -> Result<(), String> {
        let ext = ext.trim_start_matches('.');
        let base = format!("Software\\Classes\\.{}", ext);
        // 从「打开方式」列表里摘掉自己（这里是值，不是子项）
        delete_value(&format!("{}\\OpenWithProgids", base), PROG_ID);
        // 只有默认值确实指向自己时才清空，避免误删其他程序的关联
        if get_str(&base, "").as_deref() == Some(PROG_ID) {
            delete_value(&base, "");
        }
        delete_tree(&format!("Software\\Classes\\{}", PROG_ID));
        let _ = std::process::Command::new("ie4uinit.exe").arg("-show").spawn();
        Ok(())
    }
}

#[cfg(windows)]
#[tauri::command]
fn assoc_status() -> String {
    let flag = std::env::var("APPDATA")
        .map(|d| std::path::Path::new(&d).join("OFDee").join("assoc.flag"))
        .unwrap_or_default();
    if flag.is_file() {
        std::fs::read_to_string(&flag).unwrap_or_else(|_| "ofd".into())
    } else {
        String::new()
    }
}

#[cfg(windows)]
#[tauri::command]
fn assoc_set(enable: bool) -> Result<String, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("无法获取程序路径：{}", e))?
        .to_string_lossy()
        .to_string();
    let flag = std::env::var("APPDATA")
        .map(|d| std::path::PathBuf::from(d).join("OFDee").join("assoc.flag"))
        .map_err(|_| "无法定位用户数据目录".to_string())?;
    if enable {
        // OFD 默认注册；PDF 不动（系统里通常已被其他阅读器占用）
        assoc::enable("ofd", &exe)?;
        if let Some(dir) = flag.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(&flag, "ofd").map_err(|e| format!("写入标记失败：{}", e))?;
        Ok("已关联 .ofd 文件".into())
    } else {
        assoc::disable("ofd")?;
        let _ = std::fs::remove_file(&flag);
        Ok("已取消 .ofd 关联".into())
    }
}

#[cfg(not(windows))]
#[tauri::command]
fn assoc_status() -> String {
    String::new()
}

#[cfg(not(windows))]
#[tauri::command]
fn assoc_set(_enable: bool) -> Result<String, String> {
    Err("仅支持 Windows".into())
}

/* ---------------- 窗口位置 / 大小记忆 ----------------
 * 独立于 ofd-reader-state.json：那份由前端 save_state 全量覆盖写，
 * 两侧同写会互相覆盖，所以窗口尺寸单独存 window.json（同样放在 %APPDATA%\OFDee）。
 */

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy)]
struct WinState {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    maximized: bool,
}

/// 距离上次落盘的毫秒数，用于节流（拖窗口时 Moved 每帧都来）
static WIN_LAST_SAVE: AtomicU64 = AtomicU64::new(0);
static WIN_LAST_CHANGE: AtomicU64 = AtomicU64::new(0);

/// 窗口最小尺寸，与 tauri.conf.json 的 minWidth / minHeight 保持一致
const MIN_W: u32 = 760;
const MIN_H: u32 = 520;
/// 节流间隔：变动后 900ms 内不重复写盘（拖动窗口时 Moved 每帧都来）
const SAVE_THROTTLE_MS: u64 = 900;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn win_state_path() -> Option<PathBuf> {
    let dir = PathBuf::from(std::env::var_os("APPDATA")?).join("OFDee");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("window.json"))
}

fn load_win() -> Option<WinState> {
    let p = win_state_path()?;
    let s = std::fs::read_to_string(p).ok()?;
    let st = serde_json::from_str::<WinState>(&s).ok()?;
    // 尺寸过小说明记录异常（比如上一次是在极端 DPI 下存的），直接丢弃
    if st.w < MIN_W || st.h < MIN_H {
        return None;
    }
    Some(st)
}

fn save_win_raw(st: &WinState) {
    if let Some(p) = win_state_path() {
        if let Ok(s) = serde_json::to_string(st) {
            let _ = std::fs::write(p, s);
            WIN_LAST_SAVE.store(now_ms(), Ordering::Relaxed);
        }
    }
}

/**
 * 记录当前窗口位置尺寸。
 * force=true 用于关闭/销毁瞬间（保证最后状态不丢）。
 *
 * 两个必须绕开的陷阱：
 *  1. 最小化时系统会报 (-32000,-32000) 这样的坐标，写进去就把窗口丢到虚空了 —— 直接跳过；
 *  2. 最大化时报的是最大化后的外框尺寸（含屏幕外扩边），据它还原会越来越大 —— 最大化时只更新标志，位置尺寸沿用上次记录。
 */
fn save_win(win: &tauri::WebviewWindow, force: bool) {
    if win.is_minimized().unwrap_or(false) {
        return;
    }
    let now = now_ms();
    WIN_LAST_CHANGE.store(now, Ordering::Relaxed);
    if !force {
        let saved = WIN_LAST_SAVE.load(Ordering::Relaxed);
        if saved > 0 && now.saturating_sub(saved) < SAVE_THROTTLE_MS {
            return;
        }
    }

    let maximized = win.is_maximized().unwrap_or(false);
    if maximized {
        // 最大化：沿用上次记录的还原位置，只更新标志
        if let Some(mut prev) = load_win() {
            prev.maximized = true;
            save_win_raw(&prev);
            return;
        }
        // 没有旧记录就只能记当前值（此时也会被下面的 clamp 兜住）
    }

    let (Ok(pos), Ok(size)) = (win.outer_position(), win.inner_size()) else {
        return;
    };
    save_win_raw(&WinState {
        x: pos.x,
        y: pos.y,
        w: size.width.max(MIN_W),
        h: size.height.max(MIN_H),
        maximized,
    });
}

/// 窗口左上角是否落在某个显示器内（拔掉外接屏后记忆坐标可能在屏幕外）
fn pos_visible(win: &tauri::WebviewWindow, x: i32, y: i32) -> bool {
    let Ok(mons) = win.available_monitors() else {
        return true; // 拿不到显示器信息时按可见处理，交给系统兜底
    };
    for m in mons {
        let p = m.position();
        let s = m.size();
        let px = p.x as i32;
        let py = p.y as i32;
        // 左上角落在屏内（留 8px 余量，允许窗口稍微偏出）
        if x + 8 >= px && x < px + s.width as i32 && y + 8 >= py && y < py + s.height as i32 {
            return true;
        }
    }
    false
}

/// 上次使用的主题（'dark' | 'light' | 'system'），用于启动时给窗口刷底色
#[derive(serde::Deserialize)]
struct StateTheme {
    theme: Option<String>,
}

fn load_theme() -> Option<String> {
    let s = std::fs::read_to_string(state_path()).ok()?;
    let o: StateTheme = serde_json::from_str(&s).ok()?;
    o.theme
}

fn restore_win(win: &tauri::WebviewWindow) {
    let Some(st) = load_win() else {
        return;
    };
    let w = st.w.max(MIN_W);
    let h = st.h.max(MIN_H);
    // 坐标越界（换了显示器/分辨率）→ 退回居中，避免窗口跑到看不见的地方
    if pos_visible(win, st.x, st.y) {
        let _ = win.set_position(tauri::PhysicalPosition::new(st.x, st.y));
    } else {
        let _ = win.center();
    }
    let _ = win.set_size(tauri::PhysicalSize::new(w, h));
    if st.maximized {
        let _ = win.maximize();
    }
    // 恢复后立刻记一次，避免「下一帧又被 Resized 覆盖成恢复前的值」
    WIN_LAST_SAVE.store(now_ms(), Ordering::Relaxed);
}

/* ---------------- 单实例下的待打开文件 ----------------
 * 第二次启动本程序时，本进程（已有窗口）会收到文件路径。
 * 但那时前端可能还没加载完（连着双击两个文件时），emit 的事件会丢 ——
 * 所以同时压进这个队列，前端就绪后自取。
 * 用内存而非文件：文件只在启动时取一次，正常路径下会残留在磁盘上、
 * 下次启动被误当成待打开文件。
 */

static PENDING_FILES: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// 取走并清空待打开队列（前端 boot 时调用一次，事件正常到达时也会用来清残留）
#[tauri::command]
fn take_pending_files() -> Vec<String> {
    let mut v = PENDING_FILES.lock().unwrap_or_else(|e| e.into_inner());
    std::mem::take(&mut *v)
}

fn main() {
    // 命令行工具模式：OFDee.exe --assoc=on|off|status
    // 供脚本预置关联与自动化回归（GUI 模式下由设置面板开关调用同一套逻辑）。
    // GUI 子系统下 stdout 不可见，结果同时写 %TEMP%\ofdee-assoc.out 供脚本读取。
    if let Some(arg) = std::env::args().skip(1).find(|a| a.starts_with("--assoc")) {
        let val = arg.split_once('=').map(|(_, v)| v.to_string()).unwrap_or_else(|| "status".into());
        let out = match val.as_str() {
            "on" => assoc_set(true),
            "off" => assoc_set(false),
            _ => Ok(if assoc_status().is_empty() { "off".into() } else { "on".into() }),
        };
        let (msg, code) = match out {
            Ok(m) => (m, 0),
            Err(e) => (e, 1),
        };
        if let Some(tmp) = std::env::var_os("TEMP") {
            let _ = std::fs::write(PathBuf::from(tmp).join("ofdee-assoc.out"), &msg);
        }
        println!("{}", msg);
        std::process::exit(code);
    }

    tauri::Builder::default()
        // 单实例：第二个进程启动时把命令行文件交给已有窗口，自己随即退出
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let file = argv
                .iter()
                .skip(1)
                .find(|a| {
                    let l = a.to_lowercase();
                    l.ends_with(".ofd") || l.ends_with(".pdf")
                })
                .cloned();
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize(); // 最小化时双击文件要能直接看到
                let _ = win.set_focus();
                if let Some(f) = file {
                    // 事件是主路径；队列是兜底，给「前端还没加载完」的情况留一份
                    if let Ok(mut v) = PENDING_FILES.lock() {
                        v.push(f.clone());
                    }
                    let _ = win.emit("open-file", f);
                }
            }
        }))
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                // ① 启动底色：配置里写死的是深色，浅色主题下窗口会先黑一下再变浅。
                //    这里按上次的主题先刷一次（follow 系统时问窗口当前主题）。
                let dark = match load_theme().as_deref() {
                    Some("light") => false,
                    Some("dark") => true,
                    _ => win.theme().map(|t| t == tauri::Theme::Dark).unwrap_or(true),
                };
                let bg = if dark { (20u8, 22u8, 26u8) } else { (233u8, 235u8, 238u8) };
                let _ = win.set_background_color(Some(tauri::webview::Color(bg.0, bg.1, bg.2, 255)));

                // ② 先按上次记录摆放，再记一次：
                //    用户若从不挪动窗口，就不会有 Resized/Moved 事件，那样记忆功能等于没有
                restore_win(&win);
                save_win(&win, true);

                // ③ 恢复完再显示。窗口在 conf 里是 visible:false —— 否则它会先以配置的
                //    1240x840 露脸、再被改成记忆尺寸，肉眼看就是「打开了又变大」。
                let _ = win.show();
                let _ = win.set_focus();

                let w = win.clone();
                win.on_window_event(move |ev| match ev {
                    tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                        save_win(&w, false)
                    }
                    tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                        save_win(&w, true)
                    }
                    _ => {}
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            file_name_of,
            startup_file,
            load_state,
            save_state,
            take_pending_files,
            app_dir,
            pick_doc,
            save_doc,
            assoc_status,
            assoc_set
        ])
        .run(tauri::generate_context!())
        .expect("OFDee 启动失败");
}
