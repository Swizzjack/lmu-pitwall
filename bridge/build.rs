use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    // Only embed icon when targeting Windows
    if env::var("CARGO_CFG_TARGET_OS").unwrap_or_default() != "windows" {
        return;
    }

    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir  = PathBuf::from(env::var("OUT_DIR").unwrap());

    let icon_path = manifest.join("assets").join("icon.ico");
    let rc_path   = out_dir.join("icon.rc");
    let res_path  = out_dir.join("icon.res");

    // Rerun only when the icon changes
    println!("cargo:rerun-if-changed=assets/icon.ico");

    if !icon_path.exists() {
        eprintln!("cargo:warning=assets/icon.ico not found — skipping icon embed");
        return;
    }

    // Write a minimal Win32 resource script
    let icon_str = icon_path
        .to_str()
        .expect("icon path is valid UTF-8")
        .replace('\\', "/");          // zig rc is fine with forward slashes on Linux
    fs::write(&rc_path, format!("IDI_ICON1 ICON \"{}\"\n", icon_str))
        .expect("write icon.rc");

    // Locate zig (prefer $HOME/.local/bin/zig, fall back to PATH)
    let zig = env::var("ZIG_PATH").unwrap_or_else(|_| {
        let home = env::var("HOME").unwrap_or_default();
        format!("{}/.local/bin/zig", home)
    });

    // "--" prevents zig rc from treating absolute Linux paths as /option flags
    let status = Command::new(&zig)
        .args(["rc", "--", rc_path.to_str().unwrap(), res_path.to_str().unwrap()])
        .status()
        .unwrap_or_else(|e| panic!("Failed to run `{} rc`: {}", zig, e));

    assert!(status.success(), "`zig rc` failed — icon will not be embedded");

    // LLD (used by cargo-zigbuild for windows-gnu) accepts .res files directly
    println!("cargo:rustc-link-arg={}", res_path.display());
}
