fn main() {
    // 启动图复用品牌原图；编译时打入本地资源，不依赖引擎或网络。
    let artwork = "../../../assets/brand/raster/github-social.png";
    println!("cargo:rerun-if-changed={artwork}");
    std::fs::copy(artwork, "../static/startup.png").expect("复制启动品牌图失败");
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["startup_status"])),
    )
    .expect("生成桌面资源失败");
}
