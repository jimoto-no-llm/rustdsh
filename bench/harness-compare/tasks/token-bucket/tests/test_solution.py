from solution import TokenBucket


def make(capacity=2, rate=1.0, start=0.0):
    clock = {"t": start}
    bucket = TokenBucket(capacity, rate, lambda: clock["t"])
    return bucket, clock


def test_starts_full():
    bucket, _ = make()
    assert bucket.take(2) is True


def test_refuses_when_empty():
    bucket, _ = make()
    assert bucket.take(2) is True
    assert bucket.take(1) is False


def test_refills_over_time():
    bucket, clock = make()
    bucket.take(2)
    clock["t"] = 1.0
    assert bucket.take(1) is True


def test_never_exceeds_capacity():
    bucket, clock = make()
    bucket.take(2)
    clock["t"] = 100.0
    assert bucket.take(2) is True
    assert bucket.take(1) is False


def test_partial_refill_is_kept():
    bucket, clock = make()
    bucket.take(2)
    clock["t"] = 0.5
    assert bucket.take(1) is False
    clock["t"] = 1.0
    assert bucket.take(1) is True
