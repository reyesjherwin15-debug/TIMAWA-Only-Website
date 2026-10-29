#!/usr/bin/env python3
"""Create (or re-read) the VAPID key pair used by TIMAWA web push.

  python tools/generate_vapid_keys.py            # create keys if missing
  python tools/generate_vapid_keys.py --force    # rotate keys (all devices must re-subscribe)

Writes:
  tools/.vapid-private.pem   private key  -> only the sender uses it, never commit/serve it
  push-config.js             public key   -> shipped to the browser, safe to publish
"""

import argparse
import base64
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

ROOT = Path(__file__).resolve().parent.parent
PRIVATE_KEY_PATH = ROOT / "tools" / ".vapid-private.pem"
PUBLIC_CONFIG_PATH = ROOT / "push-config.js"

CONFIG_TEMPLATE = """/* ============================================================================
   TIMAWA — web push public configuration
   ----------------------------------------------------------------------------
   The VAPID public key below is safe to publish: it only identifies this app to
   the browser's push service. The matching PRIVATE key lives in
   tools/.vapid-private.pem and is used by tools/send_activity_push.py to send.

   Rotate both with:  python tools/generate_vapid_keys.py --force
   (every member then has to turn notifications on again)
   ========================================================================== */

window.TIMAWA_PUSH = {
    vapidPublicKey: '{public_key}',
    collection: 'pushSubscriptions',
    defaultUrl: 'calendar.html'
};
"""


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def public_key_for(private_key) -> str:
    """Uncompressed P-256 point (0x04 || X || Y), base64url — what PushManager wants."""
    raw = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    return b64url(raw)


def load_private_key():
    if not PRIVATE_KEY_PATH.exists():
        return None
    return serialization.load_pem_private_key(PRIVATE_KEY_PATH.read_bytes(), password=None)


def write_private_key(private_key) -> None:
    pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    PRIVATE_KEY_PATH.write_bytes(pem)
    try:
        PRIVATE_KEY_PATH.chmod(0o600)
    except OSError:
        pass


def write_public_config(public_key: str) -> None:
    PUBLIC_CONFIG_PATH.write_text(CONFIG_TEMPLATE.replace("{public_key}", public_key), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate TIMAWA VAPID keys")
    parser.add_argument("--force", action="store_true", help="rotate the key pair")
    parser.add_argument("--print-only", action="store_true", help="do not touch any file")
    args = parser.parse_args()

    private_key = None if args.force else load_private_key()
    created = private_key is None

    if private_key is None:
        private_key = ec.generate_private_key(ec.SECP256R1())

    public_key = public_key_for(private_key)

    if not args.print_only:
        if created:
            write_private_key(private_key)
        write_public_config(public_key)

    print(f"VAPID public key : {public_key}")
    print(f"private key file : {PRIVATE_KEY_PATH}")
    print(f"browser config   : {PUBLIC_CONFIG_PATH}")
    print()
    if created:
        print("New key pair generated." if args.force else "Keys created.")
        print("Devices that subscribed before a rotation must enable notifications again.")
    else:
        print("Existing key pair reused (pass --force to rotate).")
    print()
    print("Sender VAPID subject (not a secret): by default the deployed site's origin is used.")
    print("To use an inbox instead, set one you actually read:")
    print('  set VAPID_SUBJECT=mailto:you@gmail.com')
    print("Apple's push service rejects fake domains such as example.com (403 BadJwtToken).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
