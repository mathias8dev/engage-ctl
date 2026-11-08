export const Target = Object.freeze({ LINUX_X64: "linux-x64", LINUX_ARM64: "linux-arm64", MAC_X64: "darwin-x64", MAC_ARM64: "darwin-arm64", WINDOWS_X64: "windows-x64", WINDOWS_ARM64: "windows-arm64" });
export const TARGETS = Object.freeze([
  { target: Target.LINUX_X64, runner: "ubuntu-24.04" },
  { target: Target.LINUX_ARM64, runner: "ubuntu-24.04-arm" },
  { target: Target.MAC_X64, runner: "macos-15-intel" },
  { target: Target.MAC_ARM64, runner: "macos-15" },
  { target: Target.WINDOWS_X64, runner: "windows-2025" },
  { target: Target.WINDOWS_ARM64, runner: "windows-11-arm" },
]);
