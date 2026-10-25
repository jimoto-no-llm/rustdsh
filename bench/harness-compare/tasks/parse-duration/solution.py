def parse_duration(text: str) -> int:
    """Return the number of seconds described by text such as "1h30m" or "45s".

    Supported units: h, m, s. Input is one or more <number><unit> groups with no
    separators, for example "2h", "1h30m", "45s", "1h2m3s".
    """
    raise NotImplementedError
