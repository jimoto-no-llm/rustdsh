import importlib.util, pathlib, sys
sys.path.insert(0, ".")
failures = []
for path in sorted(pathlib.Path("tests").glob("test_*.py")):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as error:
        failures.append(f"{path.name}: import failed: {error}")
        continue
    for name in sorted(dir(module)):
        if not name.startswith("test_"):
            continue
        try:
            getattr(module, name)()
        except Exception as error:
            failures.append(f"{path.name}::{name}: {type(error).__name__}: {error}")
print(f"{len(failures)} failing test(s)")
for failure in failures:
    print(" -", failure)
sys.exit(0 if not failures else 1)
