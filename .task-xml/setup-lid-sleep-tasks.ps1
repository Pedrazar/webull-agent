# One-time elevated setup: registers WebullPreventLidSleep (5:45am) and
# WebullRestoreLidSleep (1:30pm) weekdays, both RunLevel=Highest +
# LogonType=S4U so they self-elevate silently every day with no UAC prompt.
# See CLAUDE.md's Scheduling section for why this exists.

$dir = "C:\Users\pedra\projects\webull-agent\.task-xml"

# schtasks /Create /XML insists on the file actually BEING UTF-16 bytes,
# regardless of what the XML declares — same quirk hit this morning.
# Re-save both as real UTF-16LE before importing.
foreach ($f in "prevent-lid-sleep.xml", "restore-lid-sleep.xml") {
    $path = Join-Path $dir $f
    (Get-Content $path -Raw) | Set-Content -Path $path -Encoding Unicode
}

schtasks /Create /TN "WebullPreventLidSleep" /XML "$dir\prevent-lid-sleep.xml" /F
schtasks /Create /TN "WebullRestoreLidSleep" /XML "$dir\restore-lid-sleep.xml" /F

Write-Output "--- verifying ---"
foreach ($t in "WebullPreventLidSleep", "WebullRestoreLidSleep") {
    $p = (Get-ScheduledTask -TaskName $t).Principal
    "$t -> LogonType=$($p.LogonType) RunLevel=$($p.RunLevel)"
}

Write-Output "--- smoke test: running WebullPreventLidSleep now ---"
schtasks /Run /TN "WebullPreventLidSleep"
Start-Sleep -Seconds 3
$val = Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes\$((powercfg /getactivescheme) -replace '.*GUID:\s*([0-9a-f-]+).*','$1')\4f971e89-eebd-4455-a8de-9e59040e7347\5ca83367-6e45-459f-a27b-476b1d01c936"
"AC=$($val.ACSettingIndex) DC=$($val.DCSettingIndex) (expect both 0 if the elevated run worked)"

Write-Output "--- restoring original values now that the test confirmed it works ---"
schtasks /Run /TN "WebullRestoreLidSleep"
Start-Sleep -Seconds 3
$val2 = Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes\$((powercfg /getactivescheme) -replace '.*GUID:\s*([0-9a-f-]+).*','$1')\4f971e89-eebd-4455-a8de-9e59040e7347\5ca83367-6e45-459f-a27b-476b1d01c936"
"AC=$($val2.ACSettingIndex) DC=$($val2.DCSettingIndex) (expect AC=1 DC=2, back to normal)"

"setup-lid-sleep-tasks.ps1 complete"
