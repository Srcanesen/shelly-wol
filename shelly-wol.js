let CONFIG = {
  mac: "",
  broadcast: "", // LAN broadcast address, without the port.
  port: 9,
  repeats: 3,
  httpTrigger: true,
  switchTrigger: true
};

let SAVED_KEY = "shelly-wol.saved";
// Some firmware loses or rejects KVS keys with dots.
let RECOVERY_KEY = "shelly-wol-saved";
let logTarget = CONFIG.broadcast + ":" + CONFIG.port;
let busy = false;
let restoreFailed = false;
let previousLogTarget = null;
let packet = "";

function buildPacket(mac) {
  let formatError = "shelly-wol: Set CONFIG.mac to six colon-separated hex bytes.";
  if (typeof mac !== "string") {
    print(formatError);
    return false;
  }
  let parts = mac.split(":");
  let hex = "0123456789abcdefABCDEF";
  let bytes = "";
  if (parts.length !== 6) {
    print(formatError);
    return false;
  }

  for (let i = 0; i < parts.length; i++) {
    let part = parts[i];
    if (part.length !== 2 || hex.indexOf(part.slice(0, 1)) < 0 ||
        hex.indexOf(part.slice(1, 2)) < 0) {
      print(formatError);
      return false;
    }
    let byte = parseInt(part, 16);
    if (byte === 0 || byte === 10) {
      print("shelly-wol: MAC contains 00 or 0A, which UDP logging cannot carry.");
      return false;
    }
    bytes += String.fromCharCode(byte);
  }

  for (let j = 0; j < 6; j++) packet += String.fromCharCode(255);
  for (let k = 0; k < 16; k++) packet += bytes;
  return true;
}

function setLogTarget(addr, callback, userdata) {
  Shelly.call("Sys.SetConfig", { config: { debug: { udp: { addr: addr } } } }, callback, userdata);
}

function getLogTarget() {
  let sys = Shelly.getComponentConfig("sys");
  if (sys && sys.debug && sys.debug.udp) return sys.debug.udp.addr;
}

function onRecoveryKeyDeleted(result, error, message) {
  busy = false;
  if (error === 0 || error === -105) return;
  restoreFailed = true;
  print("shelly-wol: Could not delete the saved UDP log target: " + message);
}

function onSavedKeyDeleted(result, error, message) {
  if (error !== 0 && error !== -105 && error !== -103) {
    onRecoveryKeyDeleted(result, error, message);
    return;
  }
  Shelly.call("KVS.Delete", { key: RECOVERY_KEY }, onRecoveryKeyDeleted);
}

function onLogTargetRestored(result, error, message, retryDelay) {
  if (error === 0) {
    Shelly.call("KVS.Delete", { key: SAVED_KEY }, onSavedKeyDeleted);
    return;
  }
  if (retryDelay <= 4000) {
    Timer.set(retryDelay, false, restoreLogTarget, retryDelay * 2);
    return;
  }
  restoreFailed = true;
  busy = false;
  print("shelly-wol: Could not restore the UDP log target. Restart the script to retry: " + message);
}

function restoreLogTarget(retryDelay) {
  setLogTarget(previousLogTarget, onLogTargetRestored, retryDelay);
}

function sendPackets() {
  for (let i = 0; i < CONFIG.repeats; i++) print(packet);
  Timer.set(1500, false, restoreLogTarget, 250); // Let queued log lines drain.
}

function onLogTargetSet(result, error, message) {
  if (error !== 0) {
    restoreLogTarget(250);
    print("shelly-wol: Could not set the UDP log target: " + message);
    return;
  }
  Timer.set(1000, false, sendPackets); // Let the logger switch destinations.
}

function onSavedTarget(result, error, message) {
  if (error !== 0 && error !== -103) {
    busy = false;
    print("shelly-wol: Could not save the UDP log target: " + message);
    return;
  }
  // Another instance may have redirected the logger while KVS was writing.
  if (getLogTarget() !== previousLogTarget) {
    busy = false;
    return;
  }
  setLogTarget(logTarget, onLogTargetSet, null);
}

function onRecoveryTargetSaved(result, error, message) {
  if (error !== 0) {
    busy = false;
    print("shelly-wol: Could not save the UDP log target: " + message);
    return;
  }
  Shelly.call("KVS.Set", { key: SAVED_KEY, value: previousLogTarget }, onSavedTarget);
}

function recoverLogTarget(result, error, message, key) {
  if (error === -105 && key === RECOVERY_KEY) {
    Shelly.call("KVS.Get", { key: SAVED_KEY }, recoverLogTarget, SAVED_KEY);
    return;
  }
  if (error === 0 && getLogTarget() === logTarget) {
    previousLogTarget = result.value;
    restoreLogTarget(250);
    return;
  }
  busy = false;
  if (error !== 0 && error !== -105 && !(error === -103 && key === SAVED_KEY)) {
    print("shelly-wol: Could not read the saved UDP log target: " + message);
  }
}

function wake() {
  if (busy) return 409;
  let current = getLogTarget();
  if (current === logTarget) return 409;
  if (restoreFailed) return 503;
  if (typeof current === "undefined") {
    print("shelly-wol: Unable to read the current UDP log target.");
    return 503;
  }

  // The UDP log destination is device-wide, so serialize wake requests.
  previousLogTarget = current;
  busy = true;
  Shelly.call("KVS.Set", { key: RECOVERY_KEY, value: previousLogTarget }, onRecoveryTargetSaved);
  return 202;
}

function start() {
  if (CONFIG.broadcast !== "" && getLogTarget() === logTarget) {
    busy = true;
    Shelly.call("KVS.Get", { key: RECOVERY_KEY }, recoverLogTarget, RECOVERY_KEY);
  }
  if (!buildPacket(CONFIG.mac)) return;
  if (CONFIG.broadcast === "") {
    print("shelly-wol: Set CONFIG.broadcast to the LAN broadcast address.");
    return;
  }

  if (CONFIG.httpTrigger) {
    HTTPServer.registerEndpoint("wake", function (request, response) {
      let code = wake();
      response.code = code;
      if (code === 202) response.body = "Wake request accepted";
      if (code === 409) response.body = "Wake already in progress";
      if (code === 503) response.body = "UDP log target unavailable. Check the script logs.";
      response.send();
    });
  }

  if (CONFIG.switchTrigger) {
    Shelly.addStatusHandler(function (status) {
      if (status.component === "switch:0" && status.delta && status.delta.output === true) {
        wake();
      }
    });
  }
}

start();
