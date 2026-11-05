@ECHO off
REM Runs this checkout's build of the agent; see packages/veistra-agent/README.md.
node "%~dp0..\dist\cli.js" %*
