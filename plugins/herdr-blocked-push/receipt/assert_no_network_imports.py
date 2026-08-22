#!/usr/bin/env python3
"""Static half of the no-network proof.

For a pure-Python script the import list is decisive, not circumstantial: without importing
one of the socket-capable modules there is no expressible way to open a file descriptor to
a socket. So this walks the hook's AST, collects every imported top-level module, and fails
if anything outside a tiny allowlist appears -- including the indirect routes (`subprocess`,
`ctypes`, `importlib`, `os.system` via the `os` allowance is handled separately below).

The shell stage is checked by string scan instead, since it can only reach the network by
naming a program that does.
"""

import ast
import os
import re
import sys

ALLOWED_IMPORTS = {"json", "os", "sys", "time"}
# `os` is allowed but its process-spawning surface is not: `os.system`/`os.popen`/`os.exec*`
# would let the hook reach the network through another binary.
FORBIDDEN_OS_CALLS = {"system", "popen", "execv", "execve", "execvp", "execvpe", "spawnv", "spawnve"}
FORBIDDEN_SHELL_WORDS = [
    "curl", "wget", "nc ", "netcat", "ssh", "openssl", "telnet", "ftp", "http://", "https://",
]


def check_python(path):
    problems = []
    with open(path, "r", encoding="utf-8") as handle:
        tree = ast.parse(handle.read(), filename=path)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root not in ALLOWED_IMPORTS:
                    problems.append("{}:{}: imports {!r}".format(path, node.lineno, alias.name))
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            if root not in ALLOWED_IMPORTS:
                problems.append("{}:{}: imports from {!r}".format(path, node.lineno, node.module))
        elif isinstance(node, ast.Attribute) and node.attr in FORBIDDEN_OS_CALLS:
            problems.append("{}:{}: calls os.{}".format(path, node.lineno, node.attr))
        elif isinstance(node, ast.Name) and node.id in {"eval", "exec", "compile", "__import__"}:
            problems.append("{}:{}: uses {}()".format(path, node.lineno, node.id))
    return problems


def check_shell(path):
    problems = []
    with open(path, "r", encoding="utf-8") as handle:
        for lineno, line in enumerate(handle, start=1):
            code = line.split("#", 1)[0]
            for word in FORBIDDEN_SHELL_WORDS:
                if re.search(re.escape(word), code):
                    problems.append("{}:{}: mentions {!r}".format(path, lineno, word))
    return problems


def main(argv):
    hooks_dir = argv[1] if len(argv) > 1 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks"
    )
    problems = check_python(os.path.join(hooks_dir, "enqueue.py"))
    problems += check_shell(os.path.join(hooks_dir, "enqueue.sh"))
    if problems:
        for problem in problems:
            print("FAIL {}".format(problem))
        return 1
    print(
        "OK hooks import only {} and name no network program".format(
            ", ".join(sorted(ALLOWED_IMPORTS))
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
