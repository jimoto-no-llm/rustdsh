def index_of(sorted_items, target):
    """Return the index of target in sorted_items, or -1 when absent."""
    low, high = 0, len(sorted_items) - 1
    while low < high:
        middle = (low + high) // 2
        if sorted_items[middle] < target:
            low = middle + 1
        else:
            high = middle
    if sorted_items and sorted_items[low] == target:
        return low
    return -1
