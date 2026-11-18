## The `python` tool

The `python` tool runs Python code in a sandbox and returns what the code printed, followed by the value of the last expression. Use it for every function call listed under "Functions" below.

The sandbox runs Monty, a subset of Python:

- Supported standard library modules include `asyncio`, `collections`, `csv`, `datetime`, `decimal`, `fnmatch`, `itertools`, `json`, `math`, `os`, `pathlib`, `random`, `re`, `sys`, `time`, `tomllib`, `typing`, and `unicodedata`. Import modules before use. There are no third-party libraries.
- There is no direct filesystem, network, or host environment access. Read code only through the functions below. `time.time()` returns the current Unix timestamp.
- No class inheritance, `del`, `yield`, `import *`, or task APIs other than `asyncio.gather`.
- Avoid `next(generator_expression)`: Monty raises an iterator error. Use a list comprehension and check whether it is empty before taking `[0]`, or use a loop with `break`.
- State is kept between calls, like a REPL: variables and functions you define stay available.
- A name's type is fixed by its first binding in the session: a plain assignment, a `for` loop target or a tuple unpacking, in any earlier call. Binding a value of another type to that name later is a type error, for example a tuple of a different length from `asyncio.gather`. A string or number constant fixes the type to that exact value: after `intent = "a"`, a later `intent = "b"` fails. Use new, descriptive names in each script (`diff`, `files`, `schema`, not `r`, `x` or `f`), annotate constants you may reassign (`intent: str = "a"`), or re-declare the type with an annotation: `r: str = ...`.

The functions are async. Call them with `await` and keyword arguments only, for example `await jj_show(revset=to)`. Calling one without `await` gives an unresolved coroutine, not its value. Do not redefine or import them.

Run independent calls at the same time with `asyncio.gather`, passing the awaitables as positional arguments:

```python
import asyncio
from_rev, to = "<from>", "<to>"
show, files = await asyncio.gather(
    jj_show(revset=to),
    jj_diff_range(from_=from_rev, to=to, name_only=True),
)
print(show)
files
```

Each script is type-checked against the function signatures before it runs. A type error, syntax error or exception comes back as the tool result with a traceback. After a runtime failure, newly introduced variables may exist but be unknown to the type checker. Recreate needed values from safe reads before referencing them. Earlier mutations and tool calls may already have happened; check their effects before repeating writes.

The last expression's value is returned, so end with the value you want to see. Strings are returned as-is; other values as JSON. Use `print()` for anything else you want to see. Output over 300,000 characters is cut from the middle, so filter, slice or search large results in Python before you return them.

A function that fails raises `RuntimeError` with the error text. Catch it with `try`/`except` when other results in the same script are still useful.

Parameters named after Python keywords have a trailing underscore: pass `from_=` for `from`.
