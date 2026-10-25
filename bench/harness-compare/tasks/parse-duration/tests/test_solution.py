from solution import parse_duration


def test_seconds_only():
    assert parse_duration("45s") == 45


def test_minutes_and_seconds():
    assert parse_duration("2m30s") == 150


def test_hours():
    assert parse_duration("2h") == 7200


def test_mixed():
    assert parse_duration("1h2m3s") == 3723


def test_zero():
    assert parse_duration("0s") == 0
