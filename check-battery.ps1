Add-Type -AssemblyName System.Windows.Forms
$ps = [System.Windows.Forms.SystemInformation]::PowerStatus
$pct = [int]($ps.BatteryLifePercent * 100)

if ($ps.PowerLineStatus -eq "Offline" -and $pct -lt 20) {
    Write-Output "[power] on battery at $pct percent, below the 20 percent threshold - skipping this run"
    exit 1
}

Write-Output "[power] ok to run (line status: $($ps.PowerLineStatus), battery: $pct percent)"
exit 0
