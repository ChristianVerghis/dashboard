"""Live system performance, like Activity Monitor's CPU, Memory, Energy, Disk
and Network tabs.

System numbers come from psutil (CPU ticks, swap, disk counters), vm_stat
(Activity Monitor's memory breakdown: app, wired, compressed, cached files)
and the kernel's memory-pressure level. Per-app numbers come from the
kernel's per-process resource usage (proc_pid_rusage): CPU time, physical
footprint (Activity Monitor's Memory column) and bytes read and written, for
every process you own. System processes (WindowServer, kernel_task,
Spotlight) are not readable without root; their CPU and resident memory come
from `ps`, and they have no disk figure. Processes are grouped into apps by
their outermost .app bundle, so Chrome's helpers count as Google Chrome.

Energy: the whole machine's power draw is the SMC's PSTR key (watts, live,
read through the AppleSMC user client without root; the battery registry's
SystemLoad is the fallback but only refreshes about once a minute). Battery
state comes from the AppleSmartBattery registry entry. Per-app energy impact
is relative, from CPU time and wakeups, like Activity Monitor's (the kernel's
per-process energy counter reads near zero on this hardware). Apps keeping the Mac awake come from `pmset -g
assertions`. Network: interface counters from `netstat -ib` (psutil's wrap
at 4 GB on macOS), Wi-Fi, Ethernet and AirDrop links only, since loopback,
VPN tunnels and bridges would count the same bytes twice; per-app bytes from
`nettop -n -t external` (no name lookups, no localhost), which only runs
while the Network tab is open.

System tools are called by absolute path: the launchd job's PATH has no
/usr/sbin, where ioreg and netstat live.

Full sampling (every process) only runs while a page is watching: every 2 s,
stopping 30 s after the last request. System totals alone (no process scan)
are taken every 10 s in the background, so the charts open with the last ten
minutes instead of an empty plot.
"""
from __future__ import annotations

import ctypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from collections import deque

from fastapi import APIRouter

router = APIRouter()

INTERVAL_S = 2.0
BACKGROUND_S = 10.0
IDLE_STOP_S = 30.0
HISTORY = 300  # 10 min at 2 s
TOP_N = 8

try:
    import psutil
except ImportError:  # requirements.txt has it; keep the dashboard up without it
    psutil = None


# ---------------------------------------------------------------------------
# Kernel access (macOS): per-process rusage and the memory-pressure level
# ---------------------------------------------------------------------------

class _RUsageV4(ctypes.Structure):
    _fields_ = [("ri_uuid", ctypes.c_uint8 * 16)] + [(n, ctypes.c_uint64) for n in (
        "ri_user_time", "ri_system_time", "ri_pkg_idle_wkups", "ri_interrupt_wkups", "ri_pageins",
        "ri_wired_size", "ri_resident_size", "ri_phys_footprint", "ri_proc_start_abstime",
        "ri_proc_exit_abstime", "ri_child_user_time", "ri_child_system_time", "ri_child_pkg_idle_wkups",
        "ri_child_interrupt_wkups", "ri_child_pageins", "ri_child_elapsed_abstime", "ri_diskio_bytesread",
        "ri_diskio_byteswritten", "ri_cpu_time_qos_default", "ri_cpu_time_qos_maintenance",
        "ri_cpu_time_qos_background", "ri_cpu_time_qos_utility", "ri_cpu_time_qos_legacy",
        "ri_cpu_time_qos_user_initiated", "ri_cpu_time_qos_user_interactive", "ri_billed_system_time",
        "ri_serviced_system_time", "ri_logical_writes", "ri_lifetime_max_phys_footprint", "ri_instructions",
        "ri_cycles", "ri_billed_energy", "ri_serviced_energy", "ri_interval_max_phys_footprint",
        "ri_runnable_time")]


class _Timebase(ctypes.Structure):
    _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]


