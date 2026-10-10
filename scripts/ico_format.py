"""Validate ICO directory entries before their payloads are copied."""
import struct


def parse_ico(icon):
    if len(icon) < 6:
        raise ValueError("Invalid ICO header")
    reserved, kind, count = struct.unpack_from("<HHH", icon)
    if reserved != 0 or kind != 1 or count == 0:
        raise ValueError("Invalid ICO header")
    directory_end = 6 + count * 16
    if directory_end > len(icon):
        raise ValueError("Invalid ICO directory")

    entries = []
    for index in range(count):
        values = struct.unpack_from("<BBBBHHII", icon, 6 + index * 16)
        width, height, colors, padding, planes, bits, length, offset = values
        if (
            length == 0
            or offset < directory_end
            or offset > len(icon)
            or length > len(icon) - offset
        ):
            raise ValueError(f"Invalid ICO entry {index} payload bounds")
        entries.append(
            (
                width,
                height,
                colors,
                padding,
                planes,
                bits,
                icon[offset : offset + length],
            )
        )
    return reserved, kind, entries
