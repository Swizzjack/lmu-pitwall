use std::path::PathBuf;

pub fn app_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("LMUPitwall")
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(".local/share/LMUPitwall")
    }
}

pub fn piper_dir() -> PathBuf {
    app_data_dir().join("piper")
}

pub fn piper_exe() -> PathBuf {
    piper_dir().join("piper.exe")
}

pub fn voices_dir() -> PathBuf {
    app_data_dir().join("voices")
}

pub fn voice_model(id: &str) -> PathBuf {
    voices_dir().join(format!("{id}.onnx"))
}

pub fn voice_config(id: &str) -> PathBuf {
    voices_dir().join(format!("{id}.onnx.json"))
}
