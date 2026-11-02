# 图标

`icon.ico`、`32x32.png`、`128x128.png` 是应用剑形图标，由 `bundle.icon` 接入。

Windows PDF 文件使用独立的 `assets/brand/pdf-document.svg`，对应多尺寸 ICO 通过 `bundle.resources` 安装至 `icons/pdf-document.ico`。`windows/hooks.nsh` 在默认文件关联注册后更新 PDF 的 `DefaultIcon`，不改变应用主标、OFD 文件关联或打开命令。

重新生成 PDF 图标时，先用 `tauri icon assets/brand/pdf-document.svg --output <临时目录>` 生成 PNG，再同步至 `assets/brand/raster/pdf-document-*.png` 并制作包含 16、24、32、48、64、128、256 px 的 `pdf-document.ico`。
