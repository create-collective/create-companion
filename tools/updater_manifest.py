"""Write latest.json, the manifest the in-app updater reads, for a published release.

The release workflow runs this after the Windows and macOS jobs have attached their files:

    python tools/updater_manifest.py --tag v1.0.0 --repo create-collective/create-companion \\
        --files <dir with the installer, the app.tar.gz and their .sig> --notes RELEASE_BODY.md \\
        --out latest.json

Each platform entry names the release's own download URL (GitHub turns spaces in asset names
into dots, so the names are asked from GitHub, not guessed) and the file's signature. A
signature that does not verify against the public key in ui/src-tauri/tauri.conf.json stops
the job: every installed copy would refuse that update.

    python tools/updater_manifest.py --verify <file> [<file.sig>]   checks one signature
"""
import argparse
import base64
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

ROOT = Path(__file__).resolve().parent.parent
CONF = ROOT / "ui" / "src-tauri" / "tauri.conf.json"

# Platform keys the Tauri updater looks up, and how to recognise each one's file. The macOS
# build is universal, so one archive serves both architectures.
PLATFORMS = {
    "windows-x86_64": lambda name: name.endswith("_x64-setup.exe"),
    "darwin-aarch64": lambda name: name.endswith(".app.tar.gz"),
    "darwin-x86_64": lambda name: name.endswith(".app.tar.gz"),
}


def _minisign_lines(b64: str) -> list[str]:
    """Tauri stores minisign key and signature files base64-encoded as a whole."""
    return base64.b64decode(b64.strip()).decode("utf-8").strip().splitlines()


def public_key() -> tuple[bytes, Ed25519PublicKey]:
    """(key id, key) of the updater's public key in tauri.conf.json."""
    conf = json.loads(CONF.read_text(encoding="utf-8"))
    raw = base64.b64decode(_minisign_lines(conf["plugins"]["updater"]["pubkey"])[1])
    if raw[:2] != b"Ed" or len(raw) != 42:
        raise SystemExit("tauri.conf.json: the updater pubkey is not a minisign Ed25519 key")
    return raw[2:10], Ed25519PublicKey.from_public_bytes(raw[10:])


def verify(data: bytes, signature_b64: str) -> None:
    """Check a Tauri updater signature (minisign) the way the updater does; raise if it fails."""
    key_id, key = public_key()
    lines = _minisign_lines(signature_b64)
    if len(lines) != 4 or not lines[2].startswith("trusted comment: "):
        raise ValueError("not a minisign signature")
    sig = base64.b64decode(lines[1])
    algorithm, sig_key_id, signature = sig[:2], sig[2:10], sig[10:]
    if sig_key_id != key_id:
        raise ValueError(f"signed with key {sig_key_id.hex()}, the app trusts {key_id.hex()}")
    # "ED" signs the BLAKE2b-512 hash of the file (what Tauri's signer writes), "Ed" the file.
    message = hashlib.blake2b(data, digest_size=64).digest() if algorithm == b"ED" else data
    try:
        key.verify(signature, message)
        key.verify(base64.b64decode(lines[3]), signature + lines[2][len("trusted comment: "):].encode())
    except InvalidSignature:
        raise ValueError("signature does not match the file") from None


def release_assets(repo: str, tag: str) -> dict[str, str]:
    """Asset name -> download URL for the release at `tag`."""
    out = subprocess.run(
        ["gh", "api", f"repos/{repo}/releases/tags/{tag}"], check=True, capture_output=True, text=True
    ).stdout
    return {a["name"]: a["browser_download_url"] for a in json.loads(out)["assets"]}


def build(tag: str, repo: str, files: Path, notes: str) -> dict:
    assets = release_assets(repo, tag)
    platforms = {}
    for platform, wanted in PLATFORMS.items():
        # Downloaded artifacts keep their folders (the macOS one has dmg/ and macos/).
        matches = [f for f in files.rglob("*") if f.is_file() and wanted(f.name)]
        if len(matches) != 1:
            raise SystemExit(f"{platform}: expected one file in {files}, found {[f.name for f in matches]}")
        file = matches[0]
        sig_file = file.with_name(file.name + ".sig")
        if not sig_file.is_file():
            raise SystemExit(f"{platform}: no {sig_file.name}")
        signature = sig_file.read_text(encoding="utf-8").strip()
        try:
            verify(file.read_bytes(), signature)
        except ValueError as e:
            raise SystemExit(f"{platform}: {file.name}: {e}")
        asset = file.name.replace(" ", ".")
        if asset not in assets:
            raise SystemExit(f"{platform}: {asset} is not attached to {tag} (has {sorted(assets)})")
        platforms[platform] = {"signature": signature, "url": assets[asset]}
        print(f"{platform}: {asset} (signature verified)")
    return {
        "version": tag.removeprefix("v"),
        "notes": notes.strip(),
        "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": platforms,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--verify", nargs="+", metavar="FILE")
    ap.add_argument("--tag")
    ap.add_argument("--repo")
    ap.add_argument("--files", type=Path)
    ap.add_argument("--notes", type=Path)
    ap.add_argument("--out", type=Path)
    a = ap.parse_args()
    if a.verify:
        file = Path(a.verify[0])
        sig = Path(a.verify[1]) if len(a.verify) > 1 else file.with_name(file.name + ".sig")
        try:
            verify(file.read_bytes(), sig.read_text(encoding="utf-8"))
        except ValueError as e:
            sys.exit(f"{file.name}: {e}")
        print(f"{file.name}: signature verified")
        return
    if not (a.tag and a.repo and a.files and a.out):
        ap.error("--tag, --repo, --files and --out are required to write a manifest")
    notes = a.notes.read_text(encoding="utf-8") if a.notes else ""
    manifest = build(a.tag, a.repo, a.files, notes)
    a.out.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
