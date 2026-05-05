export async function wavBase64ToAudioBuffer(
  wavBase64: string,
  audioContext: AudioContext,
): Promise<AudioBuffer> {
  const binary = atob(wavBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return audioContext.decodeAudioData(bytes.buffer)
}
