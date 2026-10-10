import struct
import sys
from pathlib import Path
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ico_format import parse_ico


def make_ico(*, reserved=0, kind=1, count=1, length=4, offset=22, payload=b"data"):
    header = struct.pack("<HHH", reserved, kind, count)
    if count == 0:
        return header
    entry = struct.pack("<BBBBHHII", 16, 16, 0, 0, 1, 32, length, offset)
    return header + entry + payload


class IconGenerationTests(unittest.TestCase):
    def test_valid_entries_return_only_the_declared_payload(self):
        reserved, kind, entries = parse_ico(make_ico())
        self.assertEqual((reserved, kind), (0, 1))
        self.assertEqual(entries[0], (16, 16, 0, 0, 1, 32, b"data"))

    def test_rejects_bad_headers_and_truncated_directories(self):
        malformed = (
            b"\x00",
            make_ico(reserved=1),
            make_ico(kind=2),
            make_ico(count=0),
            struct.pack("<HHH", 0, 1, 2) + b"\x00" * 16,
        )
        for icon in malformed:
            with self.subTest(icon=icon):
                with self.assertRaises(ValueError):
                    parse_ico(icon)

    def test_rejects_empty_or_out_of_bounds_payload_ranges(self):
        malformed = (
            make_ico(length=0),
            make_ico(offset=21),
            make_ico(offset=24),
            make_ico(offset=100),
            make_ico(length=5),
        )
        for icon in malformed:
            with self.subTest(icon=icon):
                with self.assertRaisesRegex(ValueError, "payload bounds"):
                    parse_ico(icon)


if __name__ == "__main__":
    unittest.main()