_libproc = _libc = None
_NS_PER_TICK = 1.0
if sys.platform == "darwin":
    try:
        _libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
        _libproc.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.POINTER(_RUsageV4)]
        _libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
        tb = _Timebase()
        _libc.mach_timebase_info(ctypes.byref(tb))
        _NS_PER_TICK = tb.numer / tb.denom if tb.denom else 1.0  # rusage CPU times are mach ticks
    except OSError:
        _libproc = _libc = None


def _rusage(pid: int) -> _RUsageV4 | None:
    if _libproc is None:
        return None
    buf = _RUsageV4()
    return buf if _libproc.proc_pid_rusage(pid, 4, ctypes.byref(buf)) == 0 else None


def _pressure() -> str:
    """kern.memorystatus_vm_pressure_level: 1 normal, 2 warning, 4 critical."""
    if _libc is None:
        return "unknown"
    val, size = ctypes.c_int(0), ctypes.c_size_t(4)
    if _libc.sysctlbyname(b"kern.memorystatus_vm_pressure_level", ctypes.byref(val), ctypes.byref(size), None, 0):
        return "unknown"
    return {1: "normal", 2: "warning", 4: "critical"}.get(val.value, "unknown")


def _vm_stat() -> dict[str, int]:
    """Activity Monitor's memory breakdown, in bytes."""
    try:
        out = subprocess.run(["/usr/bin/vm_stat"], capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.TimeoutExpired):
        return {}
    page = 16384
    pages: dict[str, int] = {}
    for line in out.splitlines():
        if "page size of" in line:
            page = int(line.split("page size of")[1].split()[0])
        name, _, value = line.partition(":")
        value = value.strip().rstrip(".")
        if value.isdigit():
            pages[name.strip().strip('"')] = int(value)
    def b(key: str) -> int:
        return pages.get(key, 0) * page
    app = max(0, b("Anonymous pages") - b("Pages purgeable"))
    return {"app": app, "wired": b("Pages wired down"), "compressed": b("Pages occupied by compressor"),
            "cached": b("File-backed pages") + b("Pages purgeable")}


# ---------------------------------------------------------------------------
# Grouping processes into apps
# ---------------------------------------------------------------------------

_NAMES = {"claude": "Claude Code", "node": "Node.js", "python3": "Python", "python": "Python",
          "kernel_task": "kernel"}
# runtimes that host many different things: named after the project they run in
_RUNTIMES = {"Python", "Node.js", "next-server", "uvicorn", "java", "ruby", "bun", "deno"}


def app_of(path: str) -> str:
    if ".app/" in path:
        return path.split(".app/", 1)[0].rsplit("/", 1)[-1]
    base = path.rsplit("/", 1)[-1]
    if "/claude/versions/" in path:
        return "Claude Code"
    if base.startswith("next-server"):
        return "next-server"  # "next-server (v16.3.4)": the version is noise here
    return _NAMES.get(base.lower(), _NAMES.get(base, base))  # Claude Code retitles itself "clAUDE"


_cwd_project: dict[int, str | None] = {}


def _project_of_pid(pid: int) -> str | None:
    """The ~/dev project a process runs in (its working directory), cached per pid."""
    if pid in _cwd_project:
        return _cwd_project[pid]
    project = None
    try:
        from . import projects as proj_mod
        cwd = psutil.Process(pid).cwd() if psutil else ""
        root = str(proj_mod.PROJECTS_ROOT.resolve()) + "/"
        if cwd.startswith(root):
            project = cwd[len(root):].split("/", 1)[0] or None
    except Exception:
        project = None
    if len(_cwd_project) > 4000:
        _cwd_project.clear()
    _cwd_project[pid] = project
    return project


# ---------------------------------------------------------------------------
# Energy and network sources
# ---------------------------------------------------------------------------

class _SMCVers(ctypes.Structure):
    _fields_ = [("major", ctypes.c_uint8), ("minor", ctypes.c_uint8), ("build", ctypes.c_uint8),
                ("reserved", ctypes.c_uint8), ("release", ctypes.c_uint16)]


