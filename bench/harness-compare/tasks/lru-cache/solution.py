class LRUCache:
    """A fixed-capacity cache that evicts the least recently used key.

    get(key) returns the value or None and marks the key as recently used.
    put(key, value) inserts or updates and marks the key as recently used.
    """

    def __init__(self, capacity: int):
        raise NotImplementedError

    def get(self, key):
        raise NotImplementedError

    def put(self, key, value):
        raise NotImplementedError
