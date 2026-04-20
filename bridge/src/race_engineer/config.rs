pub const PIPER_VERSION: &str = "2023.11.14-2";
pub const PIPER_WINDOWS_ZIP_URL: &str = "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip";

pub struct VoiceDefinition {
    pub id: &'static str,
    pub display_name: &'static str,
    pub language_tag: &'static str,
    pub description: &'static str,
    pub model_url: &'static str,
    pub config_url: &'static str,
    pub approx_size_mb: u32,
}

pub const VOICES: &[VoiceDefinition] = &[
    VoiceDefinition {
        id: "cori-gb-high",
        display_name: "Cori",
        language_tag: "en-GB",
        description: "British female, clear and calm",
        model_url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/cori/high/en_GB-cori-high.onnx",
        config_url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/cori/high/en_GB-cori-high.onnx.json",
        approx_size_mb: 110,
    },
    VoiceDefinition {
        id: "danny-us-low",
        display_name: "Danny",
        language_tag: "en-US",
        description: "US male, deep and grounded",
        model_url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/danny/low/en_US-danny-low.onnx",
        config_url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/danny/low/en_US-danny-low.onnx.json",
        approx_size_mb: 25,
    },
    VoiceDefinition {
        id: "northern-male-gb-medium",
        display_name: "Northern English",
        language_tag: "en-GB",
        description: "British male, classic race engineer vibe",
        model_url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx",
        config_url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx.json",
        approx_size_mb: 60,
    },
    VoiceDefinition {
        id: "joe-us-medium",
        display_name: "Joe",
        language_tag: "en-US",
        description: "US male, neutral and professional",
        model_url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/joe/medium/en_US-joe-medium.onnx",
        config_url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/joe/medium/en_US-joe-medium.onnx.json",
        approx_size_mb: 60,
    },
];
