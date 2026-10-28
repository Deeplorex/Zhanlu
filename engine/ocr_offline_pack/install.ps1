param([string]$DataDir)

$ErrorActionPreference = 'Stop'
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.tier -ne 'standard' -or $manifest.files.Count -ne 3) {
    throw 'OCR 能力包清单无效。'
}

$appData = if ($DataDir) { $DataDir } elseif ($env:ZHANLU_HOME) { $env:ZHANLU_HOME } else { Join-Path $env:LOCALAPPDATA 'Zhanlu' }
$destination = Join-Path $appData 'plugins\ocr-models'
$expected = @('PP-OCRv6_det_small.onnx', 'PP-OCRv6_rec_small.onnx', 'ch_ppocr_mobile_v2.0_cls_mobile.onnx')
if (@($manifest.files | Select-Object -ExpandProperty name -Unique).Count -ne 3) {
    throw 'OCR 能力包模型列表不完整。'
}

foreach ($item in $manifest.files) {
    if ($expected -notcontains $item.name) { throw "能力包包含未知文件：$($item.name)" }
    $source = Join-Path $PSScriptRoot (Join-Path 'models' $item.name)
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "缺少模型文件：$($item.name)" }
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.sha256) {
        throw "模型文件校验失败：$($item.name)"
    }
}

New-Item -ItemType Directory -Path $destination -Force | Out-Null
foreach ($item in $manifest.files) {
    $source = Join-Path $PSScriptRoot (Join-Path 'models' $item.name)
    $target = Join-Path $destination $item.name
    Copy-Item -LiteralPath $source -Destination $target -Force
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.sha256) {
        throw "安装后校验失败：$($item.name)"
    }
}

Write-Host "OCR 标准档离线能力包已安装：$destination"
Write-Host '请重新打开湛卢，在 设置 → 文字识别 中检查状态。'
