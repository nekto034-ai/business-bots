"""Xiaomi cloud bridge for the fitness site.

Mi Fitness uploads band data (steps, heart rate, sleep, SpO2, stress, workouts) to the
Xiaomi cloud. This service logs in to Artem's own Xiaomi account by QR code (through the
`mifit` library, unofficial) and pulls that data every hour into STATE_DIR, so it does not
depend on Health Connect or on the phone keeping Mi Fitness awake.

It listens on 127.0.0.1 only; the fitness site (server.js) does the Basic auth and proxies
/xiaomi/* here. The Xiaomi session (an account-level token) stays in STATE_DIR/.mifit and
never leaves the server.
"""

import base64
import dataclasses
import datetime as dt
import json
import os
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import requests
from mifit import MiFit
from mifit.auth.qr import exchange_sts, new_device_id, poll_qr_login, request_qr_login
from mifit.auth.session import load_session, save_session
from mifit.errors import NotificationRequiredError
from mifit.mcp_server.login import qr_png
from mifit.region import SID

PORT = int(os.environ.get("PORT", "8091"))
STATE = Path(os.environ.get("STATE_DIR", "/var/lib/fitness-xiaomi"))
DATA = STATE / "data"
DAILY = STATE / "daily"
STATUS_FILE = STATE / "status.json"
# The account lives on the Russian Xiaomi servers; used when the login carries no region.
FALLBACK_REGION = os.environ.get("XIAOMI_REGION", "ru")
SYNC_EVERY_S = 3600
RECENT_DAYS = 3      # hourly sync: today and the two days before (sleep lands late)
FIRST_DAYS = 30      # right after a login: the last month
HERE = Path(__file__).resolve().parent

DAILY_DOMAINS = ["steps", "heart_rate_daily", "consumption", "sleep", "spo2_daily",
                 "stress_daily", "activity_daily"]
lock = threading.Lock()        # one sync at a time
login_lock = threading.Lock()  # one login at a time
login = {"status": "idle"}
status = {}


def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False))
    tmp.replace(path)


def load_status():
    global status
    try:
        status = json.loads(STATUS_FILE.read_text())
    except Exception:
        status = {}


def set_status(**kw):
    status.update(kw)
    write_json(STATUS_FILE, status)


def plain(obj):
    """Dataclass records as plain dicts, without the service's raw rows."""
    if dataclasses.is_dataclass(obj):
        return {f.name: plain(getattr(obj, f.name)) for f in dataclasses.fields(obj) if f.name != "raw"}
    if isinstance(obj, list):
        return [plain(x) for x in obj]
    return obj


def day_of(epoch_s):
    return dt.datetime.fromtimestamp(epoch_s).date().isoformat()


def sync(days):
    """Pull the last `days` days of every domain and rebuild the daily summaries."""
    if not lock.acquire(blocking=False):
        return
    try:
        if not load_session():
            set_status(last_error="not logged in")
            return
        client = MiFit()
        end = dt.date.today()
        start = end - dt.timedelta(days=days - 1)
        a, b = start.isoformat(), end.isoformat()
        touched = set()
        for name in DAILY_DOMAINS:
            for rec in plain(getattr(client, name)(a, b).records):
                write_json(DATA / name / f"{rec['date']}.json", rec)
                touched.add(rec["date"])
        for w in plain(client.workouts(a, b).records):
            write_json(DATA / "workouts" / f"{w['start_epoch_s']}.json", w)
            touched.add(day_of(w["start_epoch_s"]))
        # Raw samples are big: only the recent days, as [epoch_s, value] pairs per day.
        raw_from = max(start, end - dt.timedelta(days=RECENT_DAYS - 1)).isoformat()
        for name, field in (("heart_rate", "bpm"), ("spo2", "spo2_pct")):
            per_day = {}
            for p in plain(getattr(client, name)(raw_from, b).records):
                per_day.setdefault(day_of(p["epoch_s"]), []).append([p["epoch_s"], p[field]])
            for day, pts in per_day.items():
                write_json(DATA / name / f"{day}.json", sorted(pts))
        for day in sorted(touched):
            build_daily(day)
        set_status(last_sync=now_iso(), last_error=None, days_synced=len(touched))
    except Exception as exc:  # keep the loop alive; the error is shown on the page
        set_status(last_error=f"{type(exc).__name__}: {exc}"[:300], last_error_at=now_iso())
        traceback.print_exc()
    finally:
        lock.release()


def read(name, day):
    try:
        return json.loads((DATA / name / f"{day}.json").read_text())
    except Exception:
        return None


