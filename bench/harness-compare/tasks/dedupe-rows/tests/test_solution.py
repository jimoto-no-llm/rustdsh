from solution import dedupe


def test_empty():
    assert dedupe([]) == []


def test_no_duplicates():
    assert dedupe([["a", "1"], ["b", "2"]]) == [["a", "1"], ["b", "2"]]


def test_case_insensitive_first_wins():
    assert dedupe([["A", "1"], ["a", "2"]]) == [["A", "1"]]


def test_keeps_remaining_fields():
    assert dedupe([["a", "1", "x"], ["a", "2", "y"], ["b", "3", "z"]]) == [
        ["a", "1", "x"],
        ["b", "3", "z"],
    ]


def test_preserves_order():
    assert dedupe([["b", "1"], ["a", "2"], ["b", "3"]]) == [["b", "1"], ["a", "2"]]
