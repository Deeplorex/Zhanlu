# 图标

`tauri.conf.json` 的 `bundle.icon` 暂为空——首次 `cargo tauri build` 打安装包前，
需要放一组图标（icon.ico / 32x32.png / 128x128.png 等），
可用 `cargo tauri icon <源图>` 从湛卢剑形标识生成。
开发模式 `cargo tauri dev` 不需要图标。
