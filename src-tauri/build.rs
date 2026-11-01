fn main() {
    // Test binaries need the same Windows manifest the app binary gets.
    //
    // Tauri embeds a manifest in `veistra-orchestrator.exe` declaring a dependency
    // on ComCtl32 **v6**, the side-by-side assembly. It has to: the window
    // machinery, and now `rfd`'s folder picker, statically import
    // `TaskDialogIndirect`, which the ComCtl32 in System32 (v5.82) does not
    // export. Without the manifest the loader resolves that import against v5.82,
    // fails, and kills the process before `main` — `STATUS_ENTRYPOINT_NOT_FOUND`,
    // exit code 0xC0000139, and no message saying which symbol.
    //
    // Nothing embeds that manifest in a *test* binary, so `cargo test` died at
    // load the moment the picker made those imports reachable.
    //
    // `rustc-link-arg` covers every linked target rather than just tests, and it
    // has to: `rustc-link-arg-tests` reaches only `[[test]]` targets, and this
    // crate's tests are `#[cfg(test)] mod tests` inside the library, which cargo
    // builds as the lib-test target. Applying it everywhere is safe because
    // `/MANIFESTDEPENDENCY` only adds a `<dependency>` entry to the manifest the
    // linker generates, and it is asking for the assembly Tauri's own manifest
    // already declares — so the app binary ends up saying the same thing twice
    // rather than saying two different things.
    //
    // Emitted before `tauri_build::build()` because that call can exit the
    // process on a configuration error, and a directive after it would never
    // be printed.
    #[cfg(windows)]
    println!(
        "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' \
         name='Microsoft.Windows.Common-Controls' version='6.0.0.0' \
         processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
    );

    // `telemetry.rs` bakes these in with `option_env!`, which cargo does not
    // track on its own: without these lines, a build made after setting the key
    // would reuse the object compiled before it and ship without one.
    println!("cargo:rerun-if-env-changed=VEISTRA_POSTHOG_KEY");
    println!("cargo:rerun-if-env-changed=VEISTRA_POSTHOG_HOST");

    tauri_build::build()
}