def build_daily(day):
    """One compact summary per day, the shape Claude and the progress site read."""
    out = {"date": day, "source": "xiaomi_cloud"}
    s = read("steps", day)
    if s:
        out.update(steps=s.get("steps"), distance_m=s.get("distance_m"))
    h = read("heart_rate_daily", day)
    if h:
        out.update(hr_avg=h.get("avg_bpm"), hr_min=h.get("min_bpm"), hr_max=h.get("max_bpm"), hr_rest=h.get("resting_bpm"))
    c = read("consumption", day)
    if c:
        out.update(active_kcal=c.get("active_kcal"), total_kcal=c.get("total_kcal"), resting_kcal=c.get("resting_kcal"))
    o = read("spo2_daily", day)
    if o:
        out.update(spo2_avg=o.get("avg_spo2_pct"), spo2_min=o.get("min_spo2_pct"), spo2_max=o.get("max_spo2_pct"))
    st = read("stress_daily", day)
    if st:
        out["stress"] = {k: st.get(k) for k in ("avg_stress_level", "max_stress_level", "min_stress_level",
                                                "relaxed_min", "mild_min", "moderate_min", "severe_min")}
    ac = read("activity_daily", day)
    if ac:
        out.update(activity_min=ac.get("activity_min"))
    sl = read("sleep", day)
    if sl:
        out["sleep"] = {
            "asleep_min": sl.get("asleep_min"), "deep_min": sl.get("deep_min"), "light_min": sl.get("light_min"),
            "rem_min": sl.get("rem_min"), "awake_min": sl.get("awake_min"),
            "hr_avg": sl.get("avg_hr_bpm"), "hr_min": sl.get("min_hr_bpm"), "spo2_min": sl.get("min_spo2_pct"),
            "sessions": [{"start": x["start_epoch_s"], "end": x["end_epoch_s"], "asleep_min": x["asleep_min"]}
                         for x in sl.get("sessions") or []],
        }
    hr = read("heart_rate", day)
    if hr:
        out["hr_samples"] = len(hr)
    ws = []
    for f in sorted((DATA / "workouts").glob("*.json")) if (DATA / "workouts").exists() else []:
        w = json.loads(f.read_text())
        if day_of(w["start_epoch_s"]) == day:
            ws.append({k: w.get(k) for k in ("start_epoch_s", "end_epoch_s", "sport", "duration_s", "active_kcal",
                                             "avg_hr_bpm", "max_hr_bpm", "steps", "distance_m")})
    if ws:
        out["workouts"] = ws
    write_json(DAILY / f"{day}.json", out)


def sync_loop():
    time.sleep(20)
    while True:
        sync(RECENT_DAYS)
        time.sleep(SYNC_EVERY_S)


def start_login():
    with login_lock:
        if login.get("status") == "pending":
            return login
        device_id, http = new_device_id(), requests.Session()
        ch = request_qr_login(http, SID, device_id=device_id)
        png = base64.b64encode(qr_png(ch.qr_payload)).decode()
        login.clear()
        login.update(status="pending", login_url=ch.login_url, qr_png=png, started=now_iso())

    def wait():
        try:
            result = poll_qr_login(ch, http, device_id=device_id)
            session = exchange_sts(result, SID, http, device_id=device_id)
            if not result.region_hint:
                session.region = FALLBACK_REGION
            save_session(session)
            login.clear()
            login.update(status="succeeded", region=session.region)
            set_status(logged_in_at=now_iso(), region=session.region)
            sync(FIRST_DAYS)
        except NotificationRequiredError as exc:
            login.clear()
            login.update(status="confirmation_required", notification_url=exc.notification_url)
        except Exception as exc:
            login.clear()
            login.update(status="failed", message=f"{type(exc).__name__}: {exc}"[:300])

    threading.Thread(target=wait, daemon=True).start()
    return login


def api_days(n):
    since = (dt.date.today() - dt.timedelta(days=n - 1)).isoformat()
    out = []
    for f in sorted(DAILY.glob("*.json")) if DAILY.exists() else []:
        if f.stem >= since:
            out.append(json.loads(f.read_text()))
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path in ("/xiaomi", "/xiaomi/"):
            return self.send(200, (HERE / "page.html").read_bytes(), "text/html; charset=utf-8")
        if path == "/xiaomi/status":
            sess = load_session()
            return self.send(200, {**status, "logged_in": bool(sess), "region": getattr(sess, "region", None),
                                   "login": {k: v for k, v in login.items() if k != "qr_png"}})
        if path == "/xiaomi/login":
            return self.send(200, login)
        if path == "/xiaomi/api":
            n = 30
            for part in query.split("&"):
                if part.startswith("days="):
                    n = max(1, min(400, int(part[5:] or 30)))
            return self.send(200, {"days": api_days(n), "status": status})
        self.send(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/xiaomi/login/start":
            try:
                return self.send(200, start_login())
            except Exception as exc:
                return self.send(502, {"status": "failed", "message": f"{type(exc).__name__}: {exc}"[:300]})
        if self.path == "/xiaomi/sync":
            threading.Thread(target=sync, args=(RECENT_DAYS,), daemon=True).start()
            return self.send(202, {"ok": True})
        self.send(404, {"error": "not found"})


if __name__ == "__main__":
    STATE.mkdir(parents=True, exist_ok=True)
    load_status()
    threading.Thread(target=sync_loop, daemon=True).start()
    print(f"xiaomi bridge on 127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
