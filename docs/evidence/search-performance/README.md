# Native search performance and boundary verification

Measured on 2026-10-08 against v0.2.0 (main `57777a6`) and the candidate
containing command-scoped directory handles and bounded matching workers.
The reports record both binary SHA-256 values, the exact OS/CPU, all ten
timing samples, peak RSS, and raw stdout/stderr. Each binary had two warmups;
sample order alternated before/after. Fixtures and HOME are temporary and
contain only generated dummy data. No model or provider is involved.

## Results

Default affinity permits 12 CPUs; grep still caps its workers at eight.

| Fixture, `--max 10` | Before median | After median | Speedup | Before/after RSS, KiB |
| --- | ---: | ---: | ---: | ---: |
| Dense: 160 files × 6,000 matching lines | 197.774ms | 4.607ms | 42.93x | 132848 / 4344 |
| Sparse: 1,500 files × 40 nonmatching lines | 8.680ms | 5.237ms | 1.66x | 3716 / 3688 |
| Deep: 800 files × 40 nonmatching lines, depth 5 | 7.421ms | 5.604ms | 1.32x | 3612 / 3548 |
| Mixed: 160 files × 1,000 lines, depth 2; one in 13 files matches | 7.376ms | 3.466ms | 2.13x | 6040 / 3544 |

Dense peak RSS decreased by 96.73%. RSS is a single separate run per binary;
timings are medians of ten runs. WSL scheduling and filesystem caching affect
absolute values, particularly the dense baseline. The benchmark does not
simulate a cold cache or an independently isolated production machine.

| Affinity | Dense before/after | Sparse before/after | Deep before/after | Mixed before/after |
| --- | ---: | ---: | ---: | ---: |
| 1 CPU | 277.886 / 2.133ms | 31.505 / 14.631ms | 40.303 / 27.572ms | 24.483 / 4.027ms |
| 2 CPUs | 181.312 / 2.495ms | 18.657 / 9.657ms | 18.898 / 14.390ms | 10.162 / 2.944ms |

Raw reports: [default](default.json), [one CPU](one-cpu.json),
[two CPUs](two-cpu.json). These reports also contain 64 compatibility
comparisons each: 1/31/32/65 files, limits 0/1/17/1000, ASCII/Japanese/empty
queries, CRLF, long Unicode lines, hidden/vendor directories, invalid UTF-8,
oversized files, symlinks, hardlinks, and a FIFO. Both output streams and exit
status matched in all four timing fixtures and all compatibility cases under
each affinity setting. The output diff is empty by assertion, not by manual
inspection of a summary.

## Reproduce

Build the baseline from v0.2.0 and the candidate using `cargo build --release`,
then run from the repository root on Linux:

```sh
python3 scripts/benchmark-search.py /path/to/v0.2.0/rdsh target/release/rdsh --output /tmp/search-default.json
python3 scripts/benchmark-search.py /path/to/v0.2.0/rdsh target/release/rdsh --cpus 1 --output /tmp/search-one-cpu.json
python3 scripts/benchmark-search.py /path/to/v0.2.0/rdsh target/release/rdsh --cpus 2 --output /tmp/search-two-cpu.json
```

## Why behavior and security remain intact

Each contiguous worker chunk retains at most the global output limit. Merging
chunks in their original order therefore preserves the first `max` matches,
line numbers, truncation, displayed paths, and the total file count. Memory
for retained hits is bounded by workers × max instead of all matching lines.
The read cap stays at 2,000,000 bytes per UTF-8 file.

The command opens its canonical root once and holds the directory descriptor.
Every descendant open still uses `O_NOFOLLOW`, directory-relative `openat`,
and nonblocking final opens; the opened descriptor must be a regular file with
exactly one link. A deterministic test replaces the root pathname after
opening: the retained handle reads only the approved original directory.
Other tests cover swapped parent directories, final symlinks, hardlinks, and
FIFOs. The `open_beneath` wrapper remains available to existing callers.

The separate CLI hardening and validation is described in
[the audit report](../performance-security-audit.md).
