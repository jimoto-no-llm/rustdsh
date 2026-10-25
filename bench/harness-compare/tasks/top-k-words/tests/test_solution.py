from solution import top_k


def test_single_word():
    assert top_k("a a a", 1) == ["a"]


def test_order_by_count():
    assert top_k("a b b c c c", 2) == ["c", "b"]


def test_tie_by_first_appearance():
    assert top_k("x y y x", 2) == ["x", "y"]


def test_case_insensitive():
    assert top_k("A a b", 1) == ["a"]


def test_k_larger_than_vocabulary():
    assert top_k("a b", 5) == ["a", "b"]
