#Requires -Version 5.1
<#
.SYNOPSIS
  Real-installer evidence for the NSIS pre-uninstall hook (desktop-pet, PR-1 / H1).

.DESCRIPTION
  Why a manual script instead of a CI suite:
    The runner's E2E workflow only allowlists verify, verify:agent, verify:worker,
    verify:todo and verify:game. The suite that would actually bundle an NSIS
    installer (verify:release) is deliberately outside that list -- it starts a
    release exe, holds port 9224 and needs a 3-4 minute tauri build. Dispatch says
    not to widen that allowlist, so the packaging path is evidenced here, by the
    PM, before a release.

  The static half is already on CI (tests/unit/unit-nsis-hook.mjs): the config key
  points at a file that exists, that file defines NSIS_HOOK_PREUNINSTALL, calls
  ExecWait with a quoted exe path plus --pet-hook-cleanup, gates on $UpdateMode
  and never aborts on failure.

  What THIS script adds: the hook actually firing during a real uninstall, the
  entries really disappearing, and -- crucially -- whether an overwrite install
  runs the OLD uninstaller. It matters because startup deliberately only removes
  entries and never reinstalls them, so an upgrade that strips the hooks leaves
  the bridge silently dead.

  WHAT IT NEVER DOES: it never writes to a real agent configuration directory. It
  refuses to run unless PET_AGENT_CONFIG_FILES is set and none of the listed paths
  sit under .qoder / .qoder-cn / .zcode / .codex / .workbuddy / .codebuddy. The other
  three adapters are isolated through PET_AGENT_HOME, because the uninstall sweep walks
  EVERY wired adapter: the script defaults that variable to a throwaway TEMP folder when
  the caller did not set it, and refuses outright if it names the real user profile or
  sits inside a real agent directory.

.PARAMETER InstallRoot
  Base folder for the silent install of Case A. Defaults to a pid-scoped folder
  under TEMP. A path with spaces is allowed on purpose: the hook command quotes
  $INSTDIR, and this is the case that proves it -- but note that NSIS only honours
  "/D=<path with spaces>" when the child process is handed the argument unquoted,
  so prefer a space-free path for the routine run.

.PARAMETER SkipBuild
  Reuse the installer already present in the resolved bundle directory instead of
  building one. The directory comes from CARGO_TARGET_DIR (or CARGO_BUILD_TARGET_DIR)
  when set, and from src-tauri/target otherwise; either way a bundle older than the
  HEAD commit is refused.

.EXAMPLE
  $env:PET_AGENT_CONFIG_FILES = "F:\tmp\nsis\cfg-a.json;F:\tmp\nsis\cfg-b.json"
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\check-nsis-cleanup.ps1
#>
[CmdletBinding()]
param(
  [string] $InstallRoot = "",
  [switch] $SkipBuild
)

$ErrorActionPreference = "Stop"
$Repo = Split-Path -Parent $PSScriptRoot
$failures = New-Object System.Collections.Generic.List[string]
$notes = New-Object System.Collections.Generic.List[string]

function Step([string] $m) { Write-Host "`n===== $m =====" }
function Pass([string] $m) { Write-Host "  OK   $m" }
function Fail([string] $m) { Write-Host "  FAIL $m"; $script:failures.Add($m) }
function Note([string] $m) { Write-Host "  NOTE $m"; $script:notes.Add($m) }
function Check([bool] $cond, [string] $okMsg, [string] $badMsg) {
  if ($cond) { Pass $okMsg } else { Fail $badMsg }
}

# Write UTF-8 WITHOUT a BOM: PowerShell 5.1's Set-Content -Encoding UTF8 adds one,
# and the Rust side reads the config with serde_json, which rejects a leading BOM --
# the script would then be testing "file is unreadable" instead of "cleanup works".
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-Json([string] $path, [string] $text) {
  [System.IO.File]::WriteAllText($path, $text, $Utf8NoBom)
}
function Read-Text([string] $path) {
  if (-not (Test-Path $path)) { return "" }
  return [System.IO.File]::ReadAllText($path)
}

