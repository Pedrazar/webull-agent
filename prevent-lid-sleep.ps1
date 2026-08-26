# Disables lid-close-triggered AND idle-timeout-triggered sleep so
# scheduled trading tasks can't be missed because the machine was asleep.
# Run at ~5:45am weekdays, paired with restore-lid-sleep.ps1 at ~1:30pm.
# See CLAUDE.md's Scheduling section for the incidents this fixes:
# - 2026-08-20: WebullDailyReview's 1:15pm trigger missed because the
#   laptop was in Modern Standby via LID CLOSE.
# - 2026-08-21: WebullDailyReview and WebullRestoreLidSleep both missed
#   their triggers (1:15pm/1:30pm) because the laptop entered Modern
#   Standby via plain IDLE TIMEOUT at 12:16pm (lid never closed — this
#   machine's STANDBYIDLE setting was only 180 seconds) and didn't wake
#   until 2:25pm. The lid-close fix alone didn't cover this. Windows'
#   post-wake catch-up for a missed task fails regardless of LogonType,
#   so preventing the sleep in the first place is the only real fix.
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS 5ca83367-6e45-459f-a27b-476b1d01c936 0
powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS 5ca83367-6e45-459f-a27b-476b1d01c936 0
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /setactive SCHEME_CURRENT
