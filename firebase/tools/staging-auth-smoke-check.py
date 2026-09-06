#!/usr/bin/env python3
"""
Staging authentication smoke check for savrivo-app.

Purpose:
- verify critical cross-app staging accounts still authenticate
- prove wrong-password failures are surfaced as Firebase INVALID_LOGIN_CREDENTIALS
- verify the post-login handoff records needed by rider / restaurant / admin
- optionally verify expected Firebase App Check debug-token display names

No secrets are hardcoded here. Provide the shared staging password at runtime:

  SAVRIVO_STAGING_PASSWORD='...' python3 firebase/tools/staging-auth-smoke-check.py

Optional:
  SAVRIVO_STAGING_API_KEY='...'
  SAVRIVO_FIREBASE_ACCESS_TOKEN='...'
"""

from __future__ import annotations

import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple


PROJECT_ID = "savrivo-app"
PROJECT_NUMBER = "458592242638"
API_KEY = os.environ.get("SAVRIVO_STAGING_API_KEY", "AIzaSyC-XNIho8eUbkDQdsjzE8SF3ThZdBxvPy4")
PASSWORD = os.environ.get("SAVRIVO_STAGING_PASSWORD", "")
ACCESS_TOKEN = os.environ.get("SAVRIVO_FIREBASE_ACCESS_TOKEN", "")
RTDB_BASE = "https://savrivo-app-default-rtdb.firebaseio.com"


@dataclass(frozen=True)
class AccountCase:
    label: str
    email: str
    local_id: str


ACCOUNTS: Tuple[AccountCase, ...] = (
    AccountCase("customer", "baluchatgpt1@gmail.com", "BPRfZ8fmQBO2zR3uJVBr5QIWl1x1"),
    AccountCase("rider", "tirumurunbalu@gmail.com", "hffg4msxCme6VfKgMeuXSEDssIi1"),
    AccountCase("restaurant", "personal08030803@gmail.com", "cLuQ6fQTSBUUu3Wzy9gow1vm4Ap2"),
    AccountCase("admin", "tirumurubalu@gmail.com", "r36PY4C5k0RIKrjXYjA3gWRMh9D3"),
)

EXPECTED_DEBUG_TOKEN_LABELS: Dict[str, Tuple[str, ...]] = {
    "1:458592242638:android:a908ab5d83d01b2044b99f": (
        "Savrivo Customer 3.2.0 developer APK",
        "Recovered staging phone customer token",
    ),
    "1:458592242638:android:3cbc71f4fe5c308744b99f": (
        "Savrivo Rider developer APK",
    ),
    "1:458592242638:android:d69ea767761f871044b99f": (
        "Savrivo Restaurant developer APK",
        "Recovered staging phone restaurant token",
    ),
    "1:458592242638:android:864d1667f812909944b99f": (
        "Savrivo Admin developer APK",
        "Recovered staging phone admin token",
    ),
}


class CheckFailed(RuntimeError):
    pass


def http_json(url: str, *, method: str = "GET", body: Optional[Dict[str, Any]] = None, headers: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    payload = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=payload, method=method)
    req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    with urllib.request.urlopen(req, timeout=20) as response:
        raw = response.read().decode("utf-8")
    return json.loads(raw) if raw else {}


def sign_in(email: str, password: str) -> Tuple[bool, Dict[str, Any]]:
    url = f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={urllib.parse.quote(API_KEY)}"
    payload = {"email": email, "password": password, "returnSecureToken": True}
    try:
        return True, http_json(url, method="POST", body=payload)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8")
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = {"error": {"message": raw or f"HTTP_{exc.code}"}}
        return False, data


def rtdb_get(path: str, id_token: str) -> Any:
    url = f"{RTDB_BASE}{path}.json?auth={urllib.parse.quote(id_token)}"
    with urllib.request.urlopen(url, timeout=20) as response:
        raw = response.read().decode("utf-8")
    return json.loads(raw) if raw else None


def decode_jwt_payload(id_token: str) -> Dict[str, Any]:
    payload = id_token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))


def require(condition: bool, message: str) -> None:
    if not condition:
        raise CheckFailed(message)