# A24: where the NSIS bundle actually lives. Hardcoding src-tauri\target is wrong on a
# machine that builds with CARGO_TARGET_DIR outside the repo -- and worse, the junction
# at src-tauri\target on the release box still holds superseded installers, so the old
# path made this script certify a stale package as green. Kept as a standalone function
# so the resolution can be exercised in a throwaway copy without running the installer.
function Resolve-BundleDir {
  param(
    [string] $Repo,
    [string] $Primary,
    [string] $Secondary
  )
  $chosen = ""
  $chosenName = ""
  if (-not [string]::IsNullOrWhiteSpace($Primary)) {
    $chosen = $Primary; $chosenName = 'CARGO_TARGET_DIR'
  } elseif (-not [string]::IsNullOrWhiteSpace($Secondary)) {
    $chosen = $Secondary; $chosenName = 'CARGO_BUILD_TARGET_DIR'
  }
  if ($chosen -eq "") {
    # Nothing external set: byte-for-byte the historical default.
    return [pscustomobject]@{ Ok = $true; Name = ''; Value = ''; Path = (Join-Path $Repo 'src-tauri\target\release\bundle\nsis') }
  }
  $trimmed = $chosen.Trim()
  if (-not [System.IO.Path]::IsPathRooted($trimmed)) {
    # cargo resolves a relative target dir against the cwd it was started from, which this
    # script cannot know -- refuse instead of guessing.
    return [pscustomobject]@{ Ok = $false; Name = $chosenName; Value = $trimmed; Path = '' }
  }
  return [pscustomobject]@{ Ok = $true; Name = $chosenName; Value = $trimmed; Path = (Join-Path ([System.IO.Path]::GetFullPath($trimmed)) 'release\bundle\nsis') }
}

# A24: an installer older than HEAD is a leftover from a previous build, and every hook
# reading below would then describe a binary that no longer matches the tree. Strict -lt:
# equal timestamps count as fresh, and no git => refuse (a skipped check is worse than a
# refused run).
function Get-HeadCommitUtc {
  param([string] $Repo)
  $headUnix = [long]0
  $ok = $false
  try {
    $raw = (& git -C $Repo log -1 --format=%ct HEAD) 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) { $ok = [long]::TryParse($raw.Trim(), [ref]$headUnix) }
  } catch { $ok = $false }
  if (-not $ok -or $headUnix -le 0) { return $null }
  return [DateTimeOffset]::FromUnixTimeSeconds($headUnix).UtcDateTime
}

# The verdict itself, so the rule can be exercised (and mutated) in a throwaway copy.
# 'missing' and 'nogit' both refuse: a skipped freshness check is worse than a refused run.
function Get-StaleVerdict {
  param([object] $InstallerUtc, [object] $HeadUtc)
  if (-not $HeadUtc) { return 'nogit' }
  if (-not $InstallerUtc) { return 'missing' }
  if ($InstallerUtc -lt $HeadUtc) { return 'stale' }
  return 'fresh'
}

