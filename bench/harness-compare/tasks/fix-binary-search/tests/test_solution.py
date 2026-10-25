from solution import index_of


def test_present_first_element():
    assert index_of([1, 3, 5], 1) == 0


def test_present_last_element():
    assert index_of([1, 3, 5], 5) == 2


def test_present_middle():
    assert index_of([1, 3, 5, 7], 3) == 1


def test_absent():
    assert index_of([1, 3, 5], 4) == -1


def test_empty():
    assert index_of([], 1) == -1
