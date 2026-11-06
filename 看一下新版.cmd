@echo off
set ROOT=%~dp0
start "" "%ROOT%release\win-unpacked\TextHarness.exe" --user-data-dir="%ROOT%.tmp\dev-userdata" "%ROOT%.tmp\demo-workspace\demo.md"