use std::io::Write;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{ipc::CapabilityBuilder, webview::PageLoadEvent, window::Color, AppHandle, DragDropEvent, Manager, State, WebviewEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

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
/// `cancel` 置位时尽快终止子进程并返回，保证启动期间关闭窗口不遗留孤儿引擎。
fn spawn_engine(
    resource_dir: &std::path::Path,
    port: u16,
    token: &str,
    cancel: &AtomicBool,
) -> Result<Engine, String> {
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
        if !cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("应用正在退出，引擎启动已取消".into());
        }
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
/// 首启也走同一条 `restart` 路径（初始为空，先显示启动页，后台拉起引擎后再导航）。
struct EngineKeeper {
    resource_dir: PathBuf,
    engine: Mutex<Option<Engine>>,
    running: AtomicBool,
    /// 前端基础数据与首屏已经就绪，允许显示主窗口。
    presented: AtomicBool,
    loading_since: Mutex<Option<Instant>>,
    splash: Mutex<(String, bool)>,
    /// 同一时刻只允许一条线程执行「杀旧 + 拉新」序列，避免首启线程与看门狗重复拉起。
    spawn_lock: Mutex<()>,
}

impl EngineKeeper {
    fn splash_status(&self, app: &AppHandle, message: &str, failed: bool) {
        *self.splash.lock().unwrap() = (message.into(), failed);
        splash_status(app, message, failed);
    }

    fn kill_current(&self) {
        if let Ok(mut guard) = self.engine.lock() {
            if let Some(mut e) = guard.take() {
                let _ = e.child.kill();
                let _ = e.child.wait();
            }
        }
    }

    /// 换新端口与令牌启动引擎；成功把主窗口导航到新入口并返回 URL。
    /// 失败时在启动页状态行反馈原因（仅限尚未进入引擎界面时），由看门狗下一轮再试。
    fn restart(&self, app: &AppHandle) -> Option<String> {
        let _guard = self.spawn_lock.try_lock().ok()?;
        self.kill_current();
        if !self.presented.load(Ordering::Relaxed) {
            self.splash_status(app, "正在启动本机引擎…", false);
        }
        let mut last_err = String::from("未知原因");
        for attempt in 1..=3 {
            if !self.running.load(Ordering::Relaxed) {
                return None;
            }
            let Some(port) = pick_port() else {
                last_err = "没有可用端口".into();
                std::thread::sleep(Duration::from_secs(2));
                continue;
            };
            let Ok(token) = gen_token() else {
                last_err = "无法生成会话令牌".into();
                std::thread::sleep(Duration::from_secs(2));
                continue;
            };
            match spawn_engine(&self.resource_dir, port, &token, &self.running) {
                Ok(e) => {
                    let url = format!("http://127.0.0.1:{}/?token={}", e.port, e.token);
                    // 仅给本次引擎地址开放启动回执，不授予文件或系统操作权限。
                    let capability = CapabilityBuilder::new(format!("startup-{token}"))
                        .window("main")
                        .local(false)
                        .remote(format!("http://127.0.0.1:{port}"))
                        .permission("allow-startup-status");
                    if let Err(error) = app.add_capability(capability) {
                        let mut engine = e;
                        let _ = engine.child.kill();
                        let _ = engine.child.wait();
                        self.splash_status(app, &format!("无法加载界面：{error}"), true);
                        return None;
                    }
                    if let Ok(mut guard) = self.engine.lock() {
                        *guard = Some(e);
                    }
                    self.splash_status(app, "正在加载工作台…", false);
                    *self.loading_since.lock().unwrap() = Some(Instant::now());
                    if !navigate_main(app, &url) {
                        self.splash_status(app, "界面加载失败，正在重新启动…", true);
                        self.kill_current();
                        return None;
                    }
                    println!("[湛卢] 引擎已就绪（第 {attempt} 次尝试）");
                    return Some(url);
                }
                Err(msg) => {
                    last_err = msg;
                    println!("[湛卢] 引擎启动尝试 {attempt} 失败: {last_err}");
                    if !self.presented.load(Ordering::Relaxed) {
                        self.splash_status(app, &format!("引擎启动失败（第 {attempt} 次尝试），正在重试：{last_err}"), true);
                    }
                    std::thread::sleep(Duration::from_secs(2));
                }
            }
        }
        if !self.presented.load(Ordering::Relaxed) {
            self.splash_status(app, &format!("引擎启动失败，稍后自动重试：{last_err}"), true);
        }
        None
    }
}

/// 把主窗口导航到引擎入口 URL；窗口不存在（如退出中）时静默跳过。
fn navigate_main(app: &AppHandle, url: &str) -> bool {
    let Some(win) = app.get_webview_window("main") else { return false };
    match url.parse::<tauri::Url>() {
        Ok(parsed) => {
            if let Err(e) = win.navigate(parsed) {
                println!("[湛卢] 窗口导航失败: {e}");
                return false;
            }
            true
        }
        Err(_) => {
            println!("[湛卢] 入口 URL 非法，未导航");
            false
        }
    }
}

/// 独立启动窗口只呈现实际阶段；未知总量不提供百分比，失败时停止游光。
fn splash_status(app: &AppHandle, msg: &str, failed: bool) {
    let Some(win) = app.get_webview_window("splash") else { return };
    let payload = serde_json::to_string(msg).unwrap_or_else(|_| "\"\"".into());
    let script = format!("window.zhanluSplashStatus?.({payload},{failed});");
    let _ = win.eval(&script);
}

fn is_engine_url(url: &tauri::Url, port: u16, token: &str) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(port)
        && url.query_pairs().any(|(key, value)| key == "token" && value == token)
}