class _SMCLimits(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint16), ("length", ctypes.c_uint16), ("cpu", ctypes.c_uint32),
                ("gpu", ctypes.c_uint32), ("mem", ctypes.c_uint32)]


class _SMCKeyInfo(ctypes.Structure):
    _fields_ = [("size", ctypes.c_uint32), ("type", ctypes.c_uint32), ("attributes", ctypes.c_uint8)]


class _SMCParam(ctypes.Structure):  # SMCKeyData_t, 80 bytes
    _fields_ = [("key", ctypes.c_uint32), ("vers", _SMCVers), ("limits", _SMCLimits), ("info", _SMCKeyInfo),
                ("result", ctypes.c_uint8), ("status", ctypes.c_uint8), ("cmd", ctypes.c_uint8),
                ("data32", ctypes.c_uint32), ("bytes", ctypes.c_uint8 * 32)]


_smc: tuple | None = None  # (iokit, connection), or (None, 0) once opening failed
_smc_info: dict[str, _SMCKeyInfo] = {}


def _smc_call(param: _SMCParam) -> _SMCParam | None:
    iokit, conn = _smc
    out = _SMCParam()
    size = ctypes.c_size_t(ctypes.sizeof(out))
    kr = iokit.IOConnectCallStructMethod(conn, 2, ctypes.byref(param), ctypes.sizeof(param),
                                         ctypes.byref(out), ctypes.byref(size))
    return out if kr == 0 and out.result == 0 else None


def _smc_float(key: str) -> float | None:
    """A float SMC key, such as PSTR (the whole Mac's power in watts)."""
    global _smc
    if _smc is None:
        _smc = (None, 0)
        try:
            iokit = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/IOKit.framework/IOKit")
            iokit.IOServiceMatching.restype = ctypes.c_void_p
            iokit.IOServiceMatching.argtypes = [ctypes.c_char_p]
            iokit.IOServiceGetMatchingService.restype = ctypes.c_uint32
            iokit.IOServiceGetMatchingService.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
            iokit.IOServiceOpen.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32,
                                            ctypes.POINTER(ctypes.c_uint32)]
            iokit.IOObjectRelease.argtypes = [ctypes.c_uint32]
            iokit.IOConnectCallStructMethod.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p,
                                                        ctypes.c_size_t, ctypes.c_void_p,
                                                        ctypes.POINTER(ctypes.c_size_t)]
            task = ctypes.c_uint32.in_dll(ctypes.CDLL(None), "mach_task_self_").value
            service = iokit.IOServiceGetMatchingService(0, iokit.IOServiceMatching(b"AppleSMC"))
            if service:
                conn = ctypes.c_uint32()
                if iokit.IOServiceOpen(service, task, 0, ctypes.byref(conn)) == 0:
                    _smc = (iokit, conn.value)
                iokit.IOObjectRelease(service)
        except (OSError, AttributeError, ValueError):
            pass
    if not _smc[1]:
        return None
    code = int.from_bytes(key.encode(), "big")
    info = _smc_info.get(key)
    if info is None:
        got = _smc_call(_SMCParam(key=code, cmd=9))  # read the key's type and size
        if got is None or got.info.type != int.from_bytes(b"flt ", "big") or got.info.size != 4:
            return None
        info = _smc_info[key] = got.info
    param = _SMCParam(key=code, cmd=5)  # read the bytes
    param.info.size = info.size
    got = _smc_call(param)
    if got is None:
        return None
    value = ctypes.c_float.from_buffer_copy(bytes(got.bytes[:4])).value
    return value if 0 <= value < 2000 else None


def _power() -> tuple[float | None, bool]:
    """The whole Mac's draw in watts, and whether it is a live reading."""
    live = _smc_float("PSTR")
    return (round(live, 2), True) if live is not None else (_battery().get("power_w"), False)