# --- 0. Guard rails -----------------------------------------------------------
Step "guard: PET_AGENT_CONFIG_FILES"
$cfgRaw = $env:PET_AGENT_CONFIG_FILES
if ([string]::IsNullOrWhiteSpace($cfgRaw)) {
  Write-Host "REFUSED: PET_AGENT_CONFIG_FILES is not set." -ForegroundColor Red
  Write-Host "This script installs and uninstalls a real package. Without that"
  Write-Host "variable the cleanup would edit the agent configuration you are"
  Write-Host "using right now. Point it at throwaway json files and re-run."
  exit 2
}
$cfgFiles = @($cfgRaw -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
if ($cfgFiles.Count -lt 1) { Write-Host "REFUSED: the list is empty." -ForegroundColor Red; exit 2 }
# The danger is a real agent home, not "somewhere inside the profile" -- TEMP lives
# in the profile too and is fine.
$blocked = @('.qoder\', '.qoder-cn\', '.zcode\', '.codex\', '.workbuddy\', '.codebuddy\')
foreach ($f in $cfgFiles) {
  $full = [System.IO.Path]::GetFullPath($f).ToLowerInvariant()
  foreach ($b in $blocked) {
    if ($full.Contains($b)) {
      Write-Host ("REFUSED: " + $f + " points inside a real agent directory (" + $b + ").") -ForegroundColor Red
      exit 2
    }
  }
  $parent = Split-Path -Parent $f
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
}
Pass ("target configs: " + ($cfgFiles -join ", "))

# --- 0b. Guard rails: the home root the other three adapters fall back to ------
# PET_AGENT_CONFIG_FILES alone does NOT isolate the uninstall sweep. The cleanup branch
# runs uninstall_everywhere over EVERY wired adapter: Qoder honours PET_AGENT_CONFIG_FILES,
# ZCode reads PET_AGENT_HOME and nothing else, Codex and WorkBuddy prefer their own
# *_FILES lists but fall back to PET_AGENT_HOME -- and only then to the real home
# (src-tauri\src\services\agent\adapters\claude_style.rs:170-191, zcode.rs:140-153).
# With the variable unset, the uninstaller's child strips --pet-hook entries out of the
# .zcode / .codex / .workbuddy configurations belonging to whoever runs this script.
Step "guard: PET_AGENT_HOME"
$agentHome = $env:PET_AGENT_HOME
if ([string]::IsNullOrWhiteSpace($agentHome)) {
  # Default to a throwaway root and deliberately do NOT create it: an absent .zcode /
  # .codex / .workbuddy under that root means zero candidate files, so zero writes.
  $agentHome = Join-Path $env:TEMP ("pet-nsis-home-" + $PID)
  $env:PET_AGENT_HOME = $agentHome
  Note ("PET_AGENT_HOME was not set; defaulted to a throwaway root: " + $agentHome)
}
$homeFull = [System.IO.Path]::GetFullPath($agentHome).TrimEnd('\', '/').ToLowerInvariant()
$profileHome = ""
if ($env:USERPROFILE) {
  $profileHome = [System.IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\', '/').ToLowerInvariant()
}
# A home root equal to the real profile is the same exposure as leaving it unset --
# every agent directory is created underneath it (same rule as isHomeRoot in verify-release.mjs).
if ($profileHome -ne "" -and $homeFull -eq $profileHome) {
  Write-Host "REFUSED: PET_AGENT_HOME is the real user home." -ForegroundColor Red
  Write-Host "Every agent directory (.zcode / .codex / .workbuddy) resolves under it,"
  Write-Host "which is exactly what an unset variable would have done. Point it at a"
  Write-Host "throwaway folder under TEMP and re-run."
  exit 2
}
foreach ($b in $blocked) {
  if (($homeFull + '\').Contains($b)) {
    Write-Host ("REFUSED: PET_AGENT_HOME " + $agentHome + " is or sits inside a real agent directory (" + $b + ").") -ForegroundColor Red
    exit 2
  }
}
Pass ("isolated agent home root: " + $homeFull)

$conf = Get-Content -Raw (Join-Path $Repo "src-tauri\tauri.conf.json") | ConvertFrom-Json
$identifier = $conf.identifier
Check ($identifier -ne "") "bundle identifier read: $identifier" "identifier missing from tauri.conf.json"
Write-Host ("  host state file (this script never writes it): " + (Join-Path $env:APPDATA (Join-Path $identifier "agent-linkage.json")))

# --- 1. Build the bundle ------------------------------------------------------
Step "build: npm run tauri build (with bundle)"
if ($SkipBuild) {
  Note "SkipBuild set, reusing whatever is under target/release/bundle/nsis"
} else {
  Push-Location $Repo
  try {
    & npm run tauri build
    if ($LASTEXITCODE -ne 0) { throw ("tauri build exit " + $LASTEXITCODE) }
  } finally { Pop-Location }
}
$bundlePlan = Resolve-BundleDir -Repo $Repo -Primary $env:CARGO_TARGET_DIR -Secondary $env:CARGO_BUILD_TARGET_DIR
if (-not $bundlePlan.Ok) {
  Write-Host ("REFUSED: " + $bundlePlan.Name + " must be an absolute path, got: " + $bundlePlan.Value) -ForegroundColor Red
  Write-Host "cargo resolves a relative target dir against its own cwd, which this script cannot know."
  exit 2
}
$bundleDir = $bundlePlan.Path
Note ("bundle dir source: " + $(if ($bundlePlan.Name -eq "") { "default (no CARGO_TARGET_DIR set)" } else { $bundlePlan.Name }))
$installer = Get-ChildItem -Path $bundleDir -Filter "*.exe" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) {
  Write-Host ("REFUSED: no installer under " + $bundleDir) -ForegroundColor Red
  exit 2
}
Pass ("installer: " + $installer.FullName)

$headUtc = Get-HeadCommitUtc -Repo $Repo
$installerUtc = $installer.LastWriteTimeUtc
$stale = Get-StaleVerdict -InstallerUtc $installerUtc -HeadUtc $headUtc
if ($stale -eq 'nogit') {
  Write-Host "REFUSED: cannot read HEAD commit time from git, so this script cannot tell a stale installer from a fresh one." -ForegroundColor Red
  exit 2
}
if ($stale -eq 'stale') {
  Write-Host ("REFUSED: installer is older than HEAD commit: " + $installer.FullName) -ForegroundColor Red
  Write-Host ("  installer LastWriteTimeUtc = " + $installerUtc.ToString('o'))
  Write-Host ("  HEAD commit time (UTC)     = " + $headUtc.ToString('o'))
  exit 2
}
Pass ("installer is not older than HEAD commit (installer " + $installerUtc.ToString('o') + " >= head " + $headUtc.ToString('o') + ")")

# exe name comes from [package] name in Cargo.toml -- never hardcoded here
$cargo = Read-Text (Join-Path $Repo "src-tauri\Cargo.toml")
$exeName = [regex]::Match($cargo, '(?ms)^\[package\].*?^\s*name\s*=\s*"([^"]+)"').Groups[1].Value
Check ($exeName -ne "") "binary name from Cargo.toml: $exeName.exe" "could not read [package] name from Cargo.toml"

# --- 2. Fixture: entries shaped exactly like install_files writes -------------
# phase table is parsed from phases.rs so this file does not copy HOOK_PHASES
$phasesSrc = Read-Text (Join-Path $Repo "src-tauri\src\services\agent\phases.rs")
$phases = @([regex]::Matches($phasesSrc, '\(\s*"([A-Za-z]+)"\s*,\s*"([a-z-]+)"\s*\)') | ForEach-Object { $_.Groups[2].Value })
Check ($phases.Count -ge 10) ("parsed " + $phases.Count + " phases from phases.rs") "could not parse HOOK_PHASES from phases.rs"

function Seed-Config([string] $exePath) {
  foreach ($f in $cfgFiles) {
    $groups = [ordered]@{}
    foreach ($p in $phases) {
      $cmd = '"' + $exePath + '" --pet-hook ' + $p
      $groups[$p] = @(@{ hooks = @(@{ type = "command"; command = $cmd; timeout = 2 }) })
    }
    # one user hook plus unrelated keys: the cleanup must not touch any of them
    $groups["PreToolUse"] = @(
      (@{ hooks = @(@{ type = "command"; command = "other-tool --notify"; timeout = 5 }) })
    ) + $groups["PreToolUse"]
    $obj = [ordered]@{
      theme = "dark"; note = "keep-me"
      mcpServers = [ordered]@{ fake = @{ command = "npx-server" } }
      hooks = $groups
    }
    Write-Json $f ($obj | ConvertTo-Json -Depth 10)
  }
}
function Count-Ours() {
  $n = 0
  foreach ($f in $cfgFiles) { $n += ([regex]::Matches((Read-Text $f), "--pet-hook")).Count }
  return $n
}
# count user entries AND unrelated keys: touching either one moves this number
function Count-Foreign() {
  $n = 0
  foreach ($f in $cfgFiles) {
    $t = Read-Text $f
    $n += ([regex]::Matches($t, "other-tool --notify")).Count
    $n += ([regex]::Matches($t, "keep-me")).Count
    $n += ([regex]::Matches($t, "npx-server")).Count
  }
  return $n
}
function Invoke-Installer([string[]] $switches) {
  $p = Start-Process -FilePath $installer.FullName -ArgumentList $switches -Wait -PassThru
  return $p.ExitCode
}
function Invoke-Uninstaller([string] $dir) {
  $un = Join-Path $dir "uninstall.exe"
  if (-not (Test-Path $un)) { throw ("no uninstaller in " + $dir) }
  # Start-Process inherits this session environment, so the exe the uninstaller
  # spawns sees the same PET_AGENT_CONFIG_FILES -- that is the whole point
  $p = Start-Process -FilePath $un -ArgumentList "/S" -Wait -PassThru
  return $p.ExitCode
}
# A GUI-subsystem child that PowerShell never waited for hands back a $null ExitCode.
# Reading that as OK was the false green this fix removes: an unavailable exit code is
# a hard failure, and the N1-N3 checks next to each consumer name it in the FAIL line.
function Ok-Exit($rc) { return ($null -ne $rc -and $rc -eq 0) }
function Clean-Dir([string] $dir) {
  if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

# --- Case A: uninstall must strip our entries ---------------------------------
$rootA = if ($InstallRoot) { $InstallRoot } else { Join-Path $env:TEMP ("pet-nsis-A-" + $PID) }
Step "case A: silent install -> seed -> real uninstall through NSIS"
Clean-Dir $rootA
$rc = Invoke-Installer @("/S", "/D=$rootA")
Check ($null -ne $rc) "silent install ExitCode captured" "exit code unavailable from the installer"
Check (Ok-Exit $rc) ("silent install exit " + $rc) ("silent install failed with exit " + $rc)
$exePath = Join-Path $rootA ($exeName + ".exe")
Check (Test-Path $exePath) ("installed binary present: " + $exePath) ("installed binary missing: " + $exePath)
if (-not (Test-Path $exePath)) { Write-Host "ABORT: nothing to uninstall." -ForegroundColor Red; exit 2 }

Seed-Config $exePath
$seeded = Count-Ours
$foreignSeeded = Count-Foreign
Check ($seeded -gt 0) ("seeded " + $seeded + " managed entries") "seeding produced no --pet-hook entries"
Check ($foreignSeeded -ge 3) ("fixture keeps " + $foreignSeeded + " user/unrelated markers") "fixture is too thin to prove anything"

# run the CLI branch on its own first: a red Case A can then be told apart from
Step "case A.1: the --pet-hook-cleanup branch on its own"
# desktop-pet.exe is a GUI-subsystem binary, so `& $exe ... 2>&1 | Out-String` neither
# waited for it nor handed it a stdout handle: the old measurement got a $null exit
# code (which Ok-Exit used to read as OK), an empty stdout, and it counted the entries
# while the cleaner was still running. Start-Process -Wait only returns once the
# process is gone, -PassThru gives the real ExitCode, -NoNewWindow with
# -RedirectStandardOutput gives the child a handle it can actually write into.
# run_cleanup_cli puts failure detail on stderr, so that gets a file too -- it is
# printed only as a diagnostic when the result line is missing; no judgment reads it.
$cliOutFile = Join-Path $env:TEMP ("pet-nsis-cleanup-stdout-" + $PID + ".txt")
$cliErrFile = Join-Path $env:TEMP ("pet-nsis-cleanup-stderr-" + $PID + ".txt")
$cli = Start-Process -FilePath $exePath -ArgumentList "--pet-hook-cleanup" -Wait -PassThru -NoNewWindow -RedirectStandardOutput $cliOutFile -RedirectStandardError $cliErrFile
$cliRc = $cli.ExitCode
# read AFTER the process exited; a missing or unreadable file normalises to "" so the
# judgment line below cannot throw and swallow the checks that follow -- "" still FAILs
$cliOut = Read-Text $cliOutFile
if ($null -eq $cliOut) { $cliOut = "" }
$cliErr = Read-Text $cliErrFile
if ($null -eq $cliErr) { $cliErr = "" }
Check ($null -ne $cliRc) "--pet-hook-cleanup ExitCode captured" "exit code unavailable from --pet-hook-cleanup"
Check (Ok-Exit $cliRc) "--pet-hook-cleanup exit code 0" ("--pet-hook-cleanup exit code " + $cliRc)
Check ($cliOut -match "result=done") ("stdout: " + $cliOut.Trim()) "stdout had no result=done line"
if ($cliOut -notmatch "result=done" -and $cliErr.Trim() -ne "") {
  Note ("cleanup stderr (diagnostic only): " + $cliErr.Trim())
}
Check ((Count-Ours) -eq 0) "CLI branch stripped every managed entry" ("CLI branch left " + (Count-Ours) + " entries")
Check ((Count-Foreign) -eq $foreignSeeded) "CLI branch kept user entries and other keys" "CLI branch changed the foreign/unrelated keys"
Remove-Item -Force -ErrorAction SilentlyContinue $cliOutFile, $cliErrFile

Step "case A.2: uninstall through NSIS (this is what the hook must do)"
Seed-Config $exePath
Check ((Count-Ours) -gt 0) "re-seeded before the uninstaller run" "re-seeding produced nothing"
$rc = Invoke-Uninstaller $rootA
Check ($null -ne $rc) "uninstaller ExitCode captured" "exit code unavailable from the uninstaller"
Check (Ok-Exit $rc) ("uninstaller exit " + $rc) ("uninstaller exit " + $rc)
Check ((Count-Ours) -eq 0) "NSIS uninstall stripped our entries (hook fired)" ("our entries survived the uninstall: " + (Count-Ours))
Check ((Count-Foreign) -eq $foreignSeeded) "uninstall kept user entries and other keys" "uninstall changed the foreign/unrelated keys"
Check (-not (Test-Path $exePath)) "installed binary removed by the uninstaller" "the exe is still there after uninstall"

# --- Case B: silent overwrite must NOT strip ----------------------------------
# B and C used to drop the exit code of every installer/uninstaller call: when an install
# failed the managed-entry count simply stayed put, and that stayed read as "the hooks
# survived". Same convention as case A -- keep the code, then fail hard when it is missing.
$rootB = Join-Path $env:TEMP ("pet-nsis-B-" + $PID)
Step "case B: silent overwrite install (the upgrade path)"
Clean-Dir $rootB
$rcB1 = Invoke-Installer @("/S", "/D=$rootB")
Check ($null -ne $rcB1) "case B: first install ExitCode captured" "case B: exit code unavailable from the first installer"
Check (Ok-Exit $rcB1) ("case B: first silent install exit " + $rcB1) ("case B: first silent install failed with exit " + $rcB1)
$exeB = Join-Path $rootB ($exeName + ".exe")
if (-not (Test-Path $exeB)) {
  Fail "case B: install produced no binary"
} else {
  Seed-Config $exeB
  $beforeB = Count-Ours
  Check ($beforeB -gt 0) "seeded before the overwrite" "seeding produced nothing"
  $rcBov = Invoke-Installer @("/S", "/D=$rootB")
  Check ($null -ne $rcBov) "case B: overwrite ExitCode captured" "case B: exit code unavailable from the overwrite installer"
  Check (Ok-Exit $rcBov) ("case B: silent overwrite exit " + $rcBov) ("case B: silent overwrite failed with exit " + $rcBov)
  $afterB = Count-Ours
  Check ($afterB -eq $beforeB) "silent overwrite kept the hooks in place" ("SILENT OVERWRITE STRIPPED THE HOOKS: " + $beforeB + " -> " + $afterB)
  $rcBu = Invoke-Uninstaller $rootB
  Check ($null -ne $rcBu) "case B: uninstaller ExitCode captured" "case B: exit code unavailable from the uninstaller"
  Check (Ok-Exit $rcBu) ("case B: uninstaller exit " + $rcBu) ("case B: uninstaller failed with exit " + $rcBu)
}

# --- Case C: passive overwrite, the known hole --------------------------------
$rootC = Join-Path $env:TEMP ("pet-nsis-C-" + $PID)
Step "case C: passive overwrite (/P) -- the mode Tauri routes through the old uninstaller"
Note "Tauri's reinstall page is skipped in silent mode, but passive mode calls"
Note "PageLeaveReinstall directly, and that path only appends /UPDATE when the"
Note "installer itself was started with /UPDATE. So /P is the mode that may"
Note "legitimately strip the hooks -- this case measures it, it does not assume."
Clean-Dir $rootC
$rcC1 = Invoke-Installer @("/S", "/D=$rootC")
Check ($null -ne $rcC1) "case C: first install ExitCode captured" "case C: exit code unavailable from the first installer"
Check (Ok-Exit $rcC1) ("case C: first silent install exit " + $rcC1) ("case C: first silent install failed with exit " + $rcC1)
$exeC = Join-Path $rootC ($exeName + ".exe")
if (-not (Test-Path $exeC)) {
  Fail "case C: install produced no binary"
} else {
  Seed-Config $exeC
  $beforeC = Count-Ours
  $rcCp = Invoke-Installer @("/P", "/D=$rootC")
  Check ($null -ne $rcCp) "case C: passive overwrite ExitCode captured" "case C: exit code unavailable from the passive overwrite"
  Check (Ok-Exit $rcCp) ("case C: passive overwrite exit " + $rcCp) ("case C: passive overwrite failed with exit " + $rcCp)
  $afterC = Count-Ours
  if ($afterC -eq $beforeC) {
    Pass "passive overwrite kept the hooks"
  } else {
    Note ("PASSIVE OVERWRITE STRIPPED THE HOOKS (" + $beforeC + " -> " + $afterC + ")")
    Note "Known gap: inside the hook we cannot tell 'invoked by another installer'"
    Note "from a genuine uninstall without reading the _?= parameter, which needs a"
    Note "Var of its own in the hook file. See the PR description for the follow-up."
    # install again so the exit assertion about leftovers still means something
    $rcCr = Invoke-Installer @("/S", "/D=$rootC")
    Check ($null -ne $rcCr) "case C: reinstall ExitCode captured" "case C: exit code unavailable from the reinstall"
    Check (Ok-Exit $rcCr) ("case C: reinstall after strip exit " + $rcCr) ("case C: reinstall after strip failed with exit " + $rcCr)
  }
  $rcCu = Invoke-Uninstaller $rootC
  Check ($null -ne $rcCu) "case C: uninstaller ExitCode captured" "case C: exit code unavailable from the uninstaller"
  Check (Ok-Exit $rcCu) ("case C: uninstaller exit " + $rcCu) ("case C: uninstaller failed with exit " + $rcCu)
}

Step "final state"
Check ((Count-Ours) -eq 0) "temp configs carry no managed entries at exit" ("leftovers: " + (Count-Ours) + " entries")

# --- summary -----------------------------------------------------------------
Step "summary"
foreach ($n in $notes) { Write-Host "  - $n" }
if ($failures.Count -eq 0) {
  Write-Host "`nRESULT failing=0 -- NSIS pre-uninstall cleanup verified on a real package."
  exit 0
}
Write-Host ("`nRESULT failing=" + $failures.Count)
foreach ($f in $failures) { Write-Host "  - $f" }
exit 1
