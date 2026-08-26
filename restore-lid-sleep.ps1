# Restores this laptop's original lid-close behavior (AC=Sleep,
# DC=Hibernate) and idle-timeout-to-sleep (3 minutes, this machine's
# original STANDBYIDLE value on both AC/DC) after trading hours. Paired
# with prevent-lid-sleep.ps1 — see that file's header and CLAUDE.md's
# Scheduling section for context.
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS 5ca83367-6e45-459f-a27b-476b1d01c936 1
powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS 5ca83367-6e45-459f-a27b-476b1d01c936 2
powercfg /change standby-timeout-ac 3
powercfg /change standby-timeout-dc 3
powercfg /setactive SCHEME_CURRENT
