#!/usr/bin/env python3
"""Figmenta fork: unlock a keychain with the password read from a file, via the Security
framework — the password never appears in any process's argv (unlike
`security unlock-keychain -p`) and is never printed.

    figmenta-unlock-keychain.py <keychain-path> <password-file>
"""
import ctypes
import ctypes.util
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    keychain_path, password_file = sys.argv[1], sys.argv[2]
    with open(password_file, "rb") as handle:
        password = handle.read().rstrip(b"\r\n")
    security = ctypes.cdll.LoadLibrary(ctypes.util.find_library("Security"))
    keychain = ctypes.c_void_p()
    status = security.SecKeychainOpen(keychain_path.encode(), ctypes.byref(keychain))
    if status != 0:
        print(f"SecKeychainOpen failed: OSStatus {status}", file=sys.stderr)
        return 1
    security.SecKeychainUnlock.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_char_p,
        ctypes.c_bool,
    ]
    status = security.SecKeychainUnlock(keychain, len(password), password, True)
    if status != 0:
        print(f"SecKeychainUnlock failed: OSStatus {status}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
