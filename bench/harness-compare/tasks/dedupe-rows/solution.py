def dedupe(rows):
    """Drop later rows whose first field matches an earlier row, case-insensitively.

    Rows are lists of strings. The first occurrence wins and keeps its original
    casing and remaining fields.
    """
    raise NotImplementedError
