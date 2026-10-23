# 启动 OFDee 并检查关联开关写入的注册表项（供人工/自动验证使用）
$exe = "E:/桌面文件/OFDee.exe"
$ErrorActionPreference = "Stop"

function Show-Assoc {
    $base = "HKCU:/Software/Classes/.ofd"
    $prog = "HKCU:/Software/Classes/OFDee.Document"
    $flag = Join-Path $env:APPDATA "OFDee\assoc.flag"
    Write-Output "--- current state ---"
    if (Test-Path $base) {
        $v = (Get-ItemProperty -Path $base -ErrorAction SilentlyContinue).'(default)'
        Write-Output "  .ofd default  = $v"
    } else { Write-Output "  .ofd key      = ABSENT" }
    if (Test-Path $prog) {
        $cmd = (Get-ItemProperty -Path "$prog\shell\open\command" -ErrorAction SilentlyContinue).'(default)'
        $icon = (Get-ItemProperty -Path "$prog\DefaultIcon" -ErrorAction SilentlyContinue).'(default)'
        Write-Output "  ProgID        = present"
        Write-Output "  command       = $cmd"
        Write-Output "  icon          = $icon"
    } else { Write-Output "  ProgID        = ABSENT" }
    Write-Output "  flag file     = $(Test-Path $flag)"
}

Show-Assoc
