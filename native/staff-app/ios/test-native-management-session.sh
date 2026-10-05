#!/bin/bash
set -euo pipefail
base=$(cd "$(dirname "$0")" && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
cp -R "$base/Sources" "$test_dir/Sources"
cp "$base/Tests/NativeManagementSessionTests.swift" "$test_dir/NativeManagementSessionTests.swift"
if [[ -n "${NATIVE_CLEANUP_EVIDENCE_DIR:-}" ]]; then
  mkdir -p "$NATIVE_CLEANUP_EVIDENCE_DIR"
  python3 - "$test_dir" "$NATIVE_CLEANUP_EVIDENCE_DIR/source-manifest.json" <<'PYMETA'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);files={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob('*.swift'))}
pathlib.Path(sys.argv[2]).write_text(json.dumps({'snapshotFiles':files,'sha256':hashlib.sha256(json.dumps(files,sort_keys=True).encode()).hexdigest()},indent=2)+'\n')
PYMETA
fi
sources=()
for source in "$test_dir"/Sources/*.swift; do
  case "$(basename "$source")" in
    *View.swift|*Forms.swift|MBOXApp.swift|ButtonDesign.swift|MenuComponents.swift|LiveOrderCheckout.swift|LiveTableActions.swift) continue ;;
  esac
  sources+=("$source")
done
swiftc -target "$(uname -m)-apple-macosx14.0" "${sources[@]}" "$test_dir/NativeManagementSessionTests.swift" -o "$test_dir/native-management-session-tests"
"$test_dir/native-management-session-tests"