def verify_password_accounts() -> None:
    require(bool(PASSWORD), "Set SAVRIVO_STAGING_PASSWORD before running this smoke check.")
    for case in ACCOUNTS:
        ok, data = sign_in(case.email, PASSWORD)
        require(ok, f"{case.label}: expected successful sign-in, got {data.get('error', {}).get('message')}")
        require(data.get("localId") == case.local_id, f"{case.label}: expected localId {case.local_id}, got {data.get('localId')}")
        print(f"PASS auth/{case.label}: {case.email}")

    ok, data = sign_in(ACCOUNTS[1].email, "definitely-wrong-password")
    require(not ok, "invalid-password control: sign-in unexpectedly succeeded")
    require(data.get("error", {}).get("message") == "INVALID_LOGIN_CREDENTIALS", f"invalid-password control: expected INVALID_LOGIN_CREDENTIALS, got {data}")
    print("PASS auth/invalid-password-control: INVALID_LOGIN_CREDENTIALS")


def verify_post_login_records() -> None:
    tokens: Dict[str, str] = {}
    for case in ACCOUNTS:
        ok, data = sign_in(case.email, PASSWORD)
        require(ok, f"{case.label}: could not sign in for post-login verification")
        tokens[case.label] = data["idToken"]

    rider = rtdb_get("/feastly/riders/hffg4msxCme6VfKgMeuXSEDssIi1", tokens["rider"])
    require(isinstance(rider, dict), "rider: rider profile missing")
    require(rider.get("status") == "approved", f"rider: expected approved status, got {rider.get('status')}")
    print("PASS post-login/rider-profile: approved")

    restaurant_staff = rtdb_get("/feastly/staff/cLuQ6fQTSBUUu3Wzy9gow1vm4Ap2", tokens["restaurant"])
    restaurant_map = rtdb_get("/feastly/userRestaurants/cLuQ6fQTSBUUu3Wzy9gow1vm4Ap2", tokens["restaurant"])
    require(isinstance(restaurant_staff, dict) and restaurant_staff.get("active") is True, "restaurant: active staff record missing")
    require(isinstance(restaurant_map, dict) and bool(restaurant_map), "restaurant: restaurant membership mapping missing")
    print("PASS post-login/restaurant-membership: active")

    admin_claims = decode_jwt_payload(tokens["admin"])
    require(admin_claims.get("savrivoRole") in {"owner", "ops_admin"}, f"admin: missing owner/ops_admin claim, got {admin_claims.get('savrivoRole')}")
    admin_profile = rtdb_get("/feastly/users/r36PY4C5k0RIKrjXYjA3gWRMh9D3", tokens["admin"])
    require(isinstance(admin_profile, dict), "admin: user profile missing")
    print(f"PASS post-login/admin-claim: {admin_claims.get('savrivoRole')}")

    customer_profile = rtdb_get("/feastly/users/BPRfZ8fmQBO2zR3uJVBr5QIWl1x1", tokens["customer"])
    print(f"INFO post-login/customer-profile: {'present' if isinstance(customer_profile, dict) else 'missing -> customer app must self-initialize'}")


def verify_app_check_debug_tokens() -> None:
    if not ACCESS_TOKEN:
        print("SKIP app-check/debug-tokens: set SAVRIVO_FIREBASE_ACCESS_TOKEN to verify token labels")
        return
    for app_id, expected_labels in EXPECTED_DEBUG_TOKEN_LABELS.items():
        url = f"https://firebaseappcheck.googleapis.com/v1beta/projects/{PROJECT_NUMBER}/apps/{app_id}/debugTokens"
        data = http_json(url, headers={"Authorization": f"Bearer {ACCESS_TOKEN}"})
        actual = {entry.get("displayName", "") for entry in data.get("debugTokens", [])}
        missing = [label for label in expected_labels if label not in actual]
        require(not missing, f"app-check: {app_id} missing debug token labels {missing}")
        print(f"PASS app-check/{app_id}: {len(expected_labels)} expected label(s) present")


def main() -> int:
    try:
        verify_password_accounts()
        verify_post_login_records()
        verify_app_check_debug_tokens()
    except CheckFailed as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        return 1
    print("PASS staging-auth-smoke-check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
