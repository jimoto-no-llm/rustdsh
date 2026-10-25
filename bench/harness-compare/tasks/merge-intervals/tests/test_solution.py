from solution import merge


def test_empty():
    assert merge([]) == []


def test_single():
    assert merge([[1, 3]]) == [[1, 3]]


def test_overlapping():
    assert merge([[1, 4], [2, 6], [8, 10]]) == [[1, 6], [8, 10]]


def test_touching():
    assert merge([[1, 3], [3, 5]]) == [[1, 5]]


def test_unsorted_input():
    assert merge([[8, 10], [1, 4], [2, 6]]) == [[1, 6], [8, 10]]
