# 注册 Windows 计划任务：每天 00:05 执行 governor daily-rotate（时区以 config.json timezone 为准，处理「昨天」）
# 需以管理员 PowerShell 运行（创建计划任务需要权限），或当前用户任务视策略而定。

param(
  [string]$OpenclawHome = "$env:USERPROFILE\.openclaw",
  [string]$SkillRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$TaskName = "OpenClaw MemoryGovernor DailyRotate",
  [string]$RunTime = "00:05"
)

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Error "未找到 node.exe，请先安装 Node.js 并加入 PATH"
  exit 1
}

$actionArgs = @(
  "--import", "jiti/register",
  (Join-Path $SkillRoot "src\index.ts"),
  "daily-rotate",
  "--all-agents"
)

# 可选：同步 OpenClaw 会话索引
# $actionArgs += "--openclaw-cleanup"

$argLine = ($actionArgs | ForEach-Object { if ($_ -match "\s") { "`"$_`"" } else { $_ } }) -join " "

$pwsh = @"
`$env:OPENCLAW_HOME='$OpenclawHome'
Set-Location -LiteralPath '$SkillRoot'
& '$node' $argLine
"@

$encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($pwsh))

schtasks /Create /F /TN $TaskName /SC DAILY /ST $RunTime /RL HIGHEST /RU "$env:USERDOMAIN\$env:USERNAME" `
  /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"

if ($LASTEXITCODE -ne 0) {
  Write-Warning "schtasks 失败（常见：需管理员权限）。可改为「任务计划程序」手动新建："
  Write-Host "  程序: $node"
  Write-Host "  参数: $argLine"
  Write-Host "  起始于: $SkillRoot"
  Write-Host "  环境: OPENCLAW_HOME=$OpenclawHome"
  exit $LASTEXITCODE
}

Write-Host "已创建: $TaskName，每日 $RunTime 运行（处理前一日历日的会话 transcript）"
Write-Host "手动跑一次: `$env:OPENCLAW_HOME='$OpenclawHome'; Set-Location '$SkillRoot'; npm run governor:daily-rotate"
