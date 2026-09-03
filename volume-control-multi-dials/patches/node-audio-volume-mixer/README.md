# Patched node-audio-volume-mixer addon

`addon.node` here is a rebuilt copy of [node-audio-volume-mixer](https://github.com/KaguraGateway/node-audio-volume-mixer)'s
native binary, with one function patched.

## Why

The upstream `GetProcessNameFromPid` (in `src/cpp/os/windows.cpp`) opens each process with
`OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, ...)` and reads its name with
`GetModuleBaseName`. That combination fails against processes Windows treats as protected -
notably games running anti-cheat components (War Thunder was the case that surfaced this) - and
the session silently comes back with an empty process name, making the app impossible to select.

The fix uses `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, ...)` paired with
`QueryFullProcessImageName` instead. `PROCESS_QUERY_LIMITED_INFORMATION` is a much lower-privilege
access right that succeeds against far more processes, and works fine with `QueryFullProcessImageName`
(unlike `GetModuleBaseName`, which needs the fuller `PROCESS_VM_READ` access this call avoids).

## How this gets applied

`rollup.config.mjs`'s `copy-native-modules` step copies the real npm package into the built plugin
as before, then overlays this `addon.node` on top of it - so every `npm install` (which re-fetches
the unpatched upstream binary) still ends up shipping the patched one after a build. This file is
the only thing that needs to be committed for the fix to survive a fresh clone + `npm install`.

## Rebuilding it

If you need to rebuild this (e.g. to patch something else, or after upstream changes):

1. Install a C++ toolchain: Visual Studio Build Tools with the "Desktop development with C++"
   workload, plus Python 3.
2. The patched source lives in `../node-audio-volume-mixer-src/` (a full local copy of the
   upstream package, not published anywhere - not part of the plugin's own dependency tree).
3. From that folder: `npm install node-addon-api node-gyp@latest --save-dev`, then
   `npx node-gyp rebuild`.
4. Copy the resulting `build/Release/addon.node` over this file.
