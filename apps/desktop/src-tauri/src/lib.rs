use std::io::Write;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, DragDropEvent, Manager, WebviewEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// 选一个空闲回环端口（由桌面壳决定端口与令牌，不猜测已有服务）。
fn pick_port() -> Option<u16> {
    for _ in 0..30 {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).ok()?;
        let port = listener.local_addr().ok()?.port();
        drop(listener);
        // 极小概率竞态：再确认端口可连接（未占用）
        if TcpStream::connect(("127.0.0.1", port)).is_err() {
            return Some(port);
        }
    }
    None
}

/// 使用操作系统随机源生成 24 字节会话令牌，失败时不启动引擎。
fn gen_token() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|e| format!("无法生成会话令牌: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

struct Engine {
    port: u16,
    token: String,
    child: Child,
    input: Option<ChildStdin>,
}

/// 启动打包的 Python 引擎 sidecar，并用「我们的令牌能否通过鉴权」完成握手：
/// 只有接受该令牌的实例才是我们启动的引擎，避免连接到同端口的其它服务。
/// 子进程在握手期退出时立即报错（而不是干等 30s），让调用方换端口重试。
fn spawn_engine(resource_dir: &std::path::Path, port: u16, token: &str) -> Result<Engine, String> {
    let exe = resource_dir.join("engine").join("zhanlu-engine.exe");
    if !exe.is_file() {
        return Err(format!("引擎 sidecar 缺失: {}", exe.display()));
    }
    let web = resource_dir.join("web-dist");

    let mut cmd = Command::new(&exe);
    cmd.args(["--no-open", "--strict-port", "--desktop-input", "--port", &port.to_string(), "--token", token])
        .stdin(Stdio::piped())
        .env("ZHANLU_WEB", &web);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("启动引擎失败: {e}"))?;

    // 握手：轮询 /api/app-info，携带令牌；401 表示是别的服务，视为失败
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("引擎进程启动即退出: {status}"));
        }
        match ureq_shake(port, token) {
            Ok(true) => {
                let input = child.stdin.take();
                return Ok(Engine { port, token: token.to_string(), child, input });
            }
            Ok(false) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("引擎握手失败：端口上的服务未接受本次会话令牌".into());
            }
            Err(_) => { /* 尚未就绪 */ }
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("引擎启动超时（30s 内未完成握手）".into());
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn ureq_shake(port: u16, token: &str) -> Result<bool, String> {
    // 零依赖握手：直接发裸 HTTP 请求
    use std::io::{Read, Write};
    let mut stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok();
    let req = format!(
        "GET /api/app-info HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Zhanlu-Token: {token}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut buf = String::new();
    stream.read_to_string(&mut buf).map_err(|e| e.to_string())?;
    let status_ok = buf.starts_with("HTTP/1.1 200") || buf.starts_with("HTTP/1.0 200");
    Ok(status_ok)
}

/// 持有当前引擎并负责其生死：界面由引擎托管，引擎是单点，挂了必须自动拉起。
struct EngineKeeper {
    resource_dir: PathBuf,
    engine: Mutex<Option<Engine>>,
    running: AtomicBool,
}

impl EngineKeeper {
    fn kill_current(&self) {
        if let Ok(mut guard) = self.engine.lock() {
            if let Some(mut e) = guard.take() {
                let _ = e.child.kill();
                let _ = e.child.wait();
            }
        }
    }

    /// 换新端口与令牌重启引擎；成功返回新引擎的入口 URL。失败由看门狗下一轮再试。
    fn restart(&self) -> Option<String> {
        self.kill_current();
        for attempt in 1..=3 {
            if !self.running.load(Ordering::Relaxed) {
                return None;
            }
            let port = pick_port()?;
            let token = gen_token().ok()?;
            match spawn_engine(&self.resource_dir, port, &token) {
                Ok(e) => {
                    let url = format!("http://127.0.0.1:{}/?token={}", e.port, e.token);
                    if let Ok(mut guard) = self.engine.lock() {
                        *guard = Some(e);
                    }
                    println!("[湛卢] 看门狗: 引擎已自动重启（第 {attempt} 次尝试）· {url}");
                    return Some(url);
                }
                Err(msg) => {
                    println!("[湛卢] 看门狗: 重启尝试 {attempt} 失败: {msg}");
                    std::thread::sleep(Duration::from_secs(2));
                }
            }
        }
        None
    }
}

enum EngineState {
    Healthy,
    Miss, // 端口在但未响应（可能正在忙，也可能假死）
    Dead,
}

fn engine_state(keeper: &EngineKeeper) -> EngineState {
    let mut guard = keeper.engine.lock().unwrap();
    let Some(e) = guard.as_mut() else { return EngineState::Dead };
    match e.child.try_wait() {
        Ok(Some(status)) => {
            println!("[湛卢] 看门狗: 引擎进程已退出（{status}）");
            EngineState::Dead
        }
        Ok(None) => {
            let (port, token) = (e.port, e.token.clone());
            drop(guard); // 探测可能耗时 3s，不占住锁
            match ureq_shake(port, &token) {
                Ok(true) => EngineState::Healthy,
                Ok(false) => {
                    println!("[湛卢] 看门狗: 端口被不接受会话令牌的其它服务占用");
                    EngineState::Dead
                }
                Err(_) => EngineState::Miss,
            }
        }
        Err(_) => EngineState::Dead,
    }
}

fn restart_and_navigate(keeper: &EngineKeeper, app: &AppHandle) {
    if let Some(url) = keeper.restart() {
        if let Some(win) = app.get_webview_window("main") {
            match url.parse::<tauri::Url>() {
                Ok(parsed) => {
                    if let Err(e) = win.navigate(parsed) {
                        println!("[湛卢] 看门狗: 窗口导航失败: {e}");
                    }
                }
                Err(_) => println!("[湛卢] 看门狗: 入口 URL 非法，未导航"),
            }
        }
    }
}

/// 每 2s 巡检：进程退出立即重启；连续约 30s 无响应判定假死，强杀后重启。
/// 重启后窗口导航到新引擎地址，文件打开通道自动接到新进程的 stdin。
fn watch_engine(keeper: Arc<EngineKeeper>, app: AppHandle) {
    const TICK: Duration = Duration::from_secs(2);
    const HANG_MISSES: u32 = 15;
    let mut misses: u32 = 0;
    while keeper.running.load(Ordering::Relaxed) {
        std::thread::sleep(TICK);
        if !keeper.running.load(Ordering::Relaxed) {
            break;
        }
        match engine_state(&keeper) {
            EngineState::Healthy => misses = 0,
            EngineState::Miss => {
                misses += 1;
                if misses >= HANG_MISSES {
                    println!("[湛卢] 看门狗: 引擎连续 {misses} 次探测无响应，判定假死并强制重启");
                    misses = 0;
                    restart_and_navigate(&keeper, &app);
                }
            }
            EngineState::Dead => {
                misses = 0;
                restart_and_navigate(&keeper, &app);
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial = pdf_paths(std::env::args().skip(1), &std::env::current_dir().unwrap_or_default());
    let pending = Arc::new(Mutex::new(if initial.is_empty() { Vec::new() } else { vec![serde_json::json!(initial)] }));
    let next_files = pending.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(move |app, args, cwd| {
            if let Ok(mut queue) = next_files.lock() {
                let paths = pdf_paths(args.into_iter().skip(1), std::path::Path::new(&cwd));
                if !paths.is_empty() { queue.push(serde_json::json!(paths)); }
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .setup(move |app| {
            let resource_dir = app.path().resource_dir().expect("资源目录缺失").to_path_buf();
            let port = pick_port().ok_or("没有可用端口")?;
            let token = gen_token()?;
            let first = spawn_engine(&resource_dir, port, &token).map_err(|e| format!("引擎启动失败：{e}"))?;

            let keeper = Arc::new(EngineKeeper {
                resource_dir,
                engine: Mutex::new(Some(first)),
                running: AtomicBool::new(true),
            });

            // 文件打开通道：始终写向「当前」引擎的 stdin，引擎重启后自动跟随新进程
            let pending_for_files = pending.clone();
            let keeper_for_files = keeper.clone();
            std::thread::spawn(move || loop {
                if !keeper_for_files.running.load(Ordering::Relaxed) {
                    break;
                }
                if let Ok(mut queue) = pending_for_files.lock() {
                    if !queue.is_empty() {
                        let sent = {
                            let mut guard = keeper_for_files.engine.lock().unwrap();
                            match guard.as_mut().and_then(|e| e.input.as_mut()) {
                                Some(input) => {
                                    let mut count = 0;
                                    for item in queue.iter() {
                                        let message = serde_json::to_string(item).expect("文件消息可序列化");
                                        if writeln!(input, "{message}").and_then(|_| input.flush()).is_err() { break; }
                                        count += 1;
                                    }
                                    count
                                }
                                None => 0,
                            }
                        };
                        queue.drain(..sent);
                    }
                }
                std::thread::sleep(Duration::from_millis(200));
            });

            // 看门狗：引擎是界面与全部能力的单点，挂了自动拉起并恢复窗口
            let keeper_for_watch = keeper.clone();
            let app_for_watch = app.handle().clone();
            std::thread::spawn(move || watch_engine(keeper_for_watch, app_for_watch));

            let (url, port_label) = {
                let guard = keeper.engine.lock().unwrap();
                let e = guard.as_ref().expect("引擎刚启动完成握手");
                (format!("http://127.0.0.1:{}/?token={}", e.port, e.token), e.port)
            };

            let keeper_for_close = keeper.clone();
            let app_for_close = app.handle().clone();

            let win = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(url.parse().expect("url 合法")),
            )
            .title("湛卢 Zhanlu")
            .inner_size(1280.0, 860.0)
            .min_inner_size(840.0, 600.0)
            .build()
            .map_err(|e| format!("创建窗口失败：{e}"))?;

            // 桌面原生拖放的真实路径只通过子进程 stdin 登记；页面只收到落点及无路径的 ID。
            // 先通知页面绑定落点/当前任务，再把路径交给引擎，以免异步登记结果误投其他任务。
            let pending_drops = pending.clone();
            let drop_window = win.clone();
            win.on_webview_event(move |event| {
                if let WebviewEvent::DragDrop(DragDropEvent::Drop { paths, position }) = event {
                    if paths.is_empty() || !position.x.is_finite() || !position.y.is_finite() { return; }
                    let Ok(id) = gen_token() else { return; };
                    let at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                    let detail = serde_json::json!({"id": id, "physicalX": position.x, "physicalY": position.y, "at": at});
                    let script = format!("window.dispatchEvent(new CustomEvent('zhanlu:native-drop-start',{{detail:{detail}}}));");
                    if drop_window.eval(script).is_err() { return; }
                    let values: Vec<String> = paths.iter().map(|path| path.to_string_lossy().into_owned()).collect();
                    if let Ok(mut queue) = pending_drops.lock() {
                        queue.push(serde_json::json!({"type": "drop", "id": id, "paths": values}));
                    }
                }
            });

            win.on_window_event(move |e| {
                if matches!(e, WindowEvent::Destroyed) {
                    keeper_for_close.running.store(false, Ordering::Relaxed);
                    keeper_for_close.kill_current();
                    app_for_close.exit(0);
                }
            });
            println!("[湛卢] 引擎端口 {port_label} · 界面已加载");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("湛卢启动失败");
}

fn pdf_paths(args: impl Iterator<Item = String>, cwd: &std::path::Path) -> Vec<String> {
    args.filter_map(|arg| {
        let path = std::path::PathBuf::from(arg);
        if !path.extension().is_some_and(|ext| {
            ext.eq_ignore_ascii_case("pdf") || ext.eq_ignore_ascii_case("ofd")
        }) {
            return None;
        }
        Some(if path.is_absolute() { path } else { cwd.join(path) }.to_string_lossy().into_owned())
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::pdf_paths;
    #[test]
    fn file_activation_preserves_unicode_spaces_and_filters_other_arguments() {
        let cwd = std::path::Path::new(r"D:\资料");
        let args = ["--flag", "readme.txt", "合同 空格.PDF", r"C:\文件\另一份.pdf"].map(String::from);
        assert_eq!(pdf_paths(args.into_iter(), cwd), vec![r"D:\资料\合同 空格.PDF", r"C:\文件\另一份.pdf"]);
    }

    #[test]
    fn file_activation_accepts_ofd_documents() {
        let cwd = std::path::Path::new(r"D:\资料");
        let args = [r"C:\文件\通知.ofd", "notes.txt"].map(String::from);
        assert_eq!(pdf_paths(args.into_iter(), cwd), vec![r"C:\文件\通知.ofd"]);
    }
}
