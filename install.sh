#!/usr/bin/env bash
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <device-ip> <MAC>" >&2
  exit 2
fi

exec python3 - "$(dirname "$0")/shelly-wol.js" "$@" <<'PY'
import ipaddress
import json
import re
import signal
import sys
from pathlib import Path
from urllib.request import ProxyHandler, Request, build_opener

source, host, mac = sys.argv[1:]
if not re.fullmatch(r"(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}", mac):
    sys.exit("Invalid MAC: use six colon-separated hex bytes.")
if {"00", "0A"}.intersection(mac.upper().split(":")):
    sys.exit("Invalid MAC: UDP logging cannot carry 00 or 0A bytes.")
try:
    ip = ipaddress.IPv4Address(host)
except ValueError:
    sys.exit("Invalid device IP: use the Shelly's local IPv4 address.")

opener = build_opener(ProxyHandler({}))

def rpc(method, **params):
    payload = json.dumps({"id": 1, "method": method, "params": params}).encode()
    request = Request(f"http://{ip}/rpc", payload, {"Content-Type": "application/json"})
    with opener.open(request, timeout=10) as response:
        reply = json.load(response)
    if "error" in reply:
        raise RuntimeError(f'{method}: {reply["error"].get("message", reply["error"])}')
    return reply["result"]

def cancel_install(signum, frame):
    sys.exit(128 + signum)

cancel_signals = {signal.SIGINT, signal.SIGTERM}
for signum in cancel_signals:
    signal.signal(signum, cancel_install)

script_id = None
installed = False
try:
    code = Path(source).read_text(encoding="utf-8")
    code = re.sub(r'^(  mac: )"[^"]*"', rf'\g<1>"{mac.upper()}"', code, count=1, flags=re.M)
    broadcast = ipaddress.IPv4Network(f"{ip}/24", strict=False).broadcast_address
    code = code.replace('  broadcast: "",', f'  broadcast: "{broadcast}",', 1)

    if any(script.get("name") == "shelly-wol" for script in rpc("Script.List")["scripts"]):
        sys.exit("shelly-wol already exists. Edit it in the Shelly web interface.")
    # Handle cancellation after recording the ID, even if it arrives during Create.
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, cancel_signals)
    try:
        script_id = rpc("Script.Create", name="shelly-wol")["id"]
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
    # Use small chunks for firmware with limited RPC request sizes.
    for offset in range(0, len(code), 1024):
        rpc("Script.PutCode", id=script_id, code=code[offset:offset + 1024], append=offset > 0)
    rpc("Script.SetConfig", id=script_id, config={"enable": True})
    rpc("Script.Start", id=script_id)
    if not rpc("Script.GetStatus", id=script_id)["running"]:
        raise RuntimeError("The script did not stay running.")
    installed = True
except (OSError, ValueError, KeyError, RuntimeError) as error:
    sys.exit(f"Installation failed: {error}")
finally:
    if script_id is not None and not installed:
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, cancel_signals)
        try:
            try:
                rpc("Script.Stop", id=script_id)
            except (OSError, ValueError, KeyError, RuntimeError):
                pass  # Still try to delete the slot.
            rpc("Script.Delete", id=script_id)
        except (OSError, ValueError, KeyError, RuntimeError):
            print(f"Remove the incomplete script {script_id} in the Shelly web interface.", file=sys.stderr)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)

print(f"Installed script {script_id}. Wake endpoint: http://{ip}/script/{script_id}/wake")
PY
