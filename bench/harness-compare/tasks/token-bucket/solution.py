class TokenBucket:
    """A token bucket rate limiter with an injectable clock.

    capacity is the maximum number of tokens. refill_per_second is how many
    tokens are added per second. now is a callable returning seconds as float.
    take(n) returns True and removes n tokens when enough are available,
    otherwise returns False and removes nothing.
    """

    def __init__(self, capacity: int, refill_per_second: float, now):
        raise NotImplementedError

    def take(self, n: int) -> bool:
        raise NotImplementedError
