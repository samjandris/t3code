import { execFileSync } from "node:child_process";

const IOS_26_RUNTIME_SUFFIX = "iOS-26-0";
const PREFERRED_DEVICE_NAME = "iPhone 17 Pro";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function readDevices() {
  return JSON.parse(run("xcrun", ["simctl", "list", "devices", "available", "--json"]));
}

function ios26Devices(devicesByRuntime) {
  const runtimeKey = Object.keys(devicesByRuntime).find((key) =>
    key.endsWith(IOS_26_RUNTIME_SUFFIX),
  );
  if (!runtimeKey) {
    throw new Error("No available iOS 26.0 simulator runtime was found.");
  }
  return devicesByRuntime[runtimeKey] ?? [];
}

function pickDevice(devices) {
  const preferred = devices.find((device) => device.name === PREFERRED_DEVICE_NAME);
  const fallback = devices.find((device) => device.name.startsWith("iPhone "));
  const selected = preferred ?? fallback;
  if (!selected) {
    throw new Error("No available iPhone simulator was found for iOS 26.0.");
  }
  return selected;
}

function shutdownOtherBootedIosDevices(selectedUdid) {
  const booted = JSON.parse(run("xcrun", ["simctl", "list", "devices", "booted", "--json"]));
  for (const devices of Object.values(booted.devices ?? {})) {
    for (const device of devices) {
      if (device.udid === selectedUdid) {
        continue;
      }
      run("xcrun", ["simctl", "shutdown", device.udid], { stdio: "ignore" });
    }
  }
}

const outputMode = process.argv.includes("--udid") ? "udid" : "message";
const devices = readDevices();
const selected = pickDevice(ios26Devices(devices.devices ?? {}));

shutdownOtherBootedIosDevices(selected.udid);

if (selected.state !== "Booted") {
  run("xcrun", ["simctl", "boot", selected.udid], { stdio: "ignore" });
}

run("defaults", ["write", "com.apple.iphonesimulator", "CurrentDeviceUDID", selected.udid], {
  stdio: "ignore",
});

if (outputMode === "message") {
  run("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", selected.udid], {
    stdio: "ignore",
  });
}

console.log(
  outputMode === "udid"
    ? selected.udid
    : `[mobile] using iOS 26.0 simulator: ${selected.name} (${selected.udid})`,
);