_battery_cache: tuple[float, dict] | None = None


def _battery() -> dict:
    """Power draw and battery state from the AppleSmartBattery registry entry.
    Empty on a Mac without a battery."""
    global _battery_cache
    if _battery_cache and time.time() - _battery_cache[0] < 4:
        return _battery_cache[1]
    try:
        text = subprocess.run(["/usr/sbin/ioreg", "-rn", "AppleSmartBattery", "-w0"], capture_output=True, text=True,
                              timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        text = ""
    out: dict = {}
    if text:
        def num(key: str) -> int | None:
            m = re.search(rf'"{key}" = (\d+)', text)
            return int(m.group(1)) if m else None

        def flag(key: str) -> bool | None:
            m = re.search(rf'"{key}" = (Yes|No)', text)
            return (m.group(1) == "Yes") if m else None

        amps, volts = num("InstantAmperage"), num("Voltage")
        if amps is not None and amps >= 2 ** 63:
            amps -= 2 ** 64  # reported as unsigned; negative while discharging
        load = re.search(r'"SystemLoad"=(\d+)', text)
        current, maximum = num("CurrentCapacity"), num("MaxCapacity")
        percent = current if maximum == 100 else (round(100 * current / maximum) if current and maximum else None)
        design, nominal = num("DesignCapacity"), num("NominalChargeCapacity")
        plugged, charging = flag("ExternalConnected"), flag("IsCharging")
        left = num("AvgTimeToFull") if charging else num("AvgTimeToEmpty")
        adapter = re.search(r'"AdapterDetails" = \{[^}]*"Watts"=(\d+)', text)
        out = {
            "power_w": int(load.group(1)) / 1000 if load else (abs(amps * volts) / 1e6 if amps is not None and volts else None),
            "percent": percent, "plugged": plugged, "charging": charging, "full": flag("FullyCharged"),
            "minutes_left": left if left is not None and left < 6000 else None,
            "cycles": num("CycleCount"),
            "health": round(100 * nominal / design) if nominal and design else None,
            "adapter_w": int(adapter.group(1)) if adapter else None,
        }
    _battery_cache = (time.time(), out)
    return out


_ASSERTION = re.compile(r'pid (\d+)\(([^)]*)\): \[[^\]]*\] (\d+:\d+:\d+) (\w+) named: "([^"]*)"')
_KEEPS_AWAKE = {"PreventUserIdleSystemSleep", "PreventSystemSleep", "NoIdleSleepAssertion",
                "PreventUserIdleDisplaySleep", "NoDisplaySleepAssertion"}
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
_assert_cache: tuple[float, list] | None = None


def _sleep_blockers() -> list[dict]:
    """Processes holding an assertion that keeps the Mac (or its display)
    awake. powerd's own "display is on" assertion is bookkeeping, not a cause.
    The reason is the assertion's name, or the bundle id runningboardd holds
    it for ("xpcservice<com.apple.stocks.widget(...)>" -> the widget)."""
    global _assert_cache
    if _assert_cache and time.time() - _assert_cache[0] < 10:
        return _assert_cache[1]
    try:
        text = subprocess.run(["/usr/bin/pmset", "-g", "assertions"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        text = ""
    out, seen = [], set()
    for pid, process, held, kind, reason in _ASSERTION.findall(text):
        if kind not in _KEEPS_AWAKE or process == "powerd" or (pid, kind) in seen:
            continue
        seen.add((pid, kind))
        m = re.match(r"\w+<([\w.-]+)", reason)
        reason = m.group(1) if m else _UUID.sub("", reason).strip(" .:-")[:60]
        out.append({"pid": int(pid), "process": process, "kind": "display" if "Display" in kind else "system",
                    "reason": reason or kind, "held": held})
    _assert_cache = (time.time(), out)
    return out


_NICS = ("en", "awdl", "llw")  # Wi-Fi, Ethernet, Thunderbolt and USB links, AirDrop


def _net_counters() -> tuple[int, int, int, int] | None:
    """Bytes and packets in and out since boot on the physical interfaces.
    `netstat -ib` has the 64-bit counters; psutil's wrap every 4 GB here."""
    try:
        out = subprocess.run(["/usr/sbin/netstat", "-ibn"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    rx = tx = prx = ptx = 0
    seen = False
    for line in out.splitlines()[1:]:
        f = line.split()
        # one <Link#n> row per interface; read from the right, since the address column can be empty
        if len(f) < 10 or not f[2].startswith("<Link#") or not f[0].rstrip("*").startswith(_NICS):
            continue
        try:
            prx, rx, ptx, tx = prx + int(f[-7]), rx + int(f[-5]), ptx + int(f[-4]), tx + int(f[-2])
        except ValueError:
            continue
        seen = True
    return (rx, tx, prx, ptx) if seen else None


def _nettop() -> dict[int, tuple[int, int]]:
    """Bytes in and out per process, all interfaces but loopback. `-n` skips
    name lookups, which otherwise cost seconds per call."""
    try:
        out = subprocess.run(["/usr/bin/nettop", "-P", "-n", "-L", "1", "-x", "-t", "external", "-J", "bytes_in,bytes_out"],
                             capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return {}
    rows: dict[int, tuple[int, int]] = {}
    for line in out.splitlines()[1:]:
        parts = line.split(",")
        if len(parts) < 3 or "." not in parts[0]:
            continue
        pid = parts[0].rsplit(".", 1)[1]
        if pid.isdigit() and parts[1].isdigit() and parts[2].isdigit():
            rows[int(pid)] = (int(parts[1]), int(parts[2]))
    return rows


def _net_rates(dt: float) -> dict:
    now_c = _net_counters()
    last = _prev.get("net")
    _prev["net"] = now_c
    if not now_c or not last:
        return {"in_bps": 0.0, "out_bps": 0.0, "packets_in_ps": 0.0, "packets_out_ps": 0.0,
                "total_in": now_c[0] if now_c else 0, "total_out": now_c[1] if now_c else 0}
    d = [max(0, a - b) / dt for a, b in zip(now_c, last)]
    return {"in_bps": d[0], "out_bps": d[1], "packets_in_ps": d[2], "packets_out_ps": d[3],
            "total_in": now_c[0], "total_out": now_c[1]}


# which tabs the page has asked for in the last 20 s: the per-app network
# scan only runs while the Network tab is open
_want: dict[str, float] = {}


def _wants(tab: str) -> bool:
    return _want.get(tab, 0.0) > time.time()


def _nettop_sample() -> tuple[float, dict[int, tuple[int, int]]]:
    return time.time(), _nettop()


# ---------------------------------------------------------------------------
# Sampler
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_sampling = threading.Lock()  # the live and background samplers share counters: one at a time
_thread: threading.Thread | None = None
_last_request = 0.0
_history: deque = deque(maxlen=HISTORY)
_latest: dict | None = None
_prev: dict = {}  # previous counters: cpu_times, disk, network, per-pid rusage and nettop


def _ps() -> list[tuple[int, float, int, str]]:
    try:
        out = subprocess.run(["/bin/ps", "-axo", "pid=,pcpu=,rss=,comm="], capture_output=True, text=True,
                             timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    rows = []
    for line in out.splitlines():
        parts = line.split(None, 3)
        if len(parts) == 4 and parts[0].isdigit():
            try:
                rows.append((int(parts[0]), float(parts[1]), int(parts[2]) * 1024, parts[3]))
            except ValueError:
                continue
    return rows


def _sample() -> dict:
    with _sampling:
        return _sample_locked()


def _sample_locked() -> dict:
    now = time.time()
    dt = max(0.5, now - _prev.get("t", now - INTERVAL_S))
    warm = "cpu" in _prev  # the first sample only primes the counters: no rates yet

    # CPU, system-wide: share of all cores' time since the last sample
    cpu = {"user": 0.0, "system": 0.0, "idle": 100.0}
    if psutil:
        ct = psutil.cpu_times()
        last = _prev.get("cpu")
        if last:
            d = {k: getattr(ct, k) - getattr(last, k) for k in ("user", "system", "idle", "nice")}
            total = sum(d.values()) or 1.0
            cpu = {"user": 100 * (d["user"] + d["nice"]) / total, "system": 100 * d["system"] / total,
                   "idle": 100 * d["idle"] / total}
        _prev["cpu"] = ct
    load = os.getloadavg() if hasattr(os, "getloadavg") else (0.0, 0.0, 0.0)

    # memory
    vm = psutil.virtual_memory() if psutil else None
    sw = psutil.swap_memory() if psutil else None
    parts = _vm_stat()
    total_mem = vm.total if vm else 0
    used = parts.get("app", 0) + parts.get("wired", 0) + parts.get("compressed", 0) if parts else (vm.used if vm else 0)
    memory = {"total": total_mem, "used": used, **parts,
              "swap_used": sw.used if sw else 0, "swap_total": sw.total if sw else 0,
              "pressure": _pressure()}

    # disk: system throughput and the data volume's capacity
    read_bps = write_bps = reads_ps = writes_ps = 0.0
    if psutil:
        io = psutil.disk_io_counters()
        last = _prev.get("disk")
        if io and last:
            read_bps = max(0, io.read_bytes - last.read_bytes) / dt
            write_bps = max(0, io.write_bytes - last.write_bytes) / dt
            reads_ps = max(0, io.read_count - last.read_count) / dt
            writes_ps = max(0, io.write_count - last.write_count) / dt
        _prev["disk"] = io
    volume = "/System/Volumes/Data" if os.path.isdir("/System/Volumes/Data") else "/"
    du = shutil.disk_usage(volume)
    disk = {"read_bps": read_bps, "write_bps": write_bps, "reads_ps": reads_ps, "writes_ps": writes_ps,
            "capacity": {"total": du.total, "used": du.used, "free": du.free, "volume": volume}}

    net = _net_rates(dt)
    battery = _battery()
    power_w, power_live = _power()

    # per-process network bytes, only while the Network tab is open; nettop
    # keeps its own clock since a request can prime it between samples
    nt = _nettop_sample() if _wants("network") else None
    nt_last = _prev.get("nt")
    _prev["nt"] = nt
    nt_dt = nt[0] - nt_last[0] if nt and nt_last else 0.0
    now_nt, last_nt = (nt[1], nt_last[1]) if nt_dt > 0.2 else ({}, {})
    net["apps_live"] = nt_dt > 0.2

    # processes -> apps
    last_ru: dict[int, tuple] = _prev.get("ru", {})
    now_ru: dict[int, tuple] = {}
    apps: dict[str, dict] = {}
    names: dict[int, str] = {}
    for pid, pcpu, rss, path in _ps():
        r = _rusage(pid)
        p_wake = 0.0
        if r is not None:
            cpu_ns = (r.ri_user_time + r.ri_system_time) * _NS_PER_TICK
            wakeups = r.ri_pkg_idle_wkups + r.ri_interrupt_wkups
            now_ru[pid] = (cpu_ns, r.ri_diskio_bytesread, r.ri_diskio_byteswritten, wakeups)
            prev = last_ru.get(pid)
            if prev:
                p_cpu = 100 * max(0.0, cpu_ns - prev[0]) / (dt * 1e9)
                p_read = max(0, r.ri_diskio_bytesread - prev[1]) / dt
                p_write = max(0, r.ri_diskio_byteswritten - prev[2]) / dt
                p_wake = max(0, wakeups - prev[3]) / dt
            else:
                p_cpu, p_read, p_write = pcpu, 0.0, 0.0
            p_mem, readable = r.ri_phys_footprint, True
        else:
            p_cpu, p_mem, p_read, p_write, readable = pcpu, rss, 0.0, 0.0, False
        b_now, b_last = now_nt.get(pid), last_nt.get(pid)
        p_in = max(0, b_now[0] - b_last[0]) / nt_dt if b_now and b_last else 0.0
        p_out = max(0, b_now[1] - b_last[1]) / nt_dt if b_now and b_last else 0.0
        name = app_of(path)
        if name in _RUNTIMES and readable:
            project = _project_of_pid(pid)
            if project:
                name = f"{name} · {project}"
        names[pid] = name
        a = apps.setdefault(name, {"app": name, "processes": 0, "cpu": 0.0, "memory": 0, "read_bps": 0.0,
                                   "write_bps": 0.0, "wakeups": 0.0, "in_bps": 0.0, "out_bps": 0.0,
                                   "system": False})
        a["processes"] += 1
        a["cpu"] += p_cpu
        a["memory"] += p_mem
        a["read_bps"] += p_read
        a["write_bps"] += p_write
        a["wakeups"] += p_wake
        a["in_bps"] += p_in
        a["out_bps"] += p_out
        a["system"] = a["system"] or not readable
    _prev["ru"] = now_ru
    _prev["t"] = now

    # who is keeping the Mac awake, by app; caffeinate is credited to whoever
    # started it (Claude Code runs it while working)
    awake = []
    for b in _sleep_blockers():
        if b["pid"] not in names:
            continue  # exited since the cached read, and its assertion went with it
        owner = b["pid"]
        if b["process"] == "caffeinate" and psutil:
            try:
                owner = psutil.Process(owner).ppid()
            except Exception:
                pass
        awake.append({**b, "app": names.get(owner) or names[b["pid"]],
                      "reason": "caffeinate" if b["process"] == "caffeinate" else b["reason"]})
    energy = {**battery, "power_w": power_w, "power_live": power_live, "keeping_awake": awake}

    rows = list(apps.values())
    for a in rows:
        # relative, like Activity Monitor's Energy Impact: CPU time plus a cost per wakeup
        a["energy"] = round(a["cpu"] + 0.02 * a["wakeups"], 1)
    top = {
        "cpu": sorted(rows, key=lambda a: -a["cpu"])[:TOP_N],
        "memory": sorted(rows, key=lambda a: -a["memory"])[:TOP_N],
        "energy": sorted(rows, key=lambda a: -a["energy"])[:TOP_N],
        "disk": sorted(rows, key=lambda a: -(a["read_bps"] + a["write_bps"]))[:TOP_N],
        "network": sorted(rows, key=lambda a: -(a["in_bps"] + a["out_bps"]))[:TOP_N] if now_nt else [],
    }
    for lst in top.values():
        for a in lst:
            a["cpu"] = round(a["cpu"], 1)
            a["wakeups"] = round(a["wakeups"])
    sample = {"t": now, "cores": os.cpu_count() or 1, "load": [round(x, 2) for x in load],
              "cpu": {k: round(v, 1) for k, v in cpu.items()}, "memory": memory, "disk": disk,
              "energy": energy, "network": net,
              "top": top, "processes": sum(a["processes"] for a in rows), "warm": warm}
    if not warm:
        return sample
    _history.append({"t": round(now, 1), "user": sample["cpu"]["user"], "system": sample["cpu"]["system"],
                     "mem_used": used, "pressure": memory["pressure"], "swap_used": memory["swap_used"],
                     "read_bps": round(read_bps), "write_bps": round(write_bps),
                     "in_bps": round(net["in_bps"]), "out_bps": round(net["out_bps"]), "power_w": power_w})
    return sample


def _sample_system() -> None:
    """CPU, memory and disk totals for the history, without the process scan."""
    with _sampling:
        _sample_system_locked()


def _sample_system_locked() -> None:
    now = time.time()
    dt = max(0.5, now - _prev.get("t", now - BACKGROUND_S))
    ct = psutil.cpu_times()
    last = _prev.get("cpu")
    _prev["cpu"] = ct
    io = psutil.disk_io_counters()
    last_io = _prev.get("disk")
    _prev["disk"] = io
    _prev["t"] = now
    if not last:
        return
    d = {k: getattr(ct, k) - getattr(last, k) for k in ("user", "system", "idle", "nice")}
    total = sum(d.values()) or 1.0
    parts = _vm_stat()
    vm = psutil.virtual_memory()
    used = parts.get("app", 0) + parts.get("wired", 0) + parts.get("compressed", 0) if parts else vm.used
    read_bps = max(0, io.read_bytes - last_io.read_bytes) / dt if io and last_io else 0.0
    write_bps = max(0, io.write_bytes - last_io.write_bytes) / dt if io and last_io else 0.0
    net = _net_rates(dt)
    _history.append({"t": round(now, 1), "user": round(100 * (d["user"] + d["nice"]) / total, 1),
                     "system": round(100 * d["system"] / total, 1), "mem_used": used,
                     "pressure": _pressure(), "swap_used": psutil.swap_memory().used,
                     "read_bps": round(read_bps), "write_bps": round(write_bps),
                     "in_bps": round(net["in_bps"]), "out_bps": round(net["out_bps"]), "power_w": _power()[0]})


async def background_loop() -> None:
    """Started from the app lifespan: system totals every 10 s whenever the
    full sampler is idle, so the charts always have recent history."""
    import asyncio
    if psutil is None:
        return
    while True:
        try:
            if _thread is None:
                await asyncio.to_thread(_sample_system)
        except Exception:
            pass
        await asyncio.sleep(BACKGROUND_S)


def _run() -> None:
    global _latest, _thread
    while True:
        with _sampling, _lock:
            if time.time() - _last_request >= IDLE_STOP_S:
                # nobody is watching: stop, and drop what would be stale when someone looks
                # again (the last sample, and per-app counters only this loop keeps, which
                # would otherwise be divided by the background sampler's shorter interval)
                _thread = None
                _latest = None
                _prev.pop("ru", None)
                _prev.pop("nt", None)
                return
        started = time.time()
        try:
            s = _sample()
            with _lock:
                _latest = s
        except Exception as exc:  # keep sampling; one bad read should not end the monitor
            print(f"[perf] sample failed: {exc!r}", file=sys.stderr)
        time.sleep(max(0.2, INTERVAL_S - (time.time() - started)))


def _ensure_running() -> None:
    global _thread, _last_request
    _last_request = time.time()
    with _lock:
        if _thread is not None:
            return
        _thread = threading.Thread(target=_run, name="perf-sampler", daemon=True)
        _thread.start()


@router.get("/api/perf")
def api_perf(history: int = 1, tab: str | None = None):
    """The latest sample plus up to 10 minutes of system history. The first
    request after a quiet spell waits for two samples so rates are real.
    `tab` says which view is open, so its costlier extra (the per-app
    network scan) runs only while someone looks at it."""
    if psutil is None:
        return {"available": False, "reason": "psutil is not installed (pip install -r requirements.txt)"}
    if tab == "network":
        first = not _wants("network")
        _want["network"] = time.time() + 20
        if first and _thread is not None:
            # prime the per-app counters now, so the next sample already has rates
            with _sampling:
                _prev["nt"] = _nettop_sample()
    _ensure_running()
    deadline = time.time() + 2 * INTERVAL_S + 1
    while time.time() < deadline:
        with _lock:
            ready = _latest is not None and _latest.get("warm")
        if ready:
            break
        time.sleep(0.1)
    with _lock:
        latest = dict(_latest) if _latest else None
        hist = list(_history) if history else []
    return {"available": latest is not None, "interval": INTERVAL_S, "sample": latest, "history": hist}