/// 必须由当前引擎的主页面回执。异步命令避免在 WebView2 IPC 回调中操作窗口而死锁。
#[tauri::command]
async fn startup_status(
    app: AppHandle,
    window: WebviewWindow,
    keeper: State<'_, Arc<EngineKeeper>>,
    phase: String,
    message: Option<String>,
) -> Result<(), String> {
    if window.label() != "main" { return Err("启动回执窗口不匹配".into()); }
    let url = window.url().map_err(|e| e.to_string())?;
    let trusted = keeper.engine.lock().unwrap().as_ref()
        .is_some_and(|engine| is_engine_url(&url, engine.port, &engine.token));
    if !trusted { return Err("启动回执会话不匹配".into()); }
    if keeper.presented.load(Ordering::Relaxed) { return Ok(()); }
    match phase.as_str() {
        "loading" => keeper.splash_status(&app, "正在加载工作台…", false),
        "error" => keeper.splash_status(&app, &format!("工作台加载失败，正在重试：{}", message.unwrap_or_default()), true),
        "ready" => {
            window.show().map_err(|e| e.to_string())?;
            keeper.presented.store(true, Ordering::Relaxed);
            let _ = window.set_focus();
            if let Some(splash) = app.get_webview_window("splash") {
                splash.destroy().map_err(|e| e.to_string())?;
            }
            println!("[湛卢] 工作台已就绪，启动窗口已关闭");
        }
        _ => return Err("未知启动阶段".into()),
    }
    Ok(())
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

/// 每 2s 巡检：进程退出立即重启；连续约 30s 无响应判定假死，强杀后重启。
/// 重启后窗口导航到新引擎地址，文件打开通道自动接到新进程的 stdin。
/// 首次启动也由本函数路径兜底：restart 的 spawn_lock 保证与首启线程互斥。
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
            EngineState::Healthy => {
                misses = 0;
                let timed_out = !keeper.presented.load(Ordering::Relaxed)
                    && keeper.loading_since.lock().unwrap()
                        .is_some_and(|since| since.elapsed() > Duration::from_secs(30));
                if timed_out {
                    keeper.splash_status(&app, "工作台加载超时，正在重新启动…", true);
                    keeper.restart(&app);
                }
            }
            EngineState::Miss => {
                misses += 1;
                if misses >= HANG_MISSES {
                    println!("[湛卢] 看门狗: 引擎连续 {misses} 次探测无响应，判定假死并强制重启");
                    misses = 0;
                    keeper.restart(&app);
                }
            }
            EngineState::Dead => {
                misses = 0;
                keeper.restart(&app);
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
        .invoke_handler(tauri::generate_handler![startup_status])
        .plugin(tauri_plugin_single_instance::init(move |app, args, cwd| {
            if let Ok(mut queue) = next_files.lock() {
                let paths = pdf_paths(args.into_iter().skip(1), std::path::Path::new(&cwd));
                if !paths.is_empty() { queue.push(serde_json::json!(paths)); }
            }
            let ready = app.try_state::<Arc<EngineKeeper>>()
                .is_some_and(|keeper| keeper.presented.load(Ordering::Relaxed));
            if let Some(win) = app.get_webview_window(if ready { "main" } else { "splash" }) {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .setup(move |app| {
            let boot_at = Instant::now();
            let resource_dir = app.path().resource_dir().expect("资源目录缺失").to_path_buf();

            // 引擎初始为空：先显示本地启动页，引擎在后台线程拉起，握手成功后再导航过去。
            let keeper = Arc::new(EngineKeeper {
                resource_dir,
                engine: Mutex::new(None),
                running: AtomicBool::new(true),
                presented: AtomicBool::new(false),
                loading_since: Mutex::new(None),
                splash: Mutex::new(("正在启动本机引擎…".into(), false)),
                spawn_lock: Mutex::new(()),
            });
            app.manage(keeper.clone());

            let splash_keeper = keeper.clone();
            let splash = WebviewWindowBuilder::new(app, "splash", WebviewUrl::App("index.html".into()))
                .title("湛卢 · 正在启动")
                .inner_size(640.0, 400.0)
                .center()
                .decorations(false)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .closable(false)
                .background_color(Color(0xF4, 0xF1, 0xEB, 0xFF))
                .on_page_load(move |window, payload| {
                    if payload.event() == PageLoadEvent::Finished {
                        let (message, failed) = splash_keeper.splash.lock().unwrap().clone();
                        splash_status(window.app_handle(), &message, failed);
                    }
                })
                .build()?;
            splash.on_window_event(|event| {
                if let WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); }
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

            let keeper_for_close = keeper.clone();
            let app_for_close = app.handle().clone();

            // 主窗口在基础数据和首屏就绪前始终隐藏，避免白屏或半成品界面。
            let win = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("index.html".into()),
            )
            .title("湛卢 Zhanlu")
            .inner_size(1280.0, 860.0)
            .min_inner_size(840.0, 600.0)
            .center()
            // 工作台就绪即最大化呈现；隐藏期间只记录标志，show() 时平台层执行 SW_MAXIMIZE
            .maximized(true)
            .visible(false)
            .initialization_script(r#"
                let startupResourceFailed = false;
                window.__ZHANLU_STARTUP__ = (phase, message) => {
                    if (phase === 'ready' && startupResourceFailed) {
                        return Promise.reject(new Error('界面资源加载失败，等待重新加载'));
                    }
                    return window.__TAURI_INTERNALS__.invoke('startup_status', { phase, message: message ?? null });
                };
                window.addEventListener('error', event => {
                    if (!(event instanceof ErrorEvent) && !(event.target instanceof HTMLScriptElement)
                        && !(event.target instanceof HTMLLinkElement)) return;
                    startupResourceFailed = true;
                    window.__ZHANLU_STARTUP__('error', event.message || '界面资源加载失败').catch(() => {});
                }, true);
            "#)
            .background_color(Color(0xF4, 0xF1, 0xEB, 0xFF))
            .build()
            .map_err(|e| format!("创建窗口失败：{e}"))?;
            println!("[湛卢] 启动窗口已显示（窗口就绪耗时 {:?}），主窗口等待加载", boot_at.elapsed());

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

            // 窗口与回执通道就绪后才启动看门狗，避免抢先导航到尚未创建的窗口。
            let keeper_for_watch = keeper.clone();
            let app_for_watch = app.handle().clone();
            std::thread::spawn(move || watch_engine(keeper_for_watch, app_for_watch));

            win.on_window_event(move |e| {
                if matches!(e, WindowEvent::Destroyed) {
                    keeper_for_close.running.store(false, Ordering::Relaxed);
                    // 后台线程可能正在握手尚未登记的引擎：置位取消并给它收尾时间，
                    // 避免退出时遗留孤儿引擎进程（握手轮询 ≤300ms + 探测读超时 3s，上限给足）。
                    for _ in 0..120 {
                        let Ok(guard) = keeper_for_close.spawn_lock.try_lock() else {
                            std::thread::sleep(Duration::from_millis(50));
                            continue;
                        };
                        drop(guard);
                        break;
                    }
                    keeper_for_close.kill_current();
                    app_for_close.exit(0);
                }
            });

            // 首启线程：与看门狗共用同一条 restart 路径（spawn_lock 互斥）。
            // 成功即导航进引擎界面；失败由启动页状态行反馈，看门狗下一轮自动重试。
            let keeper_boot = keeper.clone();
            let app_boot = app.handle().clone();
            std::thread::spawn(move || {
                keeper_boot.restart(&app_boot);
                println!("[湛卢] 首启线程结束（总耗时 {:?}）", boot_at.elapsed());
            });
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
    use super::{is_engine_url, pdf_paths};

    #[test]
    fn startup_receipt_requires_the_current_loopback_session() {
        let url = |value: &str| value.parse::<tauri::Url>().unwrap();
        assert!(is_engine_url(&url("http://127.0.0.1:8741/?token=current#/home"), 8741, "current"));
        for address in [
            "http://127.0.0.1:8742/?token=current",
            "http://127.0.0.1:8741/?token=previous",
            "http://localhost:8741/?token=current",
            "https://127.0.0.1:8741/?token=current",
            "http://example.com:8741/?token=current",
            "http://127.0.0.1:8741/",
        ] {
            assert!(!is_engine_url(&url(address), 8741, "current"), "{address}");
        }
    }

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
