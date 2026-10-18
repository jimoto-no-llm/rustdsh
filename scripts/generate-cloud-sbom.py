"""Generate the locked Cargo dependency slice of the Cloud Swarm SBOM.

The worker image and DeepSeek Harness pnpm graph need an additional image
SBOM after an actual build. This script intentionally makes no such claim.
"""

import json
import subprocess
import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "cloud" / "sbom" / "rdsh-cargo.cdx.json"


def main() -> None:
    metadata = json.loads(
        subprocess.check_output(
            ["cargo", "metadata", "--locked", "--format-version", "1"], cwd=ROOT
        )
    )
    lock = tomllib.loads((ROOT / "Cargo.lock").read_text(encoding="utf-8"))
    checksums = {
        (item["name"], item["version"]): item.get("checksum")
        for item in lock["package"]
    }
    package_by_id = {package["id"]: package for package in metadata["packages"]}

    def reference(package: dict) -> str:
        return f"pkg:cargo/{package['name']}@{package['version']}"

    components = []
    for package in sorted(metadata["packages"], key=lambda p: (p["name"], p["version"])):
        if package["id"] == metadata["resolve"]["root"]:
            continue
        component = {
            "type": "library",
            "bom-ref": reference(package),
            "name": package["name"],
            "version": package["version"],
            "purl": reference(package),
        }
        if package.get("license"):
            component["licenses"] = [{"expression": package["license"]}]
        checksum = checksums.get((package["name"], package["version"]))
        if checksum:
            component["hashes"] = [{"alg": "SHA-256", "content": checksum}]
        components.append(component)

    dependencies = []
    for node in metadata["resolve"]["nodes"]:
        package = package_by_id[node["id"]]
        dependencies.append(
            {
                "ref": reference(package),
                "dependsOn": sorted(reference(package_by_id[item]) for item in node["dependencies"]),
            }
        )
    dependencies.sort(key=lambda item: item["ref"])
    root = package_by_id[metadata["resolve"]["root"]]
    bom = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "version": 1,
        "metadata": {
            "component": {
                "type": "application",
                "bom-ref": reference(root),
                "name": root["name"],
                "version": root["version"],
            },
            "properties": [
                {"name": "cloud.rdsh.dev/scope", "value": "Cargo.lock only; worker image and pnpm dependencies excluded"}
            ],
        },
        "components": components,
        "dependencies": dependencies,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(bom, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{OUTPUT}: {len(components)} locked Cargo components")


if __name__ == "__main__":
    main()
